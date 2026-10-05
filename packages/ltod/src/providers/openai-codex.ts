/**
 * OpenAI Codex (ChatGPT subscription) provider adapter.
 *
 * Speaks the Responses wire directly against the subscription backend: the
 * request is POSTed to `{base}/codex/responses` — a dedicated path beneath the
 * backend root, not the plain `/responses` of the public API — and the reply is
 * read as server-sent events whose payloads are folded by the shared Responses
 * stream reader (`OpenAIResponsesStreamedMessage`).
 *
 * Credentials are structured and travel on the api-key channel as a JSON
 * string (`{ "token", "accountId" }`) — the sign-in module builds that string
 * in `toAuth`, so no extra plumbing is needed between the login store and this
 * adapter. The account id is a required part of the credential: the backend
 * routes requests by account, and a credential without one is reported with a
 * sign-in hint instead of being silently downgraded.
 *
 * The backend accepts only a narrowed request shape. Sampling controls and a
 * caller-supplied output cap are refused outright, `store`/`stream` are pinned,
 * and the encrypted reasoning payload is requested through `include`.
 * {@link sanitizeCodexRequestBody} is the single chokepoint enforcing that
 * shape for every request.
 */

import {
  APIConnectionError,
  ChatProviderError,
  normalizeAPIStatusError,
  readRetryAfterMsFromHeaders,
} from '#/errors';
import type { ModelCapability } from '#/capability';
import type { Message, StreamedMessagePart } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { TokenUsage } from '#/usage';
import type { Tool } from '#/tool';

import { getOpenAICodexModelCapability } from './capability-registry';
import {
  reasoningEffortToThinkingEffort,
  thinkingEffortToReasoningEffort,
  type ToolMessageConversion,
} from './openai-common';
import {
  OpenAIResponsesStreamedMessage,
  buildResponsesInput,
  convertTool,
} from './openai-responses';
import { mergeRequestHeaders, requireProviderApiKey } from './request-auth';

/** Backend root the subscription requests are sent to. */
export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
/** Streaming path beneath the backend root. */
const CODEX_RESPONSES_PATH = '/codex/responses';
/** Client identifier reported to the backend. */
const CODEX_ORIGINATOR = 'scream-code';
/** Ask the backend to ship the encrypted reasoning payload back for replay. */
const ENCRYPTED_REASONING_INCLUDE = 'reasoning.encrypted_content';
/**
 * Client version the backend gates model availability against, overridable per
 * install. It is a wire protocol value, not a product identity.
 */
const CODEX_CLIENT_VERSION_ENV = 'SCREAM_CODE_CODEX_CLIENT_VERSION';
const CODEX_DEFAULT_CLIENT_VERSION = '0.159.0';
/** Claim namespace that holds the workspace residency inside the access token. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
/** System prompt used when a caller supplies none (the field stays required). */
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

const PROVIDER_NAME = 'openai-codex';
const PROVIDER_LABEL = 'OpenAICodexChatProvider';

// Header names the backend reads. Fields of the reference header set that this
// adapter does not express are listed here so the gap stays visible:
// - `x-codex-beta-features` (opt-in wire protocols this client does not speak),
// - `x-codex-installation-id` (install identity, held by the hosting app, not
//   by the request layer),
// - `session-id` / `x-codex-window-id` / `x-codex-turn-metadata` /
//   `x-codex-parent-thread-id` (client-side session telemetry and continuation
//   state for a stateful native client),
// - `x-openai-subagent` (transport marker for delegated runs),
// - `x-openai-internal-codex-responses-lite` (Lite transport shape, not
//   implemented here),
// - `x-oai-attestation` (platform attestation envelope, unavailable).
const HEADER_ACCOUNT_ID = 'chatgpt-account-id';
const HEADER_ORIGINATOR = 'originator';
const HEADER_VERSION = 'version';
const HEADER_SESSION_ID = 'session_id';
const HEADER_CONVERSATION_ID = 'conversation_id';
const HEADER_CLIENT_REQUEST_ID = 'x-client-request-id';
const HEADER_ROUTING_HINT = 'x-codex-routing-hint';
const HEADER_RESIDENCY = 'x-openai-internal-codex-residency';
const HEADER_BETA = 'OpenAI-Beta';
const BETA_RESPONSES = 'responses=experimental';

