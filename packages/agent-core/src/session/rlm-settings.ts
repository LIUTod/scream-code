/**
 * Canonical RLM recursion-cap validation, shared by every command surface:
 * the core setter (`Agent.setRlmMaxDepth`), the TUI `/rlm-max-depth` command
 * and the web REST route. Keeping it in one module means the surfaces cannot
 * drift — a value one surface accepts is exactly a value the others accept.
 */

/**
 * Normalizes a numeric max-depth into the core representation, where
 * `Infinity` means unlimited: non-positive or non-finite inputs are unlimited,
 * anything else is truncated to an integer.
 */
export function normalizeRlmMaxDepth(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Math.trunc(n);
}

export type RlmMaxDepthParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses a user-supplied `/rlm-max-depth` argument: a non-negative integer,
 * where `0` means unlimited. Empty strings, decimals, negatives, NaN and
 * non-numeric text are rejected with a human-readable reason.
 */
export function parseRlmMaxDepthArg(raw: string): RlmMaxDepthParseResult {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, reason: 'expected a non-negative integer (0 = unlimited)' };
  }
  if (!/^\d+$/.test(value)) {
    return { ok: false, reason: `"${value}" is not a non-negative integer (0 = unlimited)` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, reason: `"${value}" is too large` };
  }
  return { ok: true, value: parsed };
}
