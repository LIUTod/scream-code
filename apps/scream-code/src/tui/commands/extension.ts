import { t } from '@scream-code/config';
import type { SlashCommandHost } from './dispatch';

/**
 * /extension activate|deactivate|status [pluginId]
 *
 * Activates and deactivates code-entry plugins (manifests that declare an
 * `entryPoint`) on the session's main agent, or lists them with their
 * activation state. Activation is lazy and isolated: a failing extension never
 * breaks the agent.
 */
export async function handleExtensionCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError(t('extension.no_session'));
    return;
  }
  const [action, ...rest] = args.trim().split(/\s+/);
  const pluginId = rest.join(' ').trim();
  // Bare `/extension` (no subcommand) lists code plugins instead of erroring.
  const effectiveAction = action === '' || action === undefined ? 'status' : action;
  switch (effectiveAction) {
    case 'activate':
      if (!pluginId) {
        host.showError(t('extension.missing_id', { action: 'activate' }));
        return;
      }
      try {
        await session.activatePlugin(pluginId);
        host.showStatus(t('extension.activated', { pluginId }));
      } catch (error) {
        host.showError(getErrorMessage(error));
      }
      return;
    case 'deactivate':
      if (!pluginId) {
        host.showError(t('extension.missing_id', { action: 'deactivate' }));
        return;
      }
      try {
        await session.deactivatePlugin(pluginId);
        host.showStatus(t('extension.deactivated', { pluginId }));
      } catch (error) {
        host.showError(getErrorMessage(error));
      }
      return;
    case 'status': {
      try {
        const extensions = await session.pluginExtensionStatus();
        if (extensions.length === 0) {
          host.showStatus(t('extension.no_extensions'));
          return;
        }
        for (const ext of extensions) {
          host.showStatus(`${ext.active ? '●' : '○'} ${ext.pluginId}`);
        }
      } catch (error) {
        host.showError(getErrorMessage(error));
      }
      return;
    }
    default:
      host.showError(t('extension.usage'));
  }
}

function getErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  return String((error as { message?: unknown })?.message ?? error);
}