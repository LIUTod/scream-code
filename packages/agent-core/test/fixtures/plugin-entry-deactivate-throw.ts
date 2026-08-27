import type { ExtensionContext } from '#/plugin';

export function activate(context: ExtensionContext): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__pluginActivated = context.pluginId;
}

export function deactivate(): void {
  throw new Error('deactivate boom');
}
