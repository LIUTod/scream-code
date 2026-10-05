/**
 * Google Cloud Code Assist (CCA) provider adapter.
 *
 * Talks to the Cloud Code Assist streaming endpoint that the two Google
 * sign-ins (`/login` → Antigravity / Gemini CLI) are provisioned for:
 * `POST {endpoint}/v1internal:streamGenerateContent?alt=sse`, wrapped in the
 * `{ project, model, request }` envelope, with responses arriving as
 * server-sent events whose `data:` payloads carry `{ response: ... }`.
 *
 * Credentials are structured and travel on the api-key channel as a JSON
 * string (`{ "token", "projectId", "endpoint?" }`) — the sign-in modules build
 * that string in `toAuth`, so no extra plumbing is needed between the login
 * store and this adapter.
 *
 * The two sign-ins differ only in host policy, user agent, and how much
 * envelope metadata the backend expects:
 * - `gemini-cli`: the default `cloudcode-pa` host, a `GeminiCLI/...` user
 *   agent plus `Client-Metadata`, and the bare `{ project, model, request }`
 *   envelope.
 * - `antigravity`: the `daily-cloudcode-pa` host with a sandbox failover, an
 *   `antigravity/hub/...` user agent, and the session envelope
 *   (`requestId`, `userAgent`, `requestType`, `request.sessionId`,
 *   `request.labels`).
 *
 * The variant is passed explicitly by the host, or inferred from the resolved
 * endpoint host (see {@link inferGoogleCloudCodeVariant}) because both
 * sign-ins write the same provider `type` and differ only by `baseUrl`.
 */

import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
  readRetryAfterMsFromHeaders,
} from '#/errors';
import type { ModelCapability } from '#/capability';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';

import { getGoogleCloudCodeModelCapability } from './capability-registry';
import { mergeRequestHeaders, requireProviderApiKey } from './request-auth';

/** Default Cloud Code Assist host, used when the credential names no endpoint. */
export const CLOUD_CODE_ASSIST_DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
/** Production host for the Antigravity sign-in. */
export const CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT =
  'https://daily-cloudcode-pa.googleapis.com';
/** Sandbox host, used as the failover target when the daily host is unavailable. */
export const CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT =
  'https://daily-cloudcode-pa.sandbox.googleapis.com';

const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT,
  CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT,
] as const;

/** Host prefix that identifies the Antigravity Cloud Code Assist surface. */
const ANTIGRAVITY_HOST_PREFIX = 'daily-cloudcode-pa';

/** Streaming method on the Cloud Code Assist host. */
const STREAM_METHOD = 'v1internal:streamGenerateContent?alt=sse';

const PROVIDER_NAME = 'google_cloud_code';
const PROVIDER_LABEL = 'GoogleCloudCodeChatProvider';

/** Client version / identity reported to the backend, overridable per install. */
const GEMINI_CLI_VERSION_ENV = 'SCREAM_CODE_GEMINI_CLI_VERSION';
const GEMINI_CLI_DEFAULT_VERSION = '0.46.0';
const GEMINI_CLI_DEFAULT_MODEL_ID = 'gemini-3.1-pro-preview';
const GEMINI_CLI_CLIENT_METADATA =
  'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI';

const ANTIGRAVITY_VERSION_ENV = 'SCREAM_CODE_ANTIGRAVITY_VERSION';
const ANTIGRAVITY_DEFAULT_VERSION = '2.19.1';
const ANTIGRAVITY_OS_ENV = 'SCREAM_CODE_ANTIGRAVITY_OS';
const ANTIGRAVITY_ARCH_ENV = 'SCREAM_CODE_ANTIGRAVITY_ARCH';
const ANTIGRAVITY_CL_ENV = 'SCREAM_CODE_ANTIGRAVITY_CL';
/** Client identity pinned to the build the Cloud Code Assist backend expects. */
const ANTIGRAVITY_DEFAULT_OS = 'darwin';
const ANTIGRAVITY_DEFAULT_ARCH = 'arm64';
const ANTIGRAVITY_DEFAULT_CHANGELIST = '963137146';
/** Envelope markers the Antigravity backend reads off each agent request. */
const ANTIGRAVITY_REQUEST_TYPE = 'agent';
const ANTIGRAVITY_USER_AGENT_TAG = 'antigravity';
/** Cloud Code Assist tool mode: the backend validates calls against the declarations. */
const TOOL_MODE_VALIDATED = 'VALIDATED';

/**
 * Bypass value both Cloud Code Assist hosts accept in place of a thought
 * signature. A revision >= 3 `gemini` model is rejected when the *first*
 * function call of a turn is unsigned; secondary unsigned calls are accepted.
 */
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/** Beta announcing interleaved thinking to the Claude models behind Antigravity. */
const CLAUDE_THINKING_BETA_HEADER = 'interleaved-thinking-2025-05-14';

/** Which of the two Cloud Code Assist sign-ins this request is for. */
export type GoogleCloudCodeVariant = 'gemini-cli' | 'antigravity';

/** Minimal `fetch` surface, injectable so tests never touch the network. */
export type GoogleCloudCodeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleCloudCodeOptions {
  /**
   * Structured credential JSON (`{ token, projectId, endpoint? }`). Written by
   * the sign-in `toAuth` and threaded through the request-auth channel; a
   * non-JSON value is rejected at request time with a `/login` hint.
   */
  apiKey?: string | undefined;
  model: string;
  /** Endpoint override (proxy or a pinned Cloud Code Assist host). */
  baseUrl?: string | undefined;
  /** Cloud Code Assist surface; inferred from the endpoint host when omitted. */
  variant?: GoogleCloudCodeVariant | undefined;
  /** Transport override; defaults to the global `fetch`. */
  fetch?: GoogleCloudCodeFetch | undefined;
}

