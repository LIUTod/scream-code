import type { ExtensionContext } from '#/plugin';

/**
 * Fixture whose event handler throws on every delivery. The circuit path
 * must deactivate the plugin after the trip threshold, without the bus or
 * the loop ever seeing the throw.
 */
export function activate(context: ExtensionContext): void {
  context.events.subscribe('turn.started', () => {
    const g = globalThis as Record<string, unknown>;
    g['__faultyHandlerHits'] = ((g['__faultyHandlerHits'] as number | undefined) ?? 0) + 1;
    throw new Error('handler boom');
  });
}

export function deactivate(): void {
  (globalThis as Record<string, unknown>)['__faultyHandlerDeactivated'] = true;
}
