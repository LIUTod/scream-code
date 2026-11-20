import type { PermissionMode } from '@scream-code/scream-code-sdk';

/**
 * Single source of truth for how a permission mode is spelled in the UI.
 *
 * The editor badge, `/status` and the mode picker all render through here so a
 * mode never shows as its raw id (`yolo`) in one place and as `YES` in another.
 * The names are the same English words in every interface language — they
 * are what the person types (`/auto`, `/yes`, `/bot`, `/ask`), so they are
 * names, not prose to translate.
 */
const MODE_LABELS: Readonly<Record<PermissionMode, string>> = {
  auto: 'AUTO',
  yolo: 'YES',
  bot: 'BOT',
  ask: 'ASK',
};

export function permissionModeLabel(mode: PermissionMode): string {
  return MODE_LABELS[mode];
}
