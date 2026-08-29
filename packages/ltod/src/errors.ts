import type { RateLimitReason } from './rate-limit-utils';
import { parseRateLimitReason } from './rate-limit-utils';

/**
 * Base error for all chat provider errors.
 */
export class ChatProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatProviderError';
  }
}

/**
 * Network-level connection failure.
 */
export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APIConnectionError';
  }
}

/**
 * Request timed out.
 */
export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APITimeoutError';
  }
}

/**
 * HTTP status error from the API.
 */
export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;

  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(message);
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
  }
}

/**
 * HTTP status error that specifically means the request exceeded the model
 * context window.
 */
export class APIContextOverflowError extends APIStatusError {
  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(statusCode, message, requestId);
    this.name = 'APIContextOverflowError';
  }
}

/**
 * HTTP status error that specifically means the provider rate-limited the
 * request. Carries a `reason` so retry logic can pick the right backoff
 * (quota exhaustion needs 30min or a credential switch; a transient 529
 * just needs 45s) instead of treating every 429 the same.
 */
export class APIProviderRateLimitError extends APIStatusError {
  readonly reason: RateLimitReason;
  /** Server-provided `Retry-After` in milliseconds, when the response header
   * was available. Consumed by the loop's `readRetryAfterMs`. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    requestId?: string | null,
    reason?: RateLimitReason,
    retryAfterMs?: number | undefined,
  ) {
    super(429, message, requestId);
    this.name = 'APIProviderRateLimitError';
    this.reason = reason ?? 'UNKNOWN';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Cap applied to a server-provided `Retry-After` so a misbehaving/large value
 * cannot hijack the loop's own bounded backoff (retry.ts caps at 32s) and
 * reintroduce multi-hour hangs. 60s covers every realistic rate-limit window
 * while keeping a hard bound.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** Parse a `Retry-After` header value (delta-seconds) into milliseconds,
 * capped at MAX_RETRY_AFTER_MS. Tolerates HTTP-date values (returns undefined
 * for those) and any headers-lookup failure — this is an optimization, never
 * a crash. */
export function readRetryAfterMsFromHeaders(
  get: (name: string) => string | null | undefined,
): number | undefined {
  try {
    const value = get('retry-after');
    if (value === null || value === undefined) return undefined;
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTP status error meaning the conversation history sent to the provider
 * has orphaned tool calls (an assistant `tool_calls` block whose matching
 * tool results are missing). Recoverable only by rebuilding the history —
 * retrying the same request always fails. Carried as a distinct class so
 * callers can reset the session on THIS kind alone instead of sniffing
 * error message text.
 */
export class APIOrphanedToolCallError extends APIStatusError {
  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(statusCode, message, requestId);
    this.name = 'APIOrphanedToolCallError';
  }
}

/**
 * HTTP status error that specifically means the request body was too large
 * for the provider to accept (HTTP 413). The most common cause is a large
 * media payload (images) accumulated in the conversation history.
 */
export class APIRequestTooLargeError extends APIStatusError {
  constructor(statusCode: number, message: string, requestId?: string | null) {
    super(statusCode, message, requestId);
    this.name = 'APIRequestTooLargeError';
  }
}

/**
 * Message-text parity check shared by normalizeAPIStatusError and
 * isOrphanedToolCallError. Mirrors the historical two-includes semantics:
 * the fragments may appear in any order.
 */
function isOrphanedToolCallMessage(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('insufficient tool messages') ||
    (lowerMessage.includes('tool_calls') && lowerMessage.includes('followed by tool messages'))
  );
}

/**
 * True when an error signals orphaned tool calls in the request history.
 * instanceof is checked first (provider threw the typed error); the message
 * patterns are the fallback for errors that crossed wrapping boundaries
 * (session/RPC layers re-wrapping the provider error).
 */
export function isOrphanedToolCallError(error: unknown): boolean {
  if (error instanceof APIOrphanedToolCallError) return true;
  return isOrphanedToolCallMessage(errorMessage(error).toLowerCase());
}

/**
 * The API returned an empty response (no content, no tool calls).
 */
export class APIEmptyResponseError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APIEmptyResponseError';
  }
}

export function isRetryableGenerateError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  if (error instanceof APIProviderRateLimitError) {
    // All 429s are retryable — including quota-style messages. Providers
    // commonly phrase transient quota windows (per-minute token limits,
    // dynamic concurrency quotas) as "quota exceeded", and those clear within
    // a minute. A genuinely exhausted account still fails: retry.ts bounds
    // quota 429s to a few short 30s backoffs instead of an instant fail.
    return true;
  }
  if (error instanceof APIStatusError) {
    // Transient server-side conditions: any 5xx (including Cloudflare's
    // 520-527 family), 408 request-timeout, and a plain 429. Deterministic
    // 4xx (400/401/402/403/404/409/413/422) mean the request itself is wrong
    // — retrying them is futile and only delays the real error.
    return (
      error.statusCode === 429 ||
      error.statusCode === 408 ||
      (error.statusCode >= 500 && error.statusCode < 600)
    );
  }
  return false;
}

