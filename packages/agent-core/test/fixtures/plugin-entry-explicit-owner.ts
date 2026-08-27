import type { ExtensionContext } from '#/plugin';

/**
 * Fixture plugin that declares its own ownerPluginId. The activation view
 * must let an explicit owner win over the automatic stamp.
 */
export function activate(context: ExtensionContext): void {
  context.services.tools.registerUserTool({
    name: 'fixture_explicit_owner',
    description: 'Tool with a self-declared owner.',
    parameters: {},
    ownerPluginId: 'declared-owner',
    execute: async () => ({ output: 'explicit-ok' }),
  });
}

export function deactivate(): void {
  // Nothing to unwind.
}
