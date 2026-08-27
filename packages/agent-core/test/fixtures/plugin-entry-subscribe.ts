import type { ExtensionContext } from '#/plugin';

/** Subscribes to the event bus and then activates cleanly (no throw). */
export function activate(context: ExtensionContext): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__pluginActivated = context.pluginId;
  context.events.subscribe('turn.started', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits: number = (globalThis as any).__liveSubscriptionHits ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__liveSubscriptionHits = hits + 1;
  });
}
