import { grandTotal, type TokenUsage } from '@scream-code/ltod';

import type { TokenCapState } from '../../loop';

export type { TokenCapState };

/** A session's token usage against its limit; `limitTokens` is null when no limit is set. */
export interface SessionTokenBudget {
  readonly usedTokens: number;
  readonly limitTokens: number | null;
}

export interface SessionTokenMeterOptions {
  /** Initial cap in tokens (`loop_control.max_session_tokens`); unset or 0 = no cap. */
  readonly limitTokens?: number | undefined;
}

/**
 * Session-wide token meter behind `loop_control.max_session_tokens`.
 *
 * Why tokens and not dollars: a price needs a catalog entry, and custom
 * providers / self-hosted models have none — a dollar cap would silently count
 * them as free and never trip. A token count exists for every model.
 *
 * What counts: `grandTotal` — input (cache reads and cache writes included) plus
 * output, i.e. exactly the "total" `/usage` and the `/goal` token budget show,
 * so the number the cap compares against is a number the user can read off.
 *
 * One instance per `Session`, shared by every agent in it: the main agent, each
 * subagent (running concurrently or not), compaction and the cache warmer all add
 * to it the moment a response's usage is recorded. That is the point of metering
 * at record time instead of reading the main agent's totals — a subagent's usage
 * only folds into its parent when it finishes, so ten children burning in
 * parallel would be invisible until the end.
 *
 * Only fresh usage is added (`UsageRecorder.record` with source `fresh`): a
 * subagent fold re-records usage already metered when the child recorded it, and
 * a resume replays historical records. The cap therefore counts what this run of
 * the session has used, not the session's lifetime total — resuming starts a new
 * allowance, and a long-lived session is not blocked on resume by yesterday's work.
 *
 * The limit is mutable on purpose: `/budget` changes it on the live session, so
 * raising it clears a tripped cap immediately instead of requiring a restart.
 */
export class SessionTokenMeter {
  private used = 0;
  private limit: number | undefined;

  constructor(options: SessionTokenMeterOptions = {}) {
    this.limit = normalizeLimit(options.limitTokens);
  }

  /** Add one fresh response's usage. */
  record(usage: TokenUsage): void {
    const tokens = grandTotal(usage);
    // Provider-supplied numbers: one NaN would make `used < limit` false forever
    // and trip the cap permanently, so only finite positive amounts are added.
    if (Number.isFinite(tokens) && tokens > 0) this.used += tokens;
  }

  /** Tokens used by this run of the session (cap-relevant usage only). */
  get usedTokens(): number {
    return this.used;
  }

  /** The active cap, or undefined when none is set. */
  get limitTokens(): number | undefined {
    return this.limit;
  }

  /** Replace the cap; `undefined` (or anything not a positive number) turns it off. */
  setLimit(limitTokens: number | undefined): void {
    this.limit = normalizeLimit(limitTokens);
  }

  /** The cap state once usage has reached it; undefined while under or off. */
  exhausted(): TokenCapState | undefined {
    if (this.limit === undefined || this.used < this.limit) return undefined;
    return { usedTokens: this.used, limitTokens: this.limit };
  }
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return limit !== undefined && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : undefined;
}