/** Parsed Cloud Code Assist credential. */
export interface GoogleCloudCodeCredentials {
  readonly token: string;
  readonly projectId: string;
  /** Endpoint carried with the credential; wins over the configured base URL. */
  readonly endpoint?: string;
  readonly email?: string;
}

interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  thinkingBudget?: number;
}

/**
 * Per-conversation state the adapter remembers between requests of the same
 * provider instance: the last endpoint that worked, the response id the next
 * Antigravity request echoes back, and the envelope identity the backend
 * groups a trajectory by.
 */
export interface CloudCodeAssistSessionState {
  lastGoodEndpoint?: string;
  lastResponseId?: string;
  agentId?: string;
  trajectoryId?: string;
  sessionId?: string;
  stepIndex?: number;
}

// ── Wire types ─────────────────────────────────────────────────────────────

interface CloudCodePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType: string };
}

interface CloudCodeContent {
  role: 'user' | 'model';
  parts: CloudCodePart[];
}

interface CloudCodeAssistInnerRequest {
  contents: CloudCodeContent[];
  systemInstruction?: { role?: string; parts: { text: string }[] };
  generationConfig?: { thinkingConfig?: ThinkingConfig };
  tools?: { functionDeclarations: Record<string, unknown>[] }[];
  toolConfig?: { functionCallingConfig: { mode: string } };
  sessionId?: string;
  labels?: Record<string, string>;
}

interface CloudCodeAssistRequestBody {
  project: string;
  model: string;
  request: CloudCodeAssistInnerRequest;
  requestType?: string;
  userAgent?: string;
  requestId?: string;
}

interface CloudCodeAssistResponsePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
}

interface CloudCodeAssistResponseChunk {
  response?: {
    candidates?: {
      content?: { parts?: CloudCodeAssistResponsePart[] };
      finishReason?: string;
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    };
    modelVersion?: string;
    responseId?: string;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  /** In-band stream failure (quota, internal error) delivered as a final event. */
  error?: { code?: number; message?: string; status?: string };
}

// ── Credentials ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The value when it is a string at all — an empty string counts as present. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function invalidCredentialsMessage(): string {
  return (
    `${PROVIDER_LABEL}: credentials must be a JSON object ({ "token", "projectId" }). ` +
    'This provider is provisioned by /login — sign in again to obtain credentials.'
  );
}

function missingCredentialsMessage(): string {
  return (
    `${PROVIDER_LABEL}: Cloud Code Assist credentials are missing token or projectId. ` +
    'Sign in again with /login for this provider.'
  );
}

/**
 * Parse the structured credential carried on the api-key channel.
 *
 * Accepts `project_id` as an alias of `projectId` so a hand-written entry keeps
 * working; the primary field wins even when it is empty, which surfaces a
 * mistyped credential instead of silently falling back.
 */
export function parseGoogleCloudCodeCredentials(raw: string): GoogleCloudCodeCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatProviderError(invalidCredentialsMessage());
  }
  if (!isRecord(parsed)) {
    throw new ChatProviderError(invalidCredentialsMessage());
  }

  const token = readNonEmptyString(parsed['token']);
  // The alias is only consulted when the primary field is absent or not a
  // string; a present-but-empty primary field is reported instead of replaced.
  const projectId = readString(parsed['projectId']) ?? readString(parsed['project_id']);
  if (token === undefined || projectId === undefined || projectId.length === 0) {
    throw new ChatProviderError(missingCredentialsMessage());
  }

  const endpoint = normalizeEndpoint(readNonEmptyString(parsed['endpoint']));
  const email = readNonEmptyString(parsed['email']);
  return {
    token,
    projectId,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

/** Strip trailing slashes so endpoint concatenation stays predictable. */
function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the Cloud Code Assist surface for an endpoint. Both sign-ins write
 * the same provider `type`, so the host is what tells them apart: the
 * Antigravity sign-in targets the `daily-cloudcode-pa` hosts, the Gemini CLI
 * sign-in the default `cloudcode-pa` host.
 */
export function inferGoogleCloudCodeVariant(
  endpoint: string | undefined,
): GoogleCloudCodeVariant {
  if (endpoint === undefined) return 'gemini-cli';
  try {
    return new URL(endpoint).hostname.startsWith(ANTIGRAVITY_HOST_PREFIX)
      ? 'antigravity'
      : 'gemini-cli';
  } catch {
    return 'gemini-cli';
  }
}

// ── Headers ────────────────────────────────────────────────────────────────

function getAntigravityUserAgent(): string {
  const version = readNonEmptyString(process.env[ANTIGRAVITY_VERSION_ENV]) ?? ANTIGRAVITY_DEFAULT_VERSION;
  const os = readNonEmptyString(process.env[ANTIGRAVITY_OS_ENV]) ?? ANTIGRAVITY_DEFAULT_OS;
  const arch = readNonEmptyString(process.env[ANTIGRAVITY_ARCH_ENV]) ?? ANTIGRAVITY_DEFAULT_ARCH;
  const cl = readNonEmptyString(process.env[ANTIGRAVITY_CL_ENV]) ?? ANTIGRAVITY_DEFAULT_CHANGELIST;
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

function getGeminiCliUserAgent(modelId: string): string {
  const version = readNonEmptyString(process.env[GEMINI_CLI_VERSION_ENV]) ?? GEMINI_CLI_DEFAULT_VERSION;
  const model = modelId.length > 0 ? modelId : GEMINI_CLI_DEFAULT_MODEL_ID;
  return `GeminiCLI/${version}/${model} (${process.platform}; ${process.arch}; terminal)`;
}

function buildRequestHeaders(
  variant: GoogleCloudCodeVariant,
  credentials: GoogleCloudCodeCredentials,
  model: string,
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const identity: Record<string, string> =
    variant === 'antigravity'
      ? { 'User-Agent': getAntigravityUserAgent() }
      : {
          'User-Agent': getGeminiCliUserAgent(model),
          'Client-Metadata': GEMINI_CLI_CLIENT_METADATA,
        };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...identity,
    // Claude behind the Antigravity host streams interleaved thinking only when
    // the beta is announced. The plain Cloud Code Assist host does not offer
    // it, and the other model families behind Antigravity are not covered.
    ...(variant === 'antigravity' && isClaudeModel(model)
      ? { 'anthropic-beta': CLAUDE_THINKING_BETA_HEADER }
      : {}),
  };
  return mergeRequestHeaders(headers, extraHeaders) ?? headers;
}

// ── Tool schema ────────────────────────────────────────────────────────────

/**
 * JSON Schema keywords the Cloud Code Assist schema proto has no field for.
 * They are stripped from tool declarations because the endpoint rejects
 * unknown fields outright rather than ignoring them.
 */
const UNSUPPORTED_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  '$schema',
  '$ref',
  '$defs',
  '$dynamicRef',
  '$dynamicAnchor',
  'examples',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'x-mcp-header',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
]);

