/**
 * /hl — Toggle the user-message highlight background block. When enabled,
 * user messages render with a background block tinted by the roleUser theme
 * color; when disabled they fall back to the default (no background).
 * State is persisted to ui-preferences.json, so it survives restarts.
 */

import { t } from '@scream-code/config';

import { toggleUserMessageHighlight } from '../utils/ui-preferences';
import type { SlashCommandHost } from './dispatch';

export async function handleHighlightCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const enabled = toggleUserMessageHighlight();
  const status = enabled ? t('hl.enabled') : t('hl.disabled');
  host.showStatus(status, enabled ? host.state.theme.colors.success : host.state.theme.colors.textDim);
  // Re-render immediately so already-rendered user messages pick up the new
  // toggle (UserMessageComponent cache is keyed by toggle state).
  host.state.ui.requestRender();
}