/**
 * Request fields the subscription backend refuses outright: sampling controls
 * and caller-supplied output caps come back as `Unsupported parameter: ...`,
 * so they are dropped instead of forwarded.
 */
const CODEX_REJECTED_BODY_FIELDS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'stop',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'seed',
  'n',
  'max_output_tokens',
  'max_completion_tokens',
] as const;

/** Minimal `fetch` surface, injectable so tests never touch the network. */
export type OpenAICodexFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAICodexOptions {
  /**
   * Structured credential JSON (`{ token, accountId }`). Written by the sign-in
   * `toAuth` and threaded through the request-auth channel; a non-JSON value or
   * a missing field is rejected at request time with a `/login` hint.
   */
  apiKey?: string | undefined;
  /** Backend root override (proxy, gateway, or a pinned host). */
  baseUrl?: string | undefined;
  model: string;
  /** Extra request headers; per-request `auth.headers` take precedence. */
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  /** Transport override; defaults to the global `fetch`. */
  fetch?: OpenAICodexFetch | undefined;
  /**
   * Conversation id sent as the session / prompt-cache key. Generated per
   * provider instance when omitted; thinking clones keep sharing it.
   */
  sessionId?: string | undefined;
}

/** Parsed subscription credential. */
export interface OpenAICodexCredentials {
  readonly token: string;
  readonly accountId: string;
}

// ── Credentials ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function invalidCredentialsMessage(): string {
  return (
    `${PROVIDER_LABEL}: credentials must be a JSON object ({ "token", "accountId" }). ` +
    'This provider is provisioned by /login — sign in again to obtain credentials.'
  );
}

function missingCredentialsMessage(): string {
  return (
    `${PROVIDER_LABEL}: Codex credentials are missing token or accountId. ` +
    'Sign in again with /login for this provider.'
  );
}

/**
 * Parse the structured credential carried on the api-key channel.
 *
 * Alternate spellings (`access_token`/`access` for the token, `account_id` for
 * the account) are accepted so a hand-written entry keeps working; a primary
 * field that is present but empty is reported rather than silently replaced.
 */
export function parseOpenAICodexCredentials(raw: string): OpenAICodexCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatProviderError(invalidCredentialsMessage());
  }
  if (!isRecord(parsed)) {
    throw new ChatProviderError(invalidCredentialsMessage());
  }

  const token =
    readString(parsed['token']) ??
    readString(parsed['access_token']) ??
    readString(parsed['access']);
  const accountId = readString(parsed['accountId']) ?? readString(parsed['account_id']);
  if (token === undefined || token.length === 0) {
    throw new ChatProviderError(missingCredentialsMessage());
  }
  if (accountId === undefined || accountId.length === 0) {
    throw new ChatProviderError(missingCredentialsMessage());
  }

  return { token, accountId };
}

// ── Endpoint ───────────────────────────────────────────────────────────────

/**
 * Resolve the streaming endpoint from a configured base URL. A value already
 * naming the streaming path (or only the `/codex` segment) is completed rather
 * than concatenated, so entries written by earlier sign-ins keep working.
 */
