/**
 * ImageGenerate — generate/edit images through the locally configured
 * OpenAI-compatible image API and save the PNG to the workspace.
 *
 * Configuration lives in `<screamHome>/image-config.json` (written by the
 * TUI `/config image` wizard). The API key never enters the model context:
 * it is read here, sent as the Authorization header, and never echoed into
 * results, session state, or errors.
 *
 * Request shapes follow the de-facto OpenAI-compatible contract, with the
 * endpoint URLs taken from the config exactly as written (nothing appended):
 * - text-to-image: the configured full URL (JSON)
 * - image-to-image: the configured edit URL, or the derived sibling
 *   `/images/edits` when the main URL ends in `/images/generations`
 *   (multipart)
 *
 * Streaming is attempted first (`stream: true` + SSE) because long
 * synchronous generations commonly time out behind gateways; when the
 * endpoint rejects stream parameters the call is retried once without them.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, resolve } from 'pathe';

import type { Jian } from '@scream-code/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { RunnableToolExecution, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import DESCRIPTION from './image-generate.md';

export const ImageGenerateInputSchema = z.object({
  mode: z
    .enum(['new', 'edit', 'continue'])
    .describe("new = text-to-image, edit = rewrite imagePaths, continue = edit the session's last image."),
  prompt: z.string().min(1).describe('The image-generation prompt exactly as the user wrote it.'),
  imagePaths: z
    .array(z.string())
    .optional()
    .describe('Absolute or workspace-relative image paths. Required for mode=edit.'),
  session: z
    .string()
    .optional()
    .describe('Visual thread name. Omit to start/join the default thread.'),
  size: z
    .string()
    .optional()
    .describe(
      'Requested size for the model, e.g. "1024x1024" or "1536x1024". Pick one from the user\'s aspect-ratio need; omit to use the configured default.',
    ),
});

export type ImageGenerateInput = z.infer<typeof ImageGenerateInputSchema>;

const STREAM_TIMEOUT_MS = 120_000;
const SYNC_TIMEOUT_MS = 90_000;
const UNCONFIGURED_OUTPUT =
  'Image generation is not configured. Ask the user to run /config image, then retry this call.';
/** Session names become directory/file components — no separators, no traversal. */
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Every uploaded path goes through the shared path policy with the default
 * workspace guard (same contract as Read: absolute paths may sit outside
 * the workspace, relative escapes and sensitive files are rejected) so
 * credential exfiltration through a prompt-injected path fails before any
 * bytes leave the machine.
 */
async function checkUploadPath(
  rawPath: string,
  options: { jian: Jian; workspace: WorkspaceConfig; workspaceDir: string },
): Promise<string> {
  const path = isAbsolute(rawPath) ? rawPath : resolve(options.workspaceDir, rawPath);
  return resolvePathAccessPath(path, {
    jian: options.jian,
    workspace: options.workspace,
    operation: 'read',
  });
}

interface ImageConfigFile {
  readonly provider: string;
  /** Full text-to-image endpoint URL, used exactly as configured. */
  readonly url: string;
  readonly api_key: string;
  readonly model: string;
  readonly size: string;
  /** Optional full image-edit endpoint; absent = derived from `url`. */
  readonly edit_url?: string;
  /** Optional image-edit model; empty/absent = same as model. */
  readonly edit_model?: string;
  /** Legacy (pre-full-URL builds): base URL, read as url + generations path. */
  readonly base_url?: string;
  /** Legacy (pre-full-URL builds): edit base URL. */
  readonly edit_base_url?: string;
}

interface ImageSessionTurn {
  readonly turn: number;
  readonly mode: 'new' | 'edit' | 'continue';
  readonly prompt: string;
  readonly input_images: readonly string[];
  readonly output: string;
  readonly created_at: string;
}

interface ImageSessionState {
  readonly session: string;
  readonly model: string;
  readonly last_image?: string;
  readonly turns: readonly ImageSessionTurn[];
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    trimmed.includes('replace-with') ||
    (trimmed.startsWith('<') && trimmed.endsWith('>'))
  );
}

/**
 * Trim only — the configured URL is used exactly as written, no path is
 * ever appended. Trailing slashes are stripped so the URL cannot double up
 * against anything downstream.
 */
function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** The one documented derivation: the OpenAI-family sibling edit endpoint. */
const GENERATIONS_SUFFIX = '/images/generations';
const EDITS_SUFFIX = '/images/edits';