/** Recursively drop unsupported keywords, keeping the rest of the schema intact. */
export function sanitizeSchemaForCloudCode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchemaForCloudCode(item));
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;
    out[key] = sanitizeSchemaForCloudCode(child);
  }
  return out;
}

/**
 * Whether tool declarations travel in the legacy `parameters` field, which the
 * backend translates (Anthropic models behind either host receive it as their
 * `input_schema`). Both hosts declare the legacy field for the whole
 * Antigravity surface and for every Claude model on either host; the plain
 * Cloud Code Assist host takes a full JSON schema for the other families.
 */
function usesLegacyParametersSchema(variant: GoogleCloudCodeVariant, model: string): boolean {
  return variant === 'antigravity' || isClaudeModel(model);
}

function toolToFunctionDeclaration(
  tool: Tool,
  variant: GoogleCloudCodeVariant,
  model: string,
): Record<string, unknown> {
  const schema = sanitizeSchemaForCloudCode(tool.parameters);
  const base = { name: tool.name, description: tool.description || '' };
  return usesLegacyParametersSchema(variant, model)
    ? { ...base, parameters: schema }
    : { ...base, parametersJsonSchema: schema };
}

// ── History conversion ─────────────────────────────────────────────────────

function convertMediaUrl(
  url: string,
  fallbackMimeType: string,
): { inlineData: { mimeType: string; data: string } } | { fileData: { fileUri: string; mimeType: string } } {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex !== -1) {
      const meta = url.slice(0, commaIndex);
      const data = url.slice(commaIndex + 1);
      const colonIndex = meta.indexOf(':');
      const semiIndex = meta.indexOf(';');
      const mimeType =
        colonIndex !== -1 && semiIndex !== -1 ? meta.slice(colonIndex + 1, semiIndex) : fallbackMimeType;
      return { inlineData: { mimeType, data } };
    }
  }
  return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
}

function mediaPartToCloudCode(part: ContentPart): CloudCodePart | undefined {
  switch (part.type) {
    case 'image_url':
      return convertMediaUrl(part.imageUrl.url, 'image/jpeg');
    case 'audio_url':
      return convertMediaUrl(part.audioUrl.url, 'audio/mpeg');
    case 'video_url':
      return convertMediaUrl(part.videoUrl.url, 'video/mp4');
    case 'text':
    case 'think':
      // Text and reasoning are converted by the caller; they carry no media.
      return undefined;
  }
}

/** Resolve the tool name a `toolCallId` belongs to, falling back to the id shape. */
function toolCallIdToName(toolCallId: string, toolNameById: Map<string, string>): string {
  const name = toolNameById.get(toolCallId);
  if (name !== undefined) return name;
  // Ids produced by this provider are `"{tool_name}_{uuid}"`; tool names may
  // themselves contain underscores, so only the trailing segment is dropped.
  const match = /^(.+)_[^_]+$/.exec(toolCallId);
  return match?.[1] ?? toolCallId;
}

