/**
 * Per-source request pacing for the paper search APIs.
 *
 * Every source owns a throttle: requests to the same host are serialised
 * (single flight) and separated by a minimum interval. arXiv's API terms
 * require 3 seconds between requests from one client and a single connection;
 * the remaining sources are polite-use APIs with no published minimum. Pacing
 * is therefore a compliance requirement, not a performance tweak.
 */

/** Conservative default for sources without a published minimum. */
export const DEFAULT_SOURCE_INTERVAL_MS = 1_000;

/** arXiv API terms: at least 3 seconds between requests, one connection. */
export const ARXIV_SOURCE_INTERVAL_MS = 3_000;

export interface SourceThrottle {
  /** Resolves once the caller may issue its request. */
  acquire(): Promise<void>;
  /** Epoch ms at which the next request may start (diagnostics and tests). */
  nextAllowedAt(): number;
}

export interface SourceThrottleDeps {
  /** Injectable clock (tests). */
  clock?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createSourceThrottle(
  minIntervalMs: number = DEFAULT_SOURCE_INTERVAL_MS,
  deps: SourceThrottleDeps = {},
): SourceThrottle {
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  return {
    acquire(): Promise<void> {
      const turn = tail.then(async () => {
        const remaining = minIntervalMs - (clock() - lastStartedAt);
        if (remaining > 0) await sleep(remaining);
        lastStartedAt = clock();
      });
      // The queue must survive a failing waiter: a caller that aborts mid-wait
      // must never wedge every later request to this source.
      tail = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    },
    nextAllowedAt(): number {
      return lastStartedAt + minIntervalMs;
    },
  };
}
