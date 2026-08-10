/**
 * /snaptimer — Toggle the per-turn session snapshot timer (the elapsed marker
 * stamped after each assistant reply). State is persisted to
 * ui-preferences.json, so it survives restarts.
 */

import { t } from '@scream-code/config';

import { toggleTurnElapsed } from '../utils/ui-preferences';
import type { SlashCommandHost } from './dispatch';

export async function handleSnapTimerCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const enabled = toggleTurnElapsed();
  const status = enabled ? t('snaptimer.enabled') : t('snaptimer.disabled');
  host.showStatus(status, enabled ? host.state.theme.colors.success : host.state.theme.colors.textDim);
}