function parseToolArguments(argumentsJson: string | null): Record<string, unknown> {
  if (argumentsJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether the host applies its signed-first-function-call contract to this
 * model. The hosts declare the contract as the `gemini` class at revision
 * >= 3, and no revision metadata reaches the request layer, so the model id is
 * the only signal available: a `gemini-3*` id approximates that class and
 * revision, while the older generation ids and the other families served on
 * this host (Claude, Mistral) are outside the contract.
 */
function requiresSkipThoughtSignatureOnFirstToolCall(model: string): boolean {
  return model.toLowerCase().startsWith('gemini-3');
}

/**
 * Replay one assistant turn, including the thought-signature contract. Only the
 * first function call of the turn is healed with the bypass sentinel when it
 * carries no signature of its own: a signed first call keeps its signature and
 * the unsigned parallel calls after it stay bare, which the hosts accept.
 */
/**
 * Signatures travel as base64 bytes (the wire type is bytes). A value that is
 * not base64 cannot be a signature these hosts issued — a truncated or
 * rewritten history entry, or one from another transport — and replaying it
 * fails the request, so it is treated as absent: the first-call rule then
 * decides between the bypass sentinel and leaving the call bare.
 */
const THOUGHT_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
  if (signature === undefined || signature.length === 0) return false;
  if (signature.length % 4 !== 0) return false;
  return THOUGHT_SIGNATURE_PATTERN.test(signature);
}

function assistantMessageToParts(
  message: Message,
  model: string,
  variant: GoogleCloudCodeVariant,
): CloudCodePart[] {
  const parts: CloudCodePart[] = [];
  // Claude behind the Antigravity host refuses a reasoning block without a
  // signature, so an unsigned one is dropped from the replay instead of being
  // sent. The other combinations on these hosts accept an unsigned block.
  const dropsUnsignedThinking = variant === 'antigravity' && isClaudeModel(model);
  for (const part of message.content) {
    if (part.type === 'text') {
      if (part.text.trim().length === 0) continue;
      parts.push({ text: part.text });
    } else if (part.type === 'think') {
      if (part.think.trim().length === 0) continue;
      // An internal think part carries no producer metadata, so only the
      // signature's own form can be checked here; a malformed one counts as no
      // signature at all, which is what the drop rule below decides on.
      const signature = isValidThoughtSignature(part.encrypted) ? part.encrypted : undefined;
      if (dropsUnsignedThinking && signature === undefined) continue;
      parts.push({
        thought: true,
        text: part.think,
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      });
    }
  }
  let isFirstToolCall = true;
  for (const toolCall of message.toolCalls) {
    const captured = readNonEmptyString(toolCall.extras?.['thought_signature_b64']);
    const capturedModel = readNonEmptyString(toolCall.extras?.['thought_signature_model']);
    // A signature is only replayable to the model that issued it. History
    // written before the producer was recorded carries no model and is kept
    // for compatibility; a known mismatch drops the signature.
    const sameModel = capturedModel === undefined || capturedModel === model;
    const signature = sameModel && isValidThoughtSignature(captured) ? captured : undefined;
    const requiresSentinel =
      signature === undefined &&
      isFirstToolCall &&
      requiresSkipThoughtSignatureOnFirstToolCall(model);
    isFirstToolCall = false;
    const effectiveSignature = signature ?? (requiresSentinel ? SKIP_THOUGHT_SIGNATURE : undefined);
    parts.push({
      functionCall: {
        name: toolCall.name,
        args: parseToolArguments(toolCall.arguments),
      },
      ...(effectiveSignature !== undefined ? { thoughtSignature: effectiveSignature } : {}),
    });
  }
  return parts;
}

function toolMessageToParts(
  message: Message,
  toolNameById: Map<string, string>,
): CloudCodePart[] {
  if (message.toolCallId === undefined) {
    throw new ChatProviderError('Tool result is missing `toolCallId`.');
  }
  let text = '';
  const media: CloudCodePart[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      text += part.text;
      continue;
    }
    const mediaPart = mediaPartToCloudCode(part);
    if (mediaPart !== undefined) media.push(mediaPart);
  }
  return [
    {
      functionResponse: {
        name: toolCallIdToName(message.toolCallId, toolNameById),
        response: { output: text },
      },
    },
    ...media,
  ];
}

/**
 * Convert the internal history into Cloud Code Assist contents.
 *
 * Two rules the backend is strict about: every tool result that answers an
 * assistant turn must live in a single user turn, and roles alternate between
 * `user` and `model`.
 */
export function messagesToCloudCodeContents(
  messages: Message[],
  model: string,
  variant: GoogleCloudCodeVariant,
): CloudCodeContent[] {
  const contents: CloudCodeContent[] = [];
  const toolNameById = new Map<string, string>();

  const appendFunctionResponses = (parts: CloudCodePart[]): void => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last?.role === 'user' && last.parts.some((part) => part.functionResponse !== undefined)) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role: 'user', parts });
  };

  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message === undefined) break;

    if (message.role === 'system') {
      // Only `user`/`model` roles are valid on the wire, so a historical
      // system message is preserved as a tagged user turn. The top-level
      // system prompt flows into `systemInstruction` separately.
      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (text.length > 0) {
        contents.push({ role: 'user', parts: [{ text: `<system>${text}</system>` }] });
      }
      index += 1;
      continue;
    }

    if (message.role === 'assistant') {
      const parts = assistantMessageToParts(message, model, variant);
      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
      for (const toolCall of message.toolCalls) {
        toolNameById.set(toolCall.id, toolCall.name);
      }

      const responses: CloudCodePart[] = [];
      let next = index + 1;
      while (next < messages.length) {
        const candidate = messages[next];
        if (candidate === undefined || candidate.role !== 'tool') break;
        responses.push(...toolMessageToParts(candidate, toolNameById));
        next += 1;
      }
      appendFunctionResponses(responses);
      index = next;
      continue;
    }

    if (message.role === 'tool') {
      appendFunctionResponses(toolMessageToParts(message, toolNameById));
      index += 1;
      continue;
    }

    const parts: CloudCodePart[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text.trim().length === 0) continue;
        parts.push({ text: part.text });
        continue;
      }
      const mediaPart = mediaPartToCloudCode(part);
      if (mediaPart !== undefined) parts.push(mediaPart);
    }
    if (parts.length > 0) {
      contents.push({ role: 'user', parts });
    }
    index += 1;
  }

  return contents;
}