function deriveEditUrl(url: string): string | undefined {
  return url.endsWith(GENERATIONS_SUFFIX)
    ? `${url.slice(0, -GENERATIONS_SUFFIX.length)}${EDITS_SUFFIX}`
    : undefined;
}

async function loadConfig(screamHomeDir: string): Promise<ImageConfigFile | undefined> {
  try {
    const text = await readFile(join(screamHomeDir, 'image-config.json'), 'utf8');
    const parsed = JSON.parse(text) as Partial<ImageConfigFile>;
    // Legacy alias: configs written by pre-full-URL builds stored a base URL
    // (e.g. "https://host/v1"); compose the classic endpoint so an existing
    // setup keeps working after the upgrade. Re-running the wizard migrates
    // the file to the full-URL format.
    const legacyUrl =
      typeof parsed.base_url === 'string' && !isPlaceholder(parsed.base_url)
        ? `${normalizeUrl(parsed.base_url)}${GENERATIONS_SUFFIX}`
        : '';
    const urlRaw =
      typeof parsed.url === 'string' && !isPlaceholder(parsed.url) ? parsed.url : legacyUrl;
    if (
      urlRaw.length === 0 ||
      typeof parsed.api_key !== 'string' ||
      typeof parsed.model !== 'string' ||
      isPlaceholder(parsed.api_key)
    ) {
      return undefined;
    }
    const legacyEdit =
      typeof parsed.edit_base_url === 'string' && !isPlaceholder(parsed.edit_base_url)
        ? `${normalizeUrl(parsed.edit_base_url)}${EDITS_SUFFIX}`
        : '';
    const editUrlRaw =
      typeof parsed.edit_url === 'string' && !isPlaceholder(parsed.edit_url)
        ? parsed.edit_url
        : legacyEdit;
    const editModelRaw = typeof parsed.edit_model === 'string' ? parsed.edit_model : '';
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'openai-compatible',
      url: normalizeUrl(urlRaw),
      api_key: parsed.api_key,
      model: parsed.model,
      size: typeof parsed.size === 'string' && parsed.size.trim().length > 0 ? parsed.size.trim() : 'auto',
      ...(editUrlRaw.length > 0 ? { edit_url: normalizeUrl(editUrlRaw) } : {}),
      ...(editModelRaw.trim().length > 0 ? { edit_model: editModelRaw.trim() } : {}),
    };
  } catch {
    return undefined;
  }
}

// ── Session state (metadata only — never the API key) ──────────────────

function sessionsDir(screamHomeDir: string): string {
  return join(screamHomeDir, 'image-sessions');
}

function sessionPath(screamHomeDir: string, session: string): string {
  return join(sessionsDir(screamHomeDir), `${session}.json`);
}