export function resolveCodexEndpoint(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ?? '';
  const normalized = (raw.length > 0 ? raw : CODEX_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (normalized.endsWith(CODEX_RESPONSES_PATH)) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}${CODEX_RESPONSES_PATH}`;
}

/** Decode a JWT payload; tokens that are not three-part JWTs yield nothing. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Workspace residency the account is pinned to, when the token declares one.
 * A region-pinned workspace rejects an egress from another region unless the
 * request states the residency it belongs to; unpinned accounts carry no claim
 * and need no header.
 */
function readWorkspaceResidency(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.[JWT_CLAIM_PATH];
  if (!isRecord(auth)) return undefined;
  for (const claim of [auth['chatgpt_data_residency'], auth['chatgpt_compute_residency']]) {
    const residency = typeof claim === 'string' ? claim.trim() : '';
    if (residency.length > 0) return residency;
  }
  return undefined;
}

function getClientVersion(): string {
  return (
    readNonEmptyString(process.env[CODEX_CLIENT_VERSION_ENV]) ?? CODEX_DEFAULT_CLIENT_VERSION
  );
}

/**
 * User agent identifying this client and the runtime it runs on. It is built
 * from this adapter's own originator name, never from another product's.
 */
function getCodexUserAgent(): string {
  return `${CODEX_ORIGINATOR} (${process.platform}; ${process.arch})`;
}

// ── Headers ────────────────────────────────────────────────────────────────

export function buildCodexHeaders(params: {
  token: string;
  accountId: string;
  model: string;
  sessionId: string;
  extraHeaders?: Record<string, string> | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
    'User-Agent': getCodexUserAgent(),
    [HEADER_ACCOUNT_ID]: params.accountId,
    [HEADER_ORIGINATOR]: CODEX_ORIGINATOR,
    [HEADER_VERSION]: getClientVersion(),
    [HEADER_SESSION_ID]: params.sessionId,
    [HEADER_CONVERSATION_ID]: params.sessionId,
    [HEADER_CLIENT_REQUEST_ID]: params.sessionId,
    [HEADER_ROUTING_HINT]: `model=${params.model}`,
    [HEADER_BETA]: BETA_RESPONSES,
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };

  const residency = readWorkspaceResidency(params.token);
  if (residency !== undefined) {
    headers[HEADER_RESIDENCY] = residency;
  }

  return mergeRequestHeaders(headers, params.extraHeaders) ?? headers;
}

// ── Request body ───────────────────────────────────────────────────────────

export interface CodexRequestBodyOptions {
  model: string;
  systemPrompt: string | string[];
  tools: Tool[];
  history: Message[];
  /** Conversation id, also used as the prompt-cache key. */
  sessionId: string;
  reasoningEffort?: string | undefined;
  toolMessageConversion?: ToolMessageConversion | undefined;
}

/**
 * Enforce the request shape the subscription backend accepts: pin
 * `store`/`stream`, always ask for the encrypted reasoning payload, keep tool
 * calling declared and automatic, and drop every unsupported parameter.
 * Exported as the single place the wire invariants are applied.
 */
export function sanitizeCodexRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  body['store'] = false;
  body['stream'] = true;

  const include = Array.isArray(body['include'])
    ? body['include'].filter((value): value is string => typeof value === 'string')
    : [];
  if (!include.includes(ENCRYPTED_REASONING_INCLUDE)) {
    include.push(ENCRYPTED_REASONING_INCLUDE);
  }
  body['include'] = include;

  // Tool parameters are only accepted alongside tool declarations: on a
  // tool-free request the backend rejects them as an unsupported parameter, so
  // both are pinned when tools are declared and dropped when none are.
  // An object tool choice would force a specific declaration; only the explicit
  // string constraints are forwarded, everything else runs automatically.
  const declaresTools = Array.isArray(body['tools']) && body['tools'].length > 0;
  if (declaresTools) {
    const toolChoice = body['tool_choice'];
    if (toolChoice !== 'none' && toolChoice !== 'required') {
      body['tool_choice'] = 'auto';
    }
    body['parallel_tool_calls'] = true;
  } else {
    delete body['tool_choice'];
    delete body['parallel_tool_calls'];
  }

  for (const field of CODEX_REJECTED_BODY_FIELDS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete body[field];
  }
  return body;
}

export function buildCodexRequestBody(
  options: CodexRequestBodyOptions,
): Record<string, unknown> {
  const systemText =
    typeof options.systemPrompt === 'string'
      ? options.systemPrompt
      : options.systemPrompt.join('\n\n');

  const body: Record<string, unknown> = {
    model: options.model,
    // The backend takes the system prompt as the top-level instruction string
    // rather than as an input message, so the shared input builder runs without
    // the system item.
    instructions: systemText.trim().length > 0 ? systemText : DEFAULT_INSTRUCTIONS,
    input: buildResponsesInput({
      systemPrompt: options.systemPrompt,
      history: options.history,
      model: options.model,
      toolMessageConversion: options.toolMessageConversion ?? null,
      includeSystemPrompt: false,
    }),
    prompt_cache_key: options.sessionId,
    ...(options.reasoningEffort !== undefined
      ? { reasoning: { effort: options.reasoningEffort, summary: 'auto' } }
      : {}),
  };

  if (options.tools.length > 0) {
    body['tools'] = options.tools.map((tool) => convertTool(tool));
  }

  return sanitizeCodexRequestBody(body);
}

// ── SSE transport ──────────────────────────────────────────────────────────

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Map a transport-level failure onto the ltod error taxonomy. */
function convertTransportError(error: unknown): ChatProviderError {
  if (error instanceof ChatProviderError) return error;
  if (error instanceof Error) {
    const message = error.message;
    if (/timed?\s*out|timeout|deadline/i.test(message)) {
      return new APIConnectionError(`OpenAI Codex request timed out: ${message}`);
    }
    if (error instanceof TypeError) {
      return new APIConnectionError(`OpenAI Codex transport error: ${message}`);
    }
    return new ChatProviderError(`OpenAI Codex error: ${message}`);
  }
  return new ChatProviderError(`OpenAI Codex error: ${String(error)}`);
}

/**
 * Read the response body as a stream of Responses API payloads. A read that
 * fails because the caller aborted ends the iteration quietly — the request
 * wrapper reports the cancellation once the loop unwinds, which keeps it out of
 * the provider-error channel.
 */
async function* readCodexSseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminalEvent = false;
  try {
    for (;;) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const chunk = await reader.read();
        done = chunk.done;
        value = chunk.value;
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) return;
        throw error;
      }
      if (done) break;
      if (value === undefined) continue;
      buffer += decoder.decode(value, { stream: true });
      let boundary = SSE_EVENT_BOUNDARY.exec(buffer);
      while (boundary !== null) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const payload = parseCodexSseEvent(rawEvent);
        if (payload !== undefined) {
          if (isCodexTerminalEvent(payload)) sawTerminalEvent = true;
          yield payload;
        }
        boundary = SSE_EVENT_BOUNDARY.exec(buffer);
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) {
      const payload = parseCodexSseEvent(tail);
      if (payload !== undefined) {
        if (isCodexTerminalEvent(payload)) sawTerminalEvent = true;
        yield payload;
      }
    }
    // The body closing without a terminal event means the response was cut
    // short: anything already yielded is half an answer, not a finished one,
    // and the caller must be able to retry instead of consuming it as complete.
    if (!sawTerminalEvent) {
      // A cancel that lands while the body is closing is a cancellation, not a
      // truncated stream: reporting it as retryable would queue a retry that is
      // bound to abort again. The caller reports the cancellation once the
      // iteration unwinds.
      if (signal?.aborted === true) return;
      throw new APIConnectionError(
        'OpenAI Codex stream ended before a terminal completion event (connection dropped or response truncated).',
      );
    }
  } finally {
    // Releases the body when the consumer stops early (abort, error) so the
    // underlying connection is not left draining in the background.
    await reader.cancel().catch(() => {});
  }
}

/**
 * SSE frame separator. The scan runs over the assembled buffer, so a frame
 * boundary is recognized even when a chunk boundary falls between the `\r` and
 * the `\n` of one of its line endings.
 */
const SSE_EVENT_BOUNDARY = /\r?\n\r?\n/;

/**
 * Events that close a turn as a model answer. The backend always ends a
 * response with one of them; `error` and `response.failed` end it by failing
 * the request instead, which the payload reader turns into an error.
 */
const CODEX_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
]);

function isCodexTerminalEvent(payload: Record<string, unknown>): boolean {
  const type = payload['type'];
  return typeof type === 'string' && CODEX_TERMINAL_EVENT_TYPES.has(type);
}

function parseCodexSseEvent(rawEvent: string): Record<string, unknown> | undefined {
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice('data:'.length);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join('\n').trim();
  if (data.length === 0 || data === '[DONE]') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ChatProviderError(
      `OpenAI Codex API returned a malformed stream event: ${data.slice(0, 200)}`,
    );
  }
  return isRecord(parsed) ? parsed : undefined;
}

// ── Streamed message ───────────────────────────────────────────────────────

interface CodexStreamRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
  readonly fetchImpl: OpenAICodexFetch;
}

/**
 * One Codex request. The transport is started when the stream is consumed, and
 * the payloads are folded by the shared Responses stream reader, whose decoded
 * id / usage / finish reason this wrapper surfaces.
 */
export class OpenAICodexStreamedMessage implements StreamedMessage {
  private _inner: OpenAIResponsesStreamedMessage | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(request: CodexStreamRequest) {
    this._iter = this._streamParts(request);
  }

  get id(): string | null {
    return this._inner?.id ?? null;
  }

  get model(): string | null {
    return this._inner?.model ?? null;
  }

  get usage(): TokenUsage | null {
    return this._inner?.usage ?? null;
  }

  get finishReason(): FinishReason | null {
    return this._inner?.finishReason ?? null;
  }

  get rawFinishReason(): string | null {
    return this._inner?.rawFinishReason ?? null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private async *_streamParts(
    request: CodexStreamRequest,
  ): AsyncGenerator<StreamedMessagePart> {
    this._throwIfAborted(request.signal);
    let response: Response;
    try {
      response = await request.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted === true) throw createAbortError();
      throw convertTransportError(error);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw normalizeAPIStatusError(
        response.status,
        `OpenAI Codex API error (${response.status}): ${errorText}`,
        null,
        readRetryAfterMsFromHeaders((name) => response.headers.get(name)),
      );
    }
    if (response.body === null) {
      throw new APIConnectionError('OpenAI Codex API returned a response without a body.');
    }

    const inner = new OpenAIResponsesStreamedMessage(
      readCodexSseEvents(response.body, request.signal),
      true,
    );
    this._inner = inner;
    for await (const part of inner) {
      this._throwIfAborted(request.signal);
      yield part;
    }
    // A cancelled request ends the reader quietly; report it as cancellation
    // rather than as a completed turn.
    this._throwIfAborted(request.signal);
  }
}

// ── Provider ───────────────────────────────────────────────────────────────

export class OpenAICodexChatProvider implements ChatProvider {
  readonly name: string = PROVIDER_NAME;

  private _model: string;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _toolMessageConversion: ToolMessageConversion;
  private _fetch: OpenAICodexFetch;
  private _reasoningEffort: string | undefined;
  /** Session id shared by every clone: one conversation, one cache key. */
  private _sessionId: string;

  constructor(options: OpenAICodexOptions) {
    this._model = options.model;
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this._sessionId = options.sessionId ?? crypto.randomUUID();
    this._reasoningEffort = undefined;
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return reasoningEffortToThinkingEffort(this._reasoningEffort);
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl ?? CODEX_DEFAULT_BASE_URL,
      ...(this._reasoningEffort !== undefined
        ? { reasoning_effort: this._reasoningEffort }
        : {}),
    };
  }

  getCapability(model?: string): ModelCapability {
    return getOpenAICodexModelCapability(model ?? this._model);
  }

  async generate(
    systemPrompt: string | string[],
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    if (options?.signal?.aborted === true) {
      throw createAbortError();
    }

    const credentials = parseOpenAICodexCredentials(
      requireProviderApiKey(PROVIDER_LABEL, options?.auth, this._apiKey),
    );
    // An explicitly configured backend root (config or env, handed in through
    // the constructor) wins over the value carried by the request auth: the
    // sign-in always reports its default endpoint there, which would otherwise
    // shadow a proxy/mirror the user configured. The wire default is the last
    // resort, applied inside the resolver.
    const url = resolveCodexEndpoint(this._baseUrl ?? options?.auth?.baseUrl);
    const body = buildCodexRequestBody({
      model: this._model,
      systemPrompt,
      tools,
      history,
      sessionId: this._sessionId,
      reasoningEffort: this._reasoningEffort,
      toolMessageConversion: this._toolMessageConversion,
    });

    return new OpenAICodexStreamedMessage({
      url,
      headers: buildCodexHeaders({
        token: credentials.token,
        accountId: credentials.accountId,
        model: this._model,
        sessionId: this._sessionId,
        extraHeaders: mergeRequestHeaders(this._defaultHeaders, options?.auth?.headers),
      }),
      body: JSON.stringify(body),
      signal: options?.signal,
      fetchImpl: this._fetch,
    });
  }

  withThinking(effort: ThinkingEffort): OpenAICodexChatProvider {
    const clone = this._clone();
    clone._reasoningEffort = thinkingEffortToReasoningEffort(effort);
    return clone;
  }

  private _clone(): OpenAICodexChatProvider {
    // Shares `_sessionId` with the original on purpose: thinking clones keep
    // reporting into the same conversation.
    return Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAICodexChatProvider,
      this,
    );
  }
}
