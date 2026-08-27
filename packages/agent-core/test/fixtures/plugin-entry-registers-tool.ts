import type { ExtensionContext } from '#/plugin';

/**
 * Fixture plugin for the tool-ownership tests: registers a tool WITHOUT
 * declaring an owner. The activation services view is expected to stamp the
 * plugin id onto the registration so teardown paths can find the tool later.
 */
export function activate(context: ExtensionContext): void {
  context.services.tools.registerUserTool({
    name: 'fixture_owned_tool',
    description: 'Tool registered by the ownership fixture.',
    parameters: {},
    execute: async () => ({ output: 'owned-ok' }),
  });
}

export function deactivate(): void {
  // Nothing to unwind: the host reclaims the owned tool on deactivate.
}