// ── Antigravity envelope ───────────────────────────────────────────────────

/** Mask keeping a value inside the signed 63-bit range the backend expects. */
const INT63_MASK = (1n << 63n) - 1n;
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** Stable signed-decimal session id derived from the first user turn. */
function deriveSessionIdFromText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MASK;
  }
  return formatSignedDecimalSessionId(hash & INT63_MASK);
}

function randomSignedDecimalSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return formatSignedDecimalSessionId(value & INT63_MASK);
}

function formatSignedDecimalSessionId(value: bigint): string {
  return `-${value.toString(10)}`;
}

function firstUserText(messages: Message[]): string | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.trim().length > 0) return text;
  }
  return undefined;
}

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes('claude');
}

interface AntigravityEnvelope {
  sessionId: string;
  requestId: string;
  labels: Record<string, string>;
}

/**
 * Build the Antigravity request envelope, advancing the per-conversation state:
 * `requestId` is `agent/<agentId>/<ts>/<trajectoryId>/<step>` and
 * `labels.last_step_index` trails the step by one, mirroring the native
 * client. The prior response id is echoed as `labels.last_execution_id`.
 */
function buildAntigravityEnvelope(
  session: CloudCodeAssistSessionState,
  history: Message[],
  model: string,
): AntigravityEnvelope {
  session.agentId ??= crypto.randomUUID();
  session.trajectoryId ??= crypto.randomUUID();
  if (session.sessionId === undefined) {
    const firstText = firstUserText(history);
    session.sessionId =
      firstText !== undefined ? deriveSessionIdFromText(firstText) : randomSignedDecimalSessionId();
  }
  session.stepIndex = (session.stepIndex ?? 1) + 1;

  const trajectoryId = session.trajectoryId;
  const step = session.stepIndex;
  const requestId = `agent/${session.agentId}/${Date.now()}/${trajectoryId}/${step}`;
  const usedClaude = isClaudeModel(model) ? 'true' : 'false';
  const labels: Record<string, string> = {
    last_step_index: String(step - 1),
    trajectory_id: trajectoryId,
    used_claude: usedClaude,
    used_claude_conservative: usedClaude,
  };
  if (session.lastResponseId !== undefined) {
    labels['last_execution_id'] = session.lastResponseId;
  }

  return { sessionId: session.sessionId, requestId, labels };
}

// ── Request building ───────────────────────────────────────────────────────

function normalizeSystemPrompt(systemPrompt: string | string[]): string[] {
  const blocks = typeof systemPrompt === 'string' ? [systemPrompt] : systemPrompt;
  return blocks.filter((block) => block.trim().length > 0);
}

export function buildCloudCodeAssistRequest(params: {
  model: string;
  projectId: string;
  systemPrompt: string | string[];
  tools: Tool[];
  history: Message[];
  variant: GoogleCloudCodeVariant;
  thinking: ThinkingConfig | undefined;
  session: CloudCodeAssistSessionState;
}): CloudCodeAssistRequestBody {
  const { model, projectId, systemPrompt, tools, history, variant, thinking, session } = params;
  const request: CloudCodeAssistInnerRequest = {
    contents: messagesToCloudCodeContents(history, model, variant),
  };

  const systemBlocks = normalizeSystemPrompt(systemPrompt);
  if (systemBlocks.length > 0) {
    // The Antigravity client tags the system instruction with the user role.
    request.systemInstruction = {
      ...(variant === 'antigravity' ? { role: 'user' } : {}),
      parts: systemBlocks.map((text) => ({ text })),
    };
  }

  if (thinking !== undefined) {
    request.generationConfig = { thinkingConfig: { ...thinking } };
  }

  if (tools.length > 0) {
    request.tools = [
      { functionDeclarations: tools.map((tool) => toolToFunctionDeclaration(tool, variant, model)) },
    ];
  }

  if (variant === 'antigravity') {
    // The Antigravity routes default to validated tool calls; Claude-backed
    // models need the mode restated even when no tool is declared.
    if (tools.length > 0 || isClaudeModel(model)) {
      request.toolConfig = { functionCallingConfig: { mode: TOOL_MODE_VALIDATED } };
    }
    const envelope = buildAntigravityEnvelope(session, history, model);
    request.sessionId = envelope.sessionId;
    request.labels = envelope.labels;
    return {
      project: projectId,
      requestId: envelope.requestId,
      request,
      model,
      userAgent: ANTIGRAVITY_USER_AGENT_TAG,
      requestType: ANTIGRAVITY_REQUEST_TYPE,
    };
  }

  return { project: projectId, model, request };
}

// ── Response conversion ────────────────────────────────────────────────────

/**
 * Normalize a Cloud Code Assist `finishReason`. Function calls arrive as
 * `parts[].functionCall` while the reason stays `STOP`, so a tool turn is
 * reported through the tool-call content rather than the finish reason.
 */
function normalizeFinishReason(raw: unknown): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (typeof raw !== 'string') {
    return { finishReason: null, rawFinishReason: null };
  }
  const value = raw.toUpperCase();
  if (value === '' || value === 'FINISH_REASON_UNSPECIFIED') {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (value) {
    case 'STOP':
      return { finishReason: 'completed', rawFinishReason: value };
    case 'MAX_TOKENS':
      return { finishReason: 'truncated', rawFinishReason: value };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { finishReason: 'filtered', rawFinishReason: value };
    default:
      return { finishReason: 'other', rawFinishReason: value };
  }
}

