/**
 * Severity of the context gauge, from the used share of the window and the
 * window size.
 *
 * A pure percentage is late on big windows: on a 1M window 60% is 600K tokens,
 * long after the model's recall has degraded and just before auto-compaction
 * (85%). Each level therefore trips at the percentage OR at an absolute token
 * count, whichever comes first. On windows up to ~660K the percentage wins, so
 * a 200K/256K window behaves exactly as a plain percentage; with an unknown
 * window (size 0) only the percentage applies.
 */
export type ContextLevel = 'normal' | 'warning' | 'error';

export const CONTEXT_WARNING_PERCENT = 60;
export const CONTEXT_WARNING_TOKENS = 400_000;
export const CONTEXT_ERROR_PERCENT = 90;
export const CONTEXT_ERROR_TOKENS = 700_000;

function reaches(share: number, windowTokens: number, percent: number, tokens: number): boolean {
  const percentShare = percent / 100;
  const threshold =
    Number.isFinite(windowTokens) && windowTokens > 0
      ? Math.min(percentShare, tokens / windowTokens)
      : percentShare;
  return share >= threshold;
}

/** `share` is the used fraction (0–1); non-finite or negative reads as empty. */
export function contextLevel(share: number, windowTokens: number): ContextLevel {
  const used = Number.isFinite(share) && share > 0 ? share : 0;
  if (reaches(used, windowTokens, CONTEXT_ERROR_PERCENT, CONTEXT_ERROR_TOKENS)) return 'error';
  if (reaches(used, windowTokens, CONTEXT_WARNING_PERCENT, CONTEXT_WARNING_TOKENS)) return 'warning';
  return 'normal';
}
