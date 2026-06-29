/**
 * Storm Breaker anomaly detection for auto-compaction.
 *
 * Pure function — no side effects, no host dependency. Unit-tested in
 * test/tui/compaction-anomaly.test.ts.
 */

export interface CompactionAnomalyInput {
  /** Wall-clock time (ms) of the most recent compaction completion, or undefined. */
  readonly lastFinishedAt: number | undefined;
  /** How many auto-compactions have fired in this session so far (before this one). */
  readonly autoCompactionCount: number;
  /** Live context token count at the moment the new compaction began. */
  readonly currentTokens: number;
  /** Max context window size for the active model. */
  readonly maxContextTokens: number;
  /** Wall-clock time (ms) when the new compaction began. */
  readonly now: number;
}

export interface CompactionAnomalyResult {
  readonly kind: 'rapid_refire' | 'first_step_blowup';
  readonly detail: string;
}

/** Rapid-refire window: < 30s between end of previous compaction and start of next. */
const RAPID_REFIRE_MS = 30_000;
/** First-step-blowup: ratio of current tokens to window when first auto-compaction fires. */
const FIRST_STEP_BLOWUP_RATIO = 0.7;

/**
 * Inspects one auto-compaction start for pathological patterns. Returns `null`
 * when the compaction looks routine.
 *
 * Two signals:
 * - `rapid_refire`: previous auto-compaction finished < 30s ago — model is likely
 *   emitting a runaway stream or looping on a tool that explodes context.
 * - `first_step_blowup`: very first auto-compaction of the session, and context
 *   is already above 70% — likely a giant system prompt, a huge file read, or
 *   similar one-shot inflation.
 */
export function detectCompactionAnomaly(
  input: CompactionAnomalyInput,
): CompactionAnomalyResult | null {
  // rapid_refire: previous auto-compaction ended recently.
  if (input.lastFinishedAt !== undefined) {
    const elapsed = input.now - input.lastFinishedAt;
    if (elapsed >= 0 && elapsed < RAPID_REFIRE_MS) {
      return {
        kind: 'rapid_refire',
        detail: `上次压缩结束仅 ${(elapsed / 1000).toFixed(1)} 秒后再次触发自动压缩。`,
      };
    }
  }

  // first_step_blowup: first auto-compaction, context already above 70%.
  if (input.autoCompactionCount === 0 && input.maxContextTokens > 0) {
    const ratio = input.currentTokens / input.maxContextTokens;
    if (ratio >= FIRST_STEP_BLOWUP_RATIO) {
      const pct = (ratio * 100).toFixed(0);
      return {
        kind: 'first_step_blowup',
        detail: `会话首次自动压缩时上下文已达 ${pct}%，可能存在巨型文件读取或初始 prompt 过大。`,
      };
    }
  }

  return null;
}
