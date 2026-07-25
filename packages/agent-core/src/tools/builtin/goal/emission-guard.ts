/**
 * Grader emission guard - deduplicates and filters grader (referee) feedback
 * before it is injected into the agent context.
 *
 * Without this guard, a grader that repeatedly returns the same FAIL reason
 * (e.g. "redo", "not right") causes the identical feedback to be appended to
 * context on every submission. This wastes context budget and can trap the
 * agent in a loop where it keeps retrying without new information.
 *
 * Inspired by oh-my-pi's `advisor/emission-guard.ts`, but adapted for
 * scream-code's grader model: the grader is called once per `complete`
 * submission (not continuously), so per-round limiting is unnecessary. The
 * guard focuses on normalization, content-free filtering, and exact-text
 * deduplication keyed by goal objective.
 */

/** Short phrases that carry no actionable feedback. */
const CONTENT_FREE_PHRASES = new Set([
  // English
  'stop', 'done', 'lgtm', 'no issue', 'redo', 'try again',
  'not good enough', 'fix it', 'wrong', 'incorrect', 'bad',
  // Chinese
  '重做', '不对', '不行', '继续', '再做', '错误', '不行', '不好', '改',
]);

/** Maximum number of historically seen feedback texts retained per goal. */
const MAX_SEEN_PER_GOAL = 16;

/** Phrases at or below this length are checked against the content-free set. */
function isContentFree(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return CONTENT_FREE_PHRASES.has(lower);
}

/**
 * Filters grader feedback before injection into the agent context.
 *
 * Returns the denoised feedback text if it should be injected, or `null` if
 * the feedback is empty, content-free, or an exact duplicate of a previously
 * seen feedback for the same goal. The caller should skip injection when
 * `null` is returned.
 *
 * @param reason The raw grader FAIL reason.
 * @param goalKey A stable identifier for the current goal (e.g. the objective
 *   text). Different goals get independent deduplication buckets.
 */
export class GraderEmissionGuard {
  private readonly seenByGoal = new Map<string, string[]>();

  filter(reason: string, goalKey: string): string | null {
    // 1. NFKC normalization (collates visually-identical strings).
    const normalized = reason.normalize('NFKC').trim();
    if (normalized.length === 0) return null;

    // 2. Content-free blacklist (short, non-actionable phrases).
    if (isContentFree(normalized)) return null;

    // 3. Exact-text deduplication (FIFO, per-goal bucket).
    const key = normalized.toLowerCase();
    const bucket = this.seenByGoal.get(goalKey);
    if (bucket !== undefined && bucket.includes(key)) return null;

    // Record for future dedup.
    const next = bucket ?? [];
    next.push(key);
    if (next.length > MAX_SEEN_PER_GOAL) next.shift();
    this.seenByGoal.set(goalKey, next);

    return normalized;
  }

  /** Clear the deduplication bucket for a goal (e.g. on goal change). */
  resetGoal(goalKey: string): void {
    this.seenByGoal.delete(goalKey);
  }
}