const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long.*maximum/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
] as const;

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

const PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS = [
  /(?:apistatuserror.*429|429.*apistatuserror)/,
  /429.*too many requests/,
  /too many requests/,
  /provider\.rate_limit/,
  /reached .*max rpm/,
  /rate[ _-]?limit(?:ed)?/,
  /rate-limited/,
] as const;

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
  retryAfterMs?: number | undefined,
): APIStatusError {
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, parseRateLimitReason(message), retryAfterMs);
  }
  // Context overflow must be checked BEFORE the generic 413 branch: a 413
  // whose message matches overflow patterns is a context-window problem
  // (needs compaction), not a body-size problem (needs media degradation).
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId);
  }
  if (statusCode === 413) {
    return new APIRequestTooLargeError(statusCode, message, requestId);
  }
  if (statusCode === 400 && isOrphanedToolCallMessage(message.toLowerCase())) {
    return new APIOrphanedToolCallError(statusCode, message, requestId);
  }
  return new APIStatusError(statusCode, message, requestId);
}

export function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lowerMessage = message.toLowerCase();
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isProviderRateLimitError(error: unknown): boolean {
  if (error instanceof APIProviderRateLimitError) return true;

  const statusCode = getStatusCode(error);
  if (statusCode !== undefined) return statusCode === 429;

  const lowerMessage = errorMessage(error).toLowerCase();
  return PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

// ---------------------------------------------------------------------------
// Media / structural request recovery
// ---------------------------------------------------------------------------

const IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS = [
  /unsupported image (?:url|format|type)/,
  /does not represent a valid image/,
  /could not (?:process|decode) (?:the |input )?image/,
  /unable to process (?:the |input )?image/,
  /failed to decode (?:the )?image/,
  /invalid image(?: data| type| format)?/,
] as const;

const IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 image/,
  /invalid data url for image/,
] as const;

const MEDIA_TYPE_FIELD_PATTERN = /(?:media|mime)_?type/;

export function isImageFormatError(error: unknown): boolean {
  if (error instanceof APIStatusError) {
    if (error instanceof APIContextOverflowError) return false;
    if (error instanceof APIRequestTooLargeError) return false;
    if (error.statusCode !== 400) return false;
    const lowerMessage = error.message.toLowerCase();
    return (
      IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage)) ||
      (MEDIA_TYPE_FIELD_PATTERN.test(lowerMessage) && lowerMessage.includes('image'))
    );
  }
  if (error instanceof ChatProviderError) {
    const lowerMessage = error.message.toLowerCase();
    return IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

const STRUCTURAL_REQUEST_MESSAGE_PATTERNS = [
  /text content blocks must be non-empty/,
  /text content blocks must contain non-whitespace/,
  /first message must use the .*user.* role/,
  /roles must alternate/,
  /multiple .*(?:user|assistant).* roles in a row/,
  /tool_use[\s\S]*ids must be unique/,
  /must not be empty/,
] as const;

export function isRecoverableRequestStructureError(error: unknown): boolean {
  if (error instanceof APIStatusError) {
    if (error instanceof APIContextOverflowError) return false;
    if (error.statusCode !== 400 && error.statusCode !== 422) return false;
    const lowerMessage = error.message.toLowerCase();
    return STRUCTURAL_REQUEST_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

export function isRequestTooLargeError(error: unknown): boolean {
  // Context overflow (413 with overflow message) must NOT be treated as a
  // request-too-large media issue - it needs compaction, not media stripping.
  if (error instanceof APIContextOverflowError) return false;
  if (error instanceof APIRequestTooLargeError) return true;
  if (error instanceof APIStatusError) return error.statusCode === 413;
  return false;
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const record = error as Record<string, unknown>;
  const statusCode = record['statusCode'];
  if (typeof statusCode === 'number') return statusCode;
  const status = record['status'];
  if (typeof status === 'number') return status;

  const response = record['response'];
  if (typeof response !== 'object' || response === null) return undefined;
  const responseRecord = response as Record<string, unknown>;
  const responseStatusCode = responseRecord['statusCode'];
  if (typeof responseStatusCode === 'number') return responseStatusCode;
  const responseStatus = responseRecord['status'];
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
