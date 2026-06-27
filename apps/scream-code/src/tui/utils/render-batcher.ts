/**
 * Coalesces TUI render requests to avoid redundant frames.
 *
 * pi-tui already deduplicates plain `requestRender()` calls within a single
 * event tick, but it does not coalesce mixed force/non-force calls and it has
 * no notion of explicit batch boundaries. This layer adds both:
 *
 * 1. Microtask coalescing: multiple `requestRender()` calls in the same
 *    microtask are collapsed into one underlying call.
 * 2. `batchUpdate()`: inside a batch, render requests are suppressed and a
 *    single force render is scheduled when the batch ends.
 */

export interface RenderBatchController {
  /** Queue a render, coalesced with any other requests in this microtask. */
  requestRender(force?: boolean): void;

  /**
   * Execute `fn` without rendering; a single force render is queued when the
   * outermost batch completes. Nested batches are supported and only render
   * once at the end of the outermost batch.
   */
  batchUpdate<T>(fn: () => T): T;
}

export function createRenderBatcher(
  doRender: (force: boolean) => void,
): RenderBatchController {
  let scheduled = false;
  let pendingForce = false;
  let batchDepth = 0;
  let batchNeedsRender = false;

  const scheduleRender = (force: boolean): void => {
    pendingForce ||= force;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const renderForce = pendingForce;
      pendingForce = false;
      doRender(renderForce);
    });
  };

  return {
    requestRender(force = false): void {
      if (batchDepth > 0) {
        batchNeedsRender = true;
        return;
      }
      scheduleRender(force);
    },

    batchUpdate<T>(fn: () => T): T {
      batchDepth++;
      try {
        return fn();
      } finally {
        batchDepth--;
        if (batchDepth === 0 && batchNeedsRender) {
          batchNeedsRender = false;
          scheduleRender(true);
        }
      }
    },
  };
}