function readTokenCount(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Map `usageMetadata` onto the internal breakdown.
 *
 * `promptTokenCount` includes the cache-read tokens; the host sometimes omits
 * it or reports a cache count above it, so the prompt falls back to
 * `total - candidates - thinking` and the cache read is clamped to the prompt —
 * the input count never goes negative. Thinking tokens count as output: the
 * model generated them, and dropping them understates the turn.
 */
function mapUsageMetadata(metadata: Record<string, unknown>): TokenUsage {
  const candidates = readTokenCount(metadata, 'candidatesTokenCount');
  const thinking = readTokenCount(metadata, 'thoughtsTokenCount');
  const total = readTokenCount(metadata, 'totalTokenCount');
  const prompt =
    readTokenCount(metadata, 'promptTokenCount') || Math.max(total - candidates - thinking, 0);
  const cacheRead = Math.min(readTokenCount(metadata, 'cachedContentTokenCount'), prompt);
  return {
    inputOther: prompt - cacheRead,
    output: candidates + thinking,
    inputCacheRead: cacheRead,
    inputCacheCreation: 0,
  };
}

function convertResponsePart(
  part: CloudCodeAssistResponsePart,
  model: string,
): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  const signature = readNonEmptyString(part.thoughtSignature);

  if (typeof part.text === 'string' && part.text !== '') {
    if (part.thought === true) {
      parts.push({
        type: 'think',
        think: part.text,
        ...(signature !== undefined ? { encrypted: signature } : {}),
      });
    } else {
      // A thought signature attached to visible text has no slot in the
      // internal text part; only reasoning and tool-call signatures are
      // replayed on the next turn.
      parts.push({ type: 'text', text: part.text });
    }
  }

  const functionCall = part.functionCall;
  if (functionCall !== undefined) {
    const name = readNonEmptyString(functionCall.name);
    if (name !== undefined) {
      const id = readNonEmptyString(functionCall.id) ?? `${name}_${crypto.randomUUID()}`;
      const toolCall: ToolCall = {
        type: 'function',
        id,
        name,
        arguments: functionCall.args === undefined ? '{}' : JSON.stringify(functionCall.args),
        // The signature travels with the model that issued it: a later request
        // to a different model must not replay it.
        ...(signature !== undefined
          ? { extras: { thought_signature_b64: signature, thought_signature_model: model } }
          : {}),
      };
      parts.push(toolCall);
    }
  }

  return parts;
}

// ── SSE transport ──────────────────────────────────────────────────────────

/**
 * SSE frame separator. The scan runs over the assembled buffer, so a frame
 * boundary is recognized even when a chunk boundary falls between the `\r` and
 * the `\n` of one of its line endings.
 */
const SSE_EVENT_BOUNDARY = /\r?\n\r?\n/;

function parseSseEvent(rawEvent: string): CloudCodeAssistResponseChunk | undefined {
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
      `Cloud Code Assist API returned a malformed stream event: ${data.slice(0, 200)}`,
    );
  }
  return isRecord(parsed) ? (parsed as CloudCodeAssistResponseChunk) : undefined;
}

/** Read the response body as a stream of Cloud Code Assist SSE payloads. */
async function* readSseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<CloudCodeAssistResponseChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = SSE_EVENT_BOUNDARY.exec(buffer);
      while (boundary !== null) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const chunk = parseSseEvent(rawEvent);
        if (chunk !== undefined) yield chunk;
        boundary = SSE_EVENT_BOUNDARY.exec(buffer);
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) {
      const chunk = parseSseEvent(tail);
      if (chunk !== undefined) yield chunk;
    }
  } finally {
    // Releases the body when the consumer stops early (abort, error) so the
    // underlying connection is not left draining in the background.
    await reader.cancel().catch(() => {});
  }
}

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
      return new APITimeoutError(message);
    }
    if (error instanceof TypeError) {
      return new APIConnectionError(`Cloud Code Assist transport error: ${message}`);
    }
    return new ChatProviderError(`Cloud Code Assist error: ${message}`);
  }
  return new ChatProviderError(`Cloud Code Assist error: ${String(error)}`);
}

/** Transient failures that justify trying the next configured endpoint. */
function isEndpointFailoverError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) return true;
  // A silent 200 (accepted, then closed with no events) is a transport-shape
  // failure, not a model answer: fail over before anything was emitted.
  if (error instanceof EmptyStreamError) return true;
  if (error instanceof APIStatusError) {
    const status = error.statusCode;
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }
  return false;
}

/**
 * The endpoint accepted the request but produced no terminal event. Kept as a
 * distinct type so the endpoint walk can treat it as failover-eligible while a
 * content-level failure (blocked prompt, malformed tool call) is not.
 */
class EmptyStreamError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyStreamError';
  }
}

