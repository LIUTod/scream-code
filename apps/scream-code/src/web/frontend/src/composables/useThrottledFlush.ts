/**
 * Coalesces rapid mutations into a single flush per animation frame.
 *
 * WebSocket stream chunks arrive as separate macrotasks; without coalescing
 * each chunk triggers a full Vue render flush (Vue's microtask batching
 * cannot span macrotasks). rAF coalescing bounds streaming updates to at most
 * one flush per frame while staying perfectly smooth.
 */
export function useThrottledFlush(flush: () => void): {
  /** Schedule a flush on the next animation frame (coalesced). */
  schedule: () => void;
  /** Cancel any pending frame and flush immediately (used at turn end). */
  flushNow: () => void;
  /** Cancel any pending frame without flushing (used on unmount). */
  dispose: () => void;
} {
  let rafId: number | null = null;

  const schedule = (): void => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      flush();
    });
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
