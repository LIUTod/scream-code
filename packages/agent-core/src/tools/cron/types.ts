/**
 * Persistent representation of a cron task.
 *
 *   - `id` — 8-hex; jitter is keyed off this hash, so stable id == stable
 *     jitter across schedule rewrites.
 *   - `cron` — 5-field expression, evaluated in local time.
 *   - `createdAt` — wall-clock epoch ms at original scheduling. NOT updated
 *     when the scheduler fires; recurring uses it as the baseline floor
 *     when no `lastFiredAt` has been recorded. Also the input to the
 *     7-day stale judgment.
 *   - `recurring` — undefined / true means "fire repeatedly until deleted
 *     or auto-expired"; false means "fire once then auto-delete".
 *   - `lastFiredAt` — wall-clock epoch ms of the last ideal occurrence
 *     whose jittered delivery has actually completed. Persisted so a
 *     `scream resume` does not replay already-delivered recurring fires:
 *     without it, the scheduler would fall back to `createdAt` and
 *     coalesce yesterday's already-fired 09:00 into today's tick. A
 *     value greater than the current wall clock is treated as corrupt
 *     and the scheduler falls back to `createdAt` for that task.
 *   - `silent` — suppress the "task fired" notice on the delivery side; the
 *     result still goes out. A five-minute task would otherwise announce
 *     itself every five minutes.
 *   - `mute` — suppress *everything*: notice and result. For maintenance
 *     runs whose value is the side effect, not the transcript.
 *   - `lastError` — outcome of the most recent delivery, so a list command can
 *     answer "did it work?" without a log grep. Cleared by the next clean run;
 *     `lastFiredAt` already answers "when did it last run?".
 */
export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly recurring?: boolean;
  readonly lastFiredAt?: number;
  readonly silent?: boolean;
  readonly mute?: boolean;
  readonly lastError?: string | null;
}
