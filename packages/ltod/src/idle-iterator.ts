import { APITimeoutError } from './errors';

/**
 * Idle-stream watchdog.
 *
 * Reasoning models (deepseek-reasoner, mimo thinking) can sit silent for
 * 30s+ between tokens; without a watchdog the stream hangs forever and the
 * user thinks the agent died. This wraps any async iterable with a per-item
 * idle deadline, turning a stalled stream into a retryable `APITimeoutError`.
 *
 * Deliberately narrow: no pre-response arming, no terminal grace iteration and
 * no per-provider env-var aliases. The core design — reuse one racer promise
 * across iterations (re-minted every 1024 races to bound retention) and
 * self-rearm a single timer per item — is all this needs.
 */

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_FIRST_ITEM_TIMEOUT_MS = 120_000;
const RACER_REMINT_INTERVAL = 1024;

function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function normalizeTimeoutMs(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

export function getStreamIdleTimeoutMs(fallback: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
  return normalizeTimeoutMs(process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'], fallback);
}

export function getStreamFirstItemTimeoutMs(
  idleTimeoutMs?: number,
  fallback: number = DEFAULT_STREAM_FIRST_ITEM_TIMEOUT_MS,
): number | undefined {
  const floor = idleTimeoutMs === undefined ? fallback : Math.max(fallback, idleTimeoutMs);
  return normalizeTimeoutMs(process.env['SCREAM_STREAM_FIRST_ITEM_TIMEOUT_MS'], floor);
}

/**
 * Thrown when the stream stalls longer than the configured idle deadline.
 * Extends `APITimeoutError` so `isRetryableGenerateError` picks it up
 * automatically — the agent retries instead of dying.
 */
export class StreamIdleTimeoutError extends APITimeoutError {
  readonly phase: 'first-item' | 'idle';

  constructor(phase: 'first-item' | 'idle', message: string) {
    super(message);
    this.name = 'StreamIdleTimeoutError';
    this.phase = phase;
  }
}

export interface IdleTimeoutIteratorOptions {
  /** Max gap between progress items once streaming has started. */
  idleTimeoutMs?: number;
  /** Max wait for the first progress item (can be longer than idle). */
  firstItemTimeoutMs?: number;
  /** Message used when the idle (post-first-item) deadline fires. */
  errorMessage: string;
  /** Message used when the first-item deadline fires. Defaults to errorMessage. */
  firstItemErrorMessage?: string;
  /**
   * Optional semantic-progress predicate. Non-progress items are still yielded,
   * but they do not reset the idle deadline. Prevents provider keepalive/no-op
   * events from keeping a stalled stream alive forever.
   */
  isProgressItem?: (item: unknown) => boolean;
  /** Cancel iteration as soon as this signal aborts (ESC / caller abort). */
  abortSignal?: AbortSignal;
}

/**
 * Yields items from an async iterable while enforcing a maximum idle gap.
 *
 * The first item may use a longer timeout (reasoning models can take 60s+ to
 * emit the first token); subsequent gaps use the shorter idle timeout.
 */
export async function* iterateWithIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  options: IdleTimeoutIteratorOptions,
): AsyncGenerator<T> {
  const firstItemTimeoutMs = options.firstItemTimeoutMs ?? options.idleTimeoutMs;
  const firstItemDeadlineMs =
    firstItemTimeoutMs !== undefined && firstItemTimeoutMs > 0 ? Date.now() + firstItemTimeoutMs : undefined;
  const abortSignal = options.abortSignal;
  const iterator = iterable[Symbol.asyncIterator]();
  let iteratorClosed = false;

  const closeIterator = (): void => {
    if (iteratorClosed) return;
    iteratorClosed = true;
    const returnPromise = iterator.return?.();
    if (returnPromise) {
      void returnPromise.catch(() => {});
    }
  };

  if (abortSignal?.aborted) {
    closeIterator();
    throw abortReason(abortSignal);
  }

  const withRacy = <U>(promise: Promise<U>) =>
    promise.then(
      (result) => ({ kind: 'next' as const, result }),
      (error) => ({ kind: 'error' as const, error }),
    );

  let awaitingFirstItem = true;
  const isProgressItem = (item: T): boolean => {
    if (!options.isProgressItem) return true;
    try {
      return options.isProgressItem(item);
    } catch {
      return true;
    }
  };
  let lastProgressAt = Date.now();

  const noTimeoutEnforced =
    (firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
    (options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0);

  // Persistent racers hoisted out of the per-item loop. The abort promise can
  // only resolve once (abort latches), and a timeout resolution always precedes
  // a throw — so neither needs per-item re-creation. Re-minted every
  // RACER_REMINT_INTERVAL iterations to bound reaction-record retention.
  let abortPromise: Promise<{ kind: 'abort' }> | undefined;
  let abortListener: (() => void) | undefined;
  let resolveAbort: ((value: { kind: 'abort' }) => void) | undefined;
  if (abortSignal) {
    const { promise, resolve } = withResolvers<{ kind: 'abort' }>();
    resolveAbort = resolve;
    abortListener = () => resolveAbort?.({ kind: 'abort' });
    abortSignal.addEventListener('abort', abortListener, { once: true });
    abortPromise = promise;
  }

  let timeoutPromise: Promise<{ kind: 'timeout' }> | undefined;
  let resolveTimeout: ((value: { kind: 'timeout' }) => void) | undefined;
  let timeoutFired = false;
  let timer: NodeJS.Timeout | undefined;
  let timerFireAtMs = Infinity;

  const currentDeadlineMs = (): number | undefined => {
    if (awaitingFirstItem) return firstItemDeadlineMs;
    if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
      return lastProgressAt + options.idleTimeoutMs;
    }
    return undefined;
  };
  const onTimerFire = (): void => {
    timer = undefined;
    timerFireAtMs = Infinity;
    const deadlineMs = currentDeadlineMs();
    if (deadlineMs === undefined) return;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs > 0) {
      timerFireAtMs = deadlineMs;
      timer = setTimeout(onTimerFire, remainingMs);
      return;
    }
    timeoutFired = true;
    resolveTimeout?.({ kind: 'timeout' });
  };
  const armTimer = (deadlineMs: number): void => {
    if (timeoutPromise === undefined || timeoutFired) {
      const { promise, resolve } = withResolvers<{ kind: 'timeout' }>();
      timeoutPromise = promise;
      resolveTimeout = resolve;
      timeoutFired = false;
    }
    if (timer !== undefined) {
      if (timerFireAtMs <= deadlineMs) return;
      clearTimeout(timer);
    }
    timerFireAtMs = deadlineMs;
    timer = setTimeout(onTimerFire, Math.max(0, deadlineMs - Date.now()));
  };

  try {
    let raceCount = 0;
    while (true) {
      if (++raceCount % RACER_REMINT_INTERVAL === 0) {
        if (abortPromise !== undefined && !abortSignal!.aborted) {
          const { promise, resolve } = withResolvers<{ kind: 'abort' }>();
          resolveAbort = resolve;
          abortPromise = promise;
        }
        if (timeoutPromise !== undefined && !timeoutFired) {
          const { promise, resolve } = withResolvers<{ kind: 'timeout' }>();
          resolveTimeout = resolve;
          timeoutPromise = promise;
        }
      }
      let activeTimeoutMs: number | undefined;
      if (awaitingFirstItem) {
        if (firstItemDeadlineMs !== undefined) {
          activeTimeoutMs = firstItemDeadlineMs - Date.now();
          if (activeTimeoutMs <= 0) {
            closeIterator();
            throw new StreamIdleTimeoutError('first-item', options.firstItemErrorMessage ?? options.errorMessage);
          }
        }
      } else if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
        activeTimeoutMs = options.idleTimeoutMs - (Date.now() - lastProgressAt);
        if (activeTimeoutMs <= 0) {
          closeIterator();
          throw new StreamIdleTimeoutError('idle', options.errorMessage);
        }
      }

      const nextResultPromise = withRacy(iterator.next());

      const racers: Array<
        Promise<
          | { kind: 'next'; result: IteratorResult<T> }
          | { kind: 'error'; error: unknown }
          | { kind: 'timeout' }
          | { kind: 'abort' }
        >
      > = [nextResultPromise];

      const enforceTimeout = !noTimeoutEnforced && activeTimeoutMs !== undefined && activeTimeoutMs > 0;
      if (enforceTimeout && activeTimeoutMs !== undefined) {
        armTimer(Date.now() + activeTimeoutMs);
        racers.push(timeoutPromise!);
      }
      if (abortPromise) {
        racers.push(abortPromise);
      }

      let continuing = false;
      try {
        const outcome = await Promise.race(racers);
        if (outcome.kind === 'abort') {
          closeIterator();
          throw abortReason(abortSignal!);
        }
        if (outcome.kind === 'timeout') {
          closeIterator();
          throw new StreamIdleTimeoutError(
            !awaitingFirstItem ? 'idle' : 'first-item',
            !awaitingFirstItem ? options.errorMessage : (options.firstItemErrorMessage ?? options.errorMessage),
          );
        }
        if (outcome.kind === 'error') {
          throw outcome.error;
        }
        if (outcome.result.done) {
          awaitingFirstItem = false;
          return;
        }
        const item = outcome.result.value;
        if (isProgressItem(item)) {
          awaitingFirstItem = false;
          lastProgressAt = Date.now();
        }
        yield item;
        continuing = true;
      } finally {
        if (!continuing) closeIterator();
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    resolveTimeout?.({ kind: 'timeout' });
    if (abortListener && abortSignal) {
      abortSignal.removeEventListener('abort', abortListener);
    }
    resolveAbort?.({ kind: 'abort' });
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  return new Error('Request was aborted');
}
