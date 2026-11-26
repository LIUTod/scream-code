/**
 * /hl — Toggle the faint band behind user messages (on by default; see
 * `UserMessageComponent`). Off, a message keeps only its ■ mark and the user
 * colour. State is persisted to ui-preferences.json, so it survives restarts.
 */

import { t } from '@scream-code/config';

import { toggleUserMessageHighlight } from '../utils/ui-preferences';
import { flashStatus } from '../utils/flash-status';
import type { SlashCommandHost } from './dispatch';

export async function handleHighlightCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const enabled = toggleUserMessageHighlight();
  const status = enabled ? t('hl.enabled') : t('hl.disabled');
  flashStatus(host, status, enabled ? host.state.theme.colors.success : host.state.theme.colors.textDim);
  // Re-render immediately so already-rendered user messages pick up the new
  // toggle (UserMessageComponent's cache is keyed by it).
  host.state.ui.requestRender();
}
