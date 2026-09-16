/**
 * /codebg — Toggle the background panel behind fenced code blocks.
 *
 * On (default): each code line is painted as a full-width band, which separates
 * code from prose at a glance. Off: the band disappears and code is set apart by
 * its own colour, the one-cell gutter and the language label only.
 * Persisted to ui-preferences.json, so it survives restarts.
 */

import { t } from '@scream-code/config';

import { toggleCodeBlockPanel } from '../utils/ui-preferences';
import { repaintTranscript } from '../utils/transcript-repaint';

import type { SlashCommandHost } from './dispatch';

export async function handleCodeBgCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const enabled = toggleCodeBlockPanel();
  host.showStatus(
    enabled ? t('codebg.enabled') : t('codebg.disabled'),
    enabled ? host.state.theme.colors.success : host.state.theme.colors.textDim,
  );
  // Code blocks already on screen cached their rows in the old mode.
  repaintTranscript(host);
}
