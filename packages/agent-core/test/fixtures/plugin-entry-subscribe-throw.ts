import type { ExtensionContext } from '#/plugin';

/**
 * Leaks an event subscription and then fails: the runtime must release the
 * subscription it recorded during this activation.
 */
export function activate(context: ExtensionContext): void {
  context.events.subscribe('turn.started', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits: number = (globalThis as any).__leakedSubscriptionHits ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__leakedSubscriptionHits = hits + 1;
  });
  throw new Error('subscribe-then-boom');
}