async function readPointer(screamHomeDir: string): Promise<string | undefined> {
  try {
    const name = (await readFile(join(sessionsDir(screamHomeDir), 'current-session'), 'utf8')).trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

async function writePointer(screamHomeDir: string, session: string): Promise<void> {
  const dir = sessionsDir(screamHomeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'current-session'), session, { encoding: 'utf8', mode: 0o600 });
}

async function loadSession(screamHomeDir: string, session: string): Promise<ImageSessionState | undefined> {
  try {
    const text = await readFile(sessionPath(screamHomeDir, session), 'utf8');
    const parsed = JSON.parse(text) as ImageSessionState;
    return Array.isArray(parsed.turns) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function saveSession(screamHomeDir: string, state: ImageSessionState): Promise<void> {
  const dir = sessionsDir(screamHomeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath(screamHomeDir, state.session), `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function defaultSessionName(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `img-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// ── HTTP layer ─────────────────────────────────────────────────────────

function streamUnsupported(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const message = error.message.toLowerCase();
  // Both injected stream params must be covered: gateways may accept
  // `stream` but reject the OpenAI-only `partial_images`.
  if (!message.includes('stream') && !message.includes('partial_images')) return false;
  return (
    message.includes('unsupported') ||
    message.includes('not supported') ||
    message.includes('unknown parameter') ||
    message.includes('invalid parameter') ||
    message.includes('unexpected')
  );
}

/**
 * True when a failure is plausibly about the `size` field — either the value
 * was rejected or the field itself was demanded. Triggers one retry with the
 * other size mode (see the size fallback in execute).
 */
function sizeUnsupported(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const message = error.message.toLowerCase();
  if (!message.includes('size')) return false;
  return (
    message.includes('support') ||
    message.includes('unknown parameter') ||
    message.includes('invalid') ||
    message.includes('required') ||
    message.includes('must')
  );
}

/** Fallback size used when a service insists on an explicit value. */
const FALLBACK_SIZE = '1024x1024';

/** Structured guidance when no image-edit endpoint can be resolved. */
const EDIT_URL_REQUIRED =
  'Image editing needs the edit endpoint: set an edit URL via /config image, or configure a URL ending in /images/generations so the sibling /images/edits URL can be derived.';

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return '';
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const detail = await readErrorBody(response);
  throw new ApiError(`HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`, response.status);
}

/**
 * True for a wire string that actually carries data. Gateways routinely emit
 * empty placeholders — `{"b64_json":"","url":"https://…/x.png"}` — next to the
 * field holding the real image, so presence alone must never win: an empty
 * `b64_json` that outranks a populated `url` yields a zero-byte "success".
 */
function isUsableWireString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** First usable image field of one object, base64 before URL. */
function pickImageField(record: Record<string, unknown>): { b64?: string; url?: string } | undefined {
  if (isUsableWireString(record['b64_json'])) return { b64: record['b64_json'] };
  if (isUsableWireString(record['url'])) return { url: record['url'] };
  return undefined;
}

/** Pull the first image payload out of a parsed JSON body (three shapes). */
export function extractImagePayload(body: unknown): { b64?: string; url?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;

  const direct = pickImageField(record);
  if (direct !== undefined) return direct;

  const data = record['data'];
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const found = pickImageField(entry as Record<string, unknown>);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** True when a parsed SSE event carries image payload (directly or nested). */
function eventHasImage(event: Record<string, unknown>): boolean {
  if (extractImagePayload(event) !== undefined) return true;
  return (
    event['type'] === 'image_generation.completed' &&
    typeof event['result'] === 'object' &&
    extractImagePayload(event['result']) !== undefined
  );
}

/** Read an SSE body and return the last event that carries image data. */
async function parseSse(response: Response): Promise<Record<string, unknown> | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return (await response.json()) as Record<string, unknown>;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const decoder = new TextDecoder();
  let buffer = '';
  let block: string[] = [];
  let finalEvent: Record<string, unknown> | undefined;
  const flush = (): void => {
    if (block.length === 0) return;
    // Standard SSE lines carry a `data:` prefix; some gateways emit raw JSON.
    const dataLines = block
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''));
    const joined = (dataLines.length > 0 ? dataLines : block).join('\n');
    block = [];
    try {
      const event = JSON.parse(joined) as Record<string, unknown>;
      if (eventHasImage(event)) finalEvent = event;
    } catch {
      // Ignore non-JSON keep-alive/comment blocks.
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) {
        flush();
      } else {
        block.push(line);
      }
      newline = buffer.indexOf('\n');
    }
  }
  // A gateway may close the connection right after the final `data:` line
  // without a trailing newline/blank separator — keep that last line.
  buffer += decoder.decode();
  if (buffer.length > 0) {
    block.push(buffer.replace(/\r$/, ''));
    buffer = '';
  }
  flush();
  return finalEvent;
}

interface RequestPlan {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | FormData;
}

function buildJsonPlan(
  apiKey: string,
  url: string,
  payload: Record<string, unknown>,
  stream: boolean,
): RequestPlan {
  const body: Record<string, unknown> = { ...payload };
  if (stream) {
    body['stream'] = true;
    body['partial_images'] = 1;
  }
  return {
    url,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function buildMultipartPlan(
  apiKey: string,
  url: string,
  fields: Record<string, string>,
  stream: boolean,
): RequestPlan {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  if (stream) {
    form.append('stream', 'true');
    form.append('partial_images', '1');
  }
  return {
    url,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: form,
  };
}

async function attachMultipartFiles(body: FormData, imagePaths: string[]): Promise<void> {
  // Single file keeps the plain `image` field; multiple references use the
  // bracketed `image[]` form of the official API.
  const fieldName = imagePaths.length > 1 ? 'image[]' : 'image';
  for (const path of imagePaths) {
    const bytes = await readFile(path);
    // Send only the basename: the filename part must not leak local
    // directory structure (usernames, workspace paths) to the gateway.
    body.append(fieldName, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), basename(path));
  }
}

async function requestImage(
  plan: (stream: boolean) => RequestPlan,
  files: string[] | undefined,
  external?: AbortSignal,
): Promise<unknown> {
  const attempt = async (stream: boolean): Promise<unknown> => {
    const request = plan(stream);
    if (files !== undefined && request.body instanceof FormData) {
      await attachMultipartFiles(request.body, files);
    }
    const response = await fetchWithTimeout(
      request.url,
      { method: 'POST', headers: request.headers, body: request.body },
      stream ? STREAM_TIMEOUT_MS : SYNC_TIMEOUT_MS,
      external,
    );
    await assertOk(response);
    // Return the wire payload as-is; payloadToBytes performs all shape
    // extraction (b64_json / url / data[] / nested result).
    return (await parseSse(response)) as unknown;
  };

  try {
    return await attempt(true);
  } catch (error) {
    if (streamUnsupported(error)) {
      const synced = await attempt(false);
      return synced;
    }
    throw error;
  }
}

/** `data:image/png;base64,…` wrappers some gateways prepend to the payload. */
const DATA_URL_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** Magic numbers of the formats an OpenAI-compatible image API can return. */
function looksLikeImage(bytes: Uint8Array): boolean {
  const matchesAt = (offset: number, signature: readonly number[]): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  return (
    matchesAt(0, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    matchesAt(0, [0xff, 0xd8, 0xff]) || // JPEG
    matchesAt(0, [0x47, 0x49, 0x46, 0x38]) || // GIF
    matchesAt(0, [0x42, 0x4d]) || // BMP
    matchesAt(0, [0x49, 0x49, 0x2a, 0x00]) || // TIFF (LE)
    matchesAt(0, [0x4d, 0x4d, 0x00, 0x2a]) || // TIFF (BE)
    (matchesAt(0, [0x52, 0x49, 0x46, 0x46]) && matchesAt(8, [0x57, 0x45, 0x42, 0x50])) || // WebP
    (bytes.length > 12 && matchesAt(4, [0x66, 0x74, 0x79, 0x70])) // AVIF / HEIF (ftyp)
  );
}

/**
 * Last gate before anything reaches the disk: an empty or non-image payload
 * must fail loudly instead of being written as a `.png` and reported as a
 * successful generation.
 */
function assertImageBytes(bytes: Uint8Array, origin: string): Uint8Array {
  if (bytes.length === 0) {
    throw new ApiError(`The image API returned no image data (empty ${origin}).`);
  }
  if (!looksLikeImage(bytes)) {
    const head = Buffer.from(bytes.slice(0, 8)).toString('hex');
    throw new ApiError(
      `The ${origin} is not an image (first bytes: ${head}); check the endpoint URL and model in /config image.`,
    );
  }
  return bytes;
}

async function payloadToBytes(payload: unknown, external?: AbortSignal): Promise<Uint8Array> {
  const nested =
    typeof payload === 'object' && payload !== null && 'result' in payload
      ? extractImagePayload((payload as Record<string, unknown>)['result'])
      : undefined;
  const found = extractImagePayload(payload) ?? nested;
  if (found?.b64 !== undefined) {
    // Some gateways wrap the payload in a data URL; strip the prefix before
    // decoding so it cannot corrupt the image.
    const encoded = found.b64.replace(DATA_URL_PREFIX, '');
    return assertImageBytes(Uint8Array.from(Buffer.from(encoded, 'base64')), 'b64_json payload');
  }
  if (found?.url !== undefined) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, SYNC_TIMEOUT_MS);
    const onExternalAbort = (): void => {
      controller.abort();
    };
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const response = await fetch(found.url, { signal: controller.signal });
      if (!response.ok) throw new ApiError(`Image download failed: HTTP ${response.status}`, response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return assertImageBytes(bytes, `image download from ${found.url}`);
    } finally {
      clearTimeout(timeoutId);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }
  throw new ApiError('The image API response contained no image data.');
}

// ── Tool ───────────────────────────────────────────────────────────────

/**
 * Generates or edits images through the locally configured image API and
 * saves the PNG under `outputs/image/<session>/` in the workspace.
 */
export class ImageGenerateTool implements BuiltinTool<ImageGenerateInput> {
  readonly name = 'ImageGenerate' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ImageGenerateInputSchema);

  constructor(
    private readonly workspaceDir: string,
    private readonly screamHomeDir: string,
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async resolveExecution(args: ImageGenerateInput): Promise<ToolExecution> {
    const checkOptions = {
      jian: this.jian,
      workspace: this.workspace,
      workspaceDir: this.workspaceDir,
    };
    // Resolve and policy-check every model-supplied upload path before the
    // approval prompt: nothing leaves the machine without passing the same
    // workspace and sensitive-file gates as Read.
    const checkedPaths: string[] = [];
    for (const rawPath of args.imagePaths ?? []) {
      checkedPaths.push(await checkUploadPath(rawPath, checkOptions));
    }
    const [firstPath] = checkedPaths;

    let accesses: ReturnType<typeof ToolAccesses.readFile> | undefined;
    let display: RunnableToolExecution['display'];
    if (checkedPaths.length > 0 && firstPath !== undefined) {
      accesses = checkedPaths.flatMap((path) => ToolAccesses.readFile(path));
      display = { kind: 'file_io', operation: 'read', path: firstPath };
    }

    return {
      ...(accesses !== undefined ? { accesses } : {}),
      description:
        checkedPaths.length > 0
          ? `Generating image (${args.mode}) → upload ${checkedPaths.join(', ')}`
          : `Generating image (${args.mode})`,
      ...(display !== undefined ? { display } : {}),
      approvalRule: firstPath !== undefined ? literalRulePattern(this.name, firstPath) : this.name,
      ...(checkedPaths.length > 0
        ? {
            matchesRule: (ruleArgs: string): boolean =>
              checkedPaths.every((path) =>
                matchesPathRuleSubject(ruleArgs, path, {
                  cwd: this.workspace.workspaceDir,
                  pathClass: this.jian.pathClass(),
                  homeDir: this.jian.gethome(),
                }),
              ),
          }
        : {}),
      execute: async (context) => {
        if (context.signal.aborted) {
          return { isError: true, output: 'Cancelled.' };
        }
        if (args.mode === 'edit' && (args.imagePaths === undefined || args.imagePaths.length === 0)) {
          return { isError: true, output: 'mode=edit requires at least one entry in imagePaths.' };
        }

        const config = await loadConfig(this.screamHomeDir);
        if (config === undefined) {
          return { isError: true, output: UNCONFIGURED_OUTPUT };
        }
        if (config.provider === 'volcengine' && args.mode !== 'new') {
          return {
            isError: true,
            output:
              'The configured image service supports text-to-image only; ' +
              'image-to-image requires an OpenAI-compatible service.',
          };
        }

        const startedAt = Date.now();
        let session: ImageSessionState;
        let inputImages: string[];
        try {
          session = await this.resolveSession(args);
          const resolvedImages = await this.resolveInputImages(args, session);
          // Re-check after session resolution: continue mode injects the
          // previous output path from the session file, which may have been
          // edited by hand.
          inputImages = [];
          for (const resolved of resolvedImages) {
            inputImages.push(await checkUploadPath(resolved, checkOptions));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, output: message };
        }
        const size = args.size !== undefined && args.size.trim().length > 0 ? args.size.trim() : config.size;
        const explicitSize = size !== 'auto' ? size : undefined;
        // Image-edit channel: full URL and model overrides, both optional.
        // The only derivation is the documented OpenAI-family sibling path.
        const editModel =
          config.edit_model !== undefined && config.edit_model.trim().length > 0
            ? config.edit_model.trim()
            : config.model;
        const editUrl =
          config.edit_url !== undefined && config.edit_url.length > 0
            ? config.edit_url
            : deriveEditUrl(config.url);
        if (args.mode !== 'new' && editUrl === undefined) {
          return { isError: true, output: EDIT_URL_REQUIRED };
        }

        // Minimal common field set: `n`, `output_format`, and an explicit
        // `auto` size are rejected by some otherwise-compatible gateways.
        const buildFields = (
          withSize: string | undefined,
        ): { json: Record<string, unknown>; form: Record<string, string> } => {
          const json: Record<string, unknown> = { model: config.model, prompt: args.prompt };
          const form: Record<string, string> = { model: editModel, prompt: args.prompt };
          if (withSize !== undefined) {
            json['size'] = withSize;
            form['size'] = withSize;
          }
          return { json, form };
        };

        const dispatch = async (withSize: string | undefined): Promise<unknown> => {
          const fields = buildFields(withSize);
          if (args.mode === 'new') {
            return requestImage(
              (stream) => buildJsonPlan(config.api_key, config.url, fields.json, stream),
              undefined,
              context.signal,
            );
          }
          if (editUrl === undefined) {
            // Unreachable: guarded before dispatch; kept for type narrowing.
            throw new ApiError(EDIT_URL_REQUIRED);
          }
          return requestImage(
            (stream) => buildMultipartPlan(config.api_key, editUrl, fields.form, stream),
            inputImages,
            context.signal,
          );
        };

        let payload: unknown;
        let sizeNote = '';
        try {
          try {
            payload = await dispatch(explicitSize);
          } catch (error) {
            // Some services reject an explicit size (unknown/invalid value)
            // while others insist on receiving one (missing/required).
            // Retry exactly once with the other size mode before giving up,
            // and surface the downgrade in the result so the caller can
            // explain a different-than-requested aspect ratio.
            if (!sizeUnsupported(error)) throw error;
            const retrySize = explicitSize === undefined ? FALLBACK_SIZE : undefined;
            payload = await dispatch(retrySize);
            sizeNote =
              retrySize === undefined
                ? ' [size fallback: requested size unsupported, used the service default]'
                : ` [size fallback: used ${FALLBACK_SIZE}]`;
          }
        } catch (error) {
          if (context.signal.aborted) {
            return { isError: true, output: 'Cancelled.' };
          }
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, output: `Image API request failed: ${message}` };
        }

        let bytes: Uint8Array;
        try {
          bytes = await payloadToBytes(payload, context.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, output: `Image response could not be read: ${message}` };
        }

        if (context.signal.aborted) {
          // The turn was cancelled while the request was in flight — do not
          // persist any side effects the user no longer expects.
          return { isError: true, output: 'Cancelled before saving.' };
        }

        const turnNumber = session.turns.length + 1;
        const outputPath = join(
          this.workspaceDir,
          'outputs',
          'image',
          session.session,
          `turn-${String(turnNumber).padStart(3, '0')}.png`,
        );
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, bytes);

        const absolute = isAbsolute(outputPath) ? outputPath : resolve(this.workspaceDir, outputPath);
        const nextSession: ImageSessionState = {
          session: session.session,
          model: config.model,
          last_image: absolute,
          turns: [
            ...session.turns,
            {
              turn: turnNumber,
              mode: args.mode,
              prompt: args.prompt,
              input_images: inputImages,
              output: absolute,
              created_at: new Date().toISOString(),
            },
          ],
        };
        await saveSession(this.screamHomeDir, nextSession);
        await writePointer(this.screamHomeDir, session.session);

        const elapsed = Date.now() - startedAt;
        return {
          isError: false,
          output:
            `Image saved: ${absolute} ` +
            `(session=${session.session}, turn=${turnNumber}, mode=${args.mode}, model=${config.model}, ${elapsed}ms)${sizeNote}`,
        };
      },
    };
  }

  /** Resolve the session name, loading (or creating) its state. */
  private async resolveSession(args: ImageGenerateInput): Promise<ImageSessionState> {
    const requested =
      args.session !== undefined && args.session.trim().length > 0
        ? args.session.trim()
        : args.mode === 'continue'
          ? await readPointer(this.screamHomeDir)
          : undefined;
    const name = requested ?? defaultSessionName();
    if (name === '.' || name === '..' || !SESSION_NAME_RE.test(name)) {
      throw new Error(
        'Invalid session name: use 1-64 characters from a-z, A-Z, 0-9, dot, underscore, or hyphen.',
      );
    }

    const existing = await loadSession(this.screamHomeDir, name);
    if (existing !== undefined) {
      if (args.mode === 'continue' && existing.last_image === undefined) {
        throw new Error(`Session "${name}" has no previous image to continue from.`);
      }
      return existing;
    }
    if (args.mode === 'continue') {
      throw new Error(
        requested === undefined
          ? 'No previous image session found; run mode=new first.'
          : `No image session found for "${name}"; run mode=new first.`,
      );
    }
    return { session: name, model: '', turns: [] };
  }

  /** Absolute paths of the images fed into edit/continue. */
  private async resolveInputImages(args: ImageGenerateInput, session: ImageSessionState): Promise<string[]> {
    const explicit = (args.imagePaths ?? []).map((path) =>
      isAbsolute(path) ? path : resolve(this.workspaceDir, path),
    );
    if (args.mode === 'edit') return explicit;
    if (args.mode === 'continue') {
      const previous = session.last_image;
      if (previous === undefined) {
        throw new Error(`Session "${session.session}" has no previous image to continue from.`);
      }
      return [previous, ...explicit];
    }
    return explicit;
  }
}
