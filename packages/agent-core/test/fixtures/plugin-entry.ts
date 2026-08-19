import type { ExtensionContext } from '#/plugin';

export function activate(context: ExtensionContext): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__pluginActivated = context.pluginId;
  (globalThis as any).__pluginHasConfig = context.config !== undefined;
}

export function deactivate(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__pluginDeactivated = true;
}
