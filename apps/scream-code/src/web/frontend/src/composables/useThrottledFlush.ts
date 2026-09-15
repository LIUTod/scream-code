/**
 * Coalesces rapid mutations into a single flush per animation frame.
 *
 * WebSocket stream chunks arrive as separate macrotasks; without coalescing
 * each chunk triggers a full Vue render flush (Vue's microtask batching
 * cannot span macrotasks). rAF coalescing bounds streaming updates to at most
 * one flush per frame while staying perfectly smooth.
 *
 * Chained across THREE paint opportunities (~50ms): high-frequency token
 * deltas merge into one snapshot batch, and each batch skips up to two
 * intermediate vnode rebuilds. 50ms sits under the perception threshold for
 * streaming text, so the saving is free.
 */
export function useThrottledFlush(flush: () => void): {
  /** Schedule a flush three animation frames out (coalesced). */
  schedule: () => void;
  /** Cancel any pending frame and flush immediately (used at turn end). */
  flushNow: () => void;
  /** Cancel any pending frame without flushing (used on unmount). */
  dispose: () => void;
} {
  let rafId: number | null = null;

  const schedule = (): void => {
    if (rafId !== null) return;
    // Cross three paint opportunities before publishing the batch.
    const step = (remaining: number): void => {
      if (remaining <= 0) {
        rafId = null;
        flush();
        return;
      }
      rafId = requestAnimationFrame(() => step(remaining - 1));
    };
    rafId = requestAnimationFrame(() => step(2));
  };

  const flushNow = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flush();
  };

  const dispose = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  return { schedule, flushNow, dispose };
}