function streamErrorFromEvent(error: NonNullable<CloudCodeAssistResponseChunk['error']>): ChatProviderError {
  // Both fields survive into the detail: a quota failure from this host may
  // carry only a status (`RESOURCE_EXHAUSTED`) and no message, and the
  // text-based quota classification downstream reads it off this text.
  const errorMessage = readNonEmptyString(error.message);
  const status = readNonEmptyString(error.status);
  const detail =
    errorMessage === undefined
      ? (status ?? 'unknown error')
      : status === undefined
        ? errorMessage
        : `${errorMessage} (${status})`;
  const message = `Cloud Code Assist stream error: ${detail}`;
  return typeof error.code === 'number'
    ? normalizeAPIStatusError(error.code, message)
    : new ChatProviderError(message);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// ── Streamed message ───────────────────────────────────────────────────────

interface CloudCodeStreamRequest {
  readonly endpoints: readonly string[];
  readonly headers: Record<string, string>;
  readonly body: string;
  /**
   * Model the request was made for. Kept separately from the response's
   * `modelVersion` so a captured signature is tagged with the model it was
   * issued to.
   */
  readonly model: string;
  readonly signal: AbortSignal | undefined;
  readonly fetchImpl: GoogleCloudCodeFetch;
  readonly session: CloudCodeAssistSessionState;
  /** Whether the endpoint that answered should be remembered for later requests. */
  readonly rememberEndpoint: boolean;
}

export class GoogleCloudCodeStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _model: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(request: CloudCodeStreamRequest) {
    this._iter = this._streamParts(request);
  }

  get id(): string | null {
    return this._id;
  }

  get model(): string | null {
    return this._model;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private _captureFinishReason(raw: unknown): void {
    const { finishReason, rawFinishReason } = normalizeFinishReason(raw);
    if (finishReason !== null || rawFinishReason !== null) {
      this._finishReason = finishReason;
      this._rawFinishReason = rawFinishReason;
    }
  }

  /**
   * Stream one request, walking the candidate endpoints until one produces a
   * complete response. Failover only happens before anything has been emitted,
   * so a mid-stream failure is never silently replayed.
   */
  private async *_streamParts(request: CloudCodeStreamRequest): AsyncGenerator<StreamedMessagePart> {
    let lastError: ChatProviderError | undefined;
    for (let index = 0; index < request.endpoints.length; index += 1) {
      const endpoint = request.endpoints[index];
      if (endpoint === undefined) continue;
      const isLastEndpoint = index === request.endpoints.length - 1;
      let emitted = false;
      // Which block the stream is currently inside, so a signature-only frame
      // is retained on the block it continues.
      let openBlock: 'think' | 'text' | undefined;
      let sawFinishReason = false;
      let responseId: string | undefined;
      try {
        this._throwIfAborted(request.signal);
        const response = await request.fetchImpl(`${endpoint}/${STREAM_METHOD}`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });

        if (!response.ok) {
          const errorText = await readErrorBody(response);
          throw normalizeAPIStatusError(
            response.status,
            `Cloud Code Assist API error (${response.status}): ${errorText}`,
            null,
            readRetryAfterMsFromHeaders((name) => response.headers.get(name)),
          );
        }
        if (response.body === null) {
          throw new APIConnectionError('Cloud Code Assist API returned a response without a body.');
        }

        for await (const chunk of readSseChunks(response.body)) {
          this._throwIfAborted(request.signal);
          if (chunk.error !== undefined) {
            throw streamErrorFromEvent(chunk.error);
          }
          const payload = chunk.response;
          if (payload === undefined) continue;

          if (payload.responseId !== undefined) {
            responseId = payload.responseId;
            this._id = payload.responseId;
          }
          if (payload.modelVersion !== undefined) {
            this._model = payload.modelVersion;
          }
          const candidates = payload.candidates ?? [];
          if (candidates.length === 0 && payload.promptFeedback?.blockReason !== undefined) {
            const detail = payload.promptFeedback.blockReasonMessage;
            throw new ChatProviderError(
              `Request blocked by Google (${payload.promptFeedback.blockReason})${detail !== undefined ? `: ${detail}` : ''}`,
            );
          }

          const candidate = candidates[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (part.text === '' && part.functionCall === undefined) {
              // A frame carrying nothing but a signature continues the block
              // that is still open. Retaining it on the reasoning block keeps
              // the signature available for the next replay; the accumulator
              // folds the empty part into the thinking block it follows.
              // Visible text has no signature slot in the internal text part,
              // so a signature trailing a text block is dropped rather than
              // attributed to a block that cannot carry it.
              const signature = readNonEmptyString(part.thoughtSignature);
              if (signature !== undefined && openBlock === 'think') {
                yield { type: 'think', think: '', encrypted: signature };
              }
              continue;
            }
            for (const streamedPart of convertResponsePart(part, request.model)) {
              emitted = true;
              openBlock =
                streamedPart.type === 'think' || streamedPart.type === 'text'
                  ? streamedPart.type
                  : undefined;
              yield streamedPart;
            }
          }
          if (candidate?.finishReason !== undefined) {
            sawFinishReason = true;
            this._captureFinishReason(candidate.finishReason);
          }
          if (payload.usageMetadata !== undefined) {
            this._usage = mapUsageMetadata(payload.usageMetadata);
          }
        }

        if (!sawFinishReason) {
          throw new EmptyStreamError(
            'Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)',
          );
        }

        if (request.rememberEndpoint) {
          request.session.lastGoodEndpoint = endpoint;
        }
        request.session.lastResponseId = responseId;
        return;
      } catch (error) {
        if (isAbortError(error)) throw error;
        const converted = convertTransportError(error);
        if (!isLastEndpoint && !emitted && isEndpointFailoverError(converted)) {
          lastError = converted;
          continue;
        }
        throw converted;
      }
    }

    throw lastError ?? new ChatProviderError('Cloud Code Assist API request failed.');
  }
}

// ── Provider ───────────────────────────────────────────────────────────────

export class GoogleCloudCodeChatProvider implements ChatProvider {
  readonly name: string = PROVIDER_NAME;

