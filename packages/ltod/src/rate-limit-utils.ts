/**
 * Rate limit reason classification and backoff calculation.
 *
 * Ported from oh-my-pi `packages/ai/src/rate-limit-utils.ts` (107 lines).
 * Different rate-limit causes need different backoff strategies: a quota-exhausted
 * account won't recover in 30s, and a transient 529 won't need 30min. Classifying
 * by error message text lets us pick the right backoff without provider-specific
 * error code tables.
 */

export type RateLimitReason =
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'MODEL_CAPACITY_EXHAUSTED'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // 0-30s jitter, total 45-75s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
  /\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;

/**
 * Classify a rate-limit error message into a reason category.
 *
 * Priority: QUOTA (explicit "quota will reset") > MODEL_CAPACITY > QUOTA (account)
 * > RATE_LIMIT > QUOTA (generic) > SERVER_ERROR > UNKNOWN.
 *
 * "quota will reset" / "exhausted your capacity" short-circuits to QUOTA before
 * the MODEL_CAPACITY fallthrough — the word "capacity" appears in both but the
 * long-wait signal means credential rotation, not a 60s backoff.
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
  const lower = errorMessage.toLowerCase();

  if (lower.includes('quota will reset') || lower.includes('exhausted your capacity')) {
    return 'QUOTA_EXHAUSTED';
  }

  if (
    lower.includes('capacity') ||
    lower.includes('overloaded') ||
    lower.includes('529') ||
    lower.includes('503') ||
    lower.includes('resource exhausted')
  ) {
    return 'MODEL_CAPACITY_EXHAUSTED';
  }

  if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
    return 'QUOTA_EXHAUSTED';
  }

  if (
    lower.includes('per minute') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    return 'RATE_LIMIT_EXCEEDED';
  }

  if (
    lower.includes('exhausted') ||
    lower.includes('quota') ||
    lower.includes('usage limit') ||
    INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
  ) {
    return 'QUOTA_EXHAUSTED';
  }

  if (lower.includes('500') || lower.includes('internal error') || lower.includes('internal server error')) {
    return 'SERVER_ERROR';
  }

  return 'UNKNOWN';
}

/**
 * Backoff in ms for a given reason. MODEL_CAPACITY gets jitter to avoid
 * thundering herd. UNKNOWN (a classified 429 with no recognized reason)
 * uses the short 20s SERVER_ERROR backoff — a 30min x ~9 attempt hang
 * would be far worse than a failed turn, and UNKNOWN is not evidence of
 * quota exhaustion.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
  switch (reason) {
    case 'QUOTA_EXHAUSTED':
      return QUOTA_EXHAUSTED_BACKOFF_MS;
    case 'RATE_LIMIT_EXCEEDED':
      return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
    case 'MODEL_CAPACITY_EXHAUSTED':
      return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
    case 'SERVER_ERROR':
      return SERVER_ERROR_BACKOFF_MS;
    default:
      // UNKNOWN: a classified 429 with no recognized reason. Keep the retry
      // short (20s like SERVER_ERROR) instead of the 30min quota backoff —
      // 30min x ~9 attempts would hang a turn for hours, and UNKNOWN is not
      // evidence of quota exhaustion.
      return SERVER_ERROR_BACKOFF_MS;
  }
}

/** Persistent usage/quota errors that require credential switch, not retry. */
const USAGE_LIMIT_PATTERN =
  /usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?exceeded|quota.?reached|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?balance/i;

export function isUsageLimitError(errorMessage: string): boolean {
  return USAGE_LIMIT_PATTERN.test(errorMessage) || ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage);
}
