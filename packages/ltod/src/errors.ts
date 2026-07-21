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

  constructor(message: string, requestId?: string | null, reason?: RateLimitReason) {
    super(429, message, requestId);
    this.name = 'APIProviderRateLimitError';
    this.reason = reason ?? 'UNKNOWN';
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
    // Quota exhaustion won't clear in the retry window — retrying just wastes
    // attempts. Fail fast so the user sees "switch credential" instead of
    // three 30-min backoffs.
    return error.reason !== 'QUOTA_EXHAUSTED';
  }
  return error instanceof APIStatusError && [429, 500, 502, 503, 504].includes(error.statusCode);
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
): APIStatusError {
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, parseRateLimitReason(message));
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId);
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