  private _model: string;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _variant: GoogleCloudCodeVariant | undefined;
  private _fetch: GoogleCloudCodeFetch;
  private _thinking: ThinkingConfig | undefined;
  /**
   * Conversation state shared by every clone of this provider: endpoint
   * failover memory and the Antigravity envelope identity.
   */
  private _session: CloudCodeAssistSessionState;

  constructor(options: GoogleCloudCodeOptions) {
    this._model = options.model;
    this._apiKey = options.apiKey;
    this._baseUrl = normalizeEndpoint(options.baseUrl);
    this._variant = options.variant;
    this._fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this._thinking = undefined;
    this._session = {};
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinking = this._thinking;
    if (thinking === undefined) return null;
    if (thinking.thinkingLevel !== undefined) {
      switch (thinking.thinkingLevel) {
        case 'MINIMAL':
          // Gemini 3 has no true "off": MINIMAL with suppressed thoughts is
          // the lowest intensity available.
          return thinking.includeThoughts === false ? 'off' : 'low';
        case 'LOW':
          return 'low';
        case 'MEDIUM':
          return 'medium';
        case 'HIGH':
          return 'high';
        default:
          return null;
      }
    }
    if (thinking.thinkingBudget !== undefined) {
      if (thinking.thinkingBudget === 0) return 'off';
      if (thinking.thinkingBudget <= 1024) return 'low';
      if (thinking.thinkingBudget <= 4096) return 'medium';
      return 'high';
    }
    return null;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...(this._thinking !== undefined ? { thinking_config: this._thinking } : {}),
    };
  }

  getCapability(model?: string): ModelCapability {
    return getGoogleCloudCodeModelCapability(model ?? this._model);
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

    const credentials = parseGoogleCloudCodeCredentials(
      requireProviderApiKey(PROVIDER_LABEL, options?.auth, this._apiKey),
    );
    const endpointOverride = credentials.endpoint ?? normalizeEndpoint(options?.auth?.baseUrl) ?? this._baseUrl;
    const variant = this._variant ?? inferGoogleCloudCodeVariant(endpointOverride);
    const { endpoints, rememberEndpoint } = this._resolveEndpoints(variant, endpointOverride);
    const body = buildCloudCodeAssistRequest({
      model: this._model,
      projectId: credentials.projectId,
      systemPrompt,
      tools,
      history,
      variant,
      thinking: this._thinking,
      session: this._session,
    });

    return new GoogleCloudCodeStreamedMessage({
      endpoints,
      headers: buildRequestHeaders(variant, credentials, this._model, options?.auth?.headers),
      model: this._model,
      body: JSON.stringify(body),
      signal: options?.signal,
      fetchImpl: this._fetch,
      session: this._session,
      rememberEndpoint,
    });
  }

  withThinking(effort: ThinkingEffort): GoogleCloudCodeChatProvider {
    const thinking: ThinkingConfig = { includeThoughts: true };
    const usesThinkingLevel = this._model.includes('gemini-3');
    if (usesThinkingLevel) {
      switch (effort) {
        case 'off':
          thinking.thinkingLevel = 'MINIMAL';
          thinking.includeThoughts = false;
          break;
        case 'low':
          thinking.thinkingLevel = 'LOW';
          break;
        case 'medium':
          thinking.thinkingLevel = 'MEDIUM';
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinking.thinkingLevel = 'HIGH';
          break;
      }
    } else {
      switch (effort) {
        case 'off':
          thinking.thinkingBudget = 0;
          thinking.includeThoughts = false;
          break;
        case 'low':
          thinking.thinkingBudget = 1024;
          break;
        case 'medium':
          thinking.thinkingBudget = 4096;
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinking.thinkingBudget = 32_000;
          break;
      }
    }
    const clone = this._clone();
    clone._thinking = thinking;
    return clone;
  }

  /**
   * Candidate endpoints for a request. A pinned endpoint (proxy, gateway, or a
   * host the credential named) is used verbatim; the canonical Antigravity
   * hosts fail over to the sandbox and remember the host that answered.
   */
  private _resolveEndpoints(
    variant: GoogleCloudCodeVariant,
    endpointOverride: string | undefined,
  ): { endpoints: string[]; rememberEndpoint: boolean } {
    if (variant !== 'antigravity') {
      return {
        endpoints: [endpointOverride ?? CLOUD_CODE_ASSIST_DEFAULT_ENDPOINT],
        rememberEndpoint: false,
      };
    }
    const isCanonicalHost =
      endpointOverride === undefined ||
      endpointOverride === CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT ||
      endpointOverride === CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT;
    if (!isCanonicalHost) {
      return { endpoints: [endpointOverride], rememberEndpoint: false };
    }
    const lastGood = this._session.lastGoodEndpoint;
    if (lastGood !== undefined && (ANTIGRAVITY_ENDPOINT_FALLBACKS as readonly string[]).includes(lastGood)) {
      return {
        endpoints: [lastGood, ...ANTIGRAVITY_ENDPOINT_FALLBACKS.filter((host) => host !== lastGood)],
        rememberEndpoint: true,
      };
    }
    return { endpoints: [...ANTIGRAVITY_ENDPOINT_FALLBACKS], rememberEndpoint: true };
  }

  private _clone(): GoogleCloudCodeChatProvider {
    // Shares `_session` with the original on purpose: thinking clones keep
    // reporting into the same conversation state.
    return Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as GoogleCloudCodeChatProvider,
      this,
    );
  }
}
