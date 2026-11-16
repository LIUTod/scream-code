import type { PermissionMode } from '@scream-code/scream-code-sdk';

import { t } from '@scream-code/config';

/**
 * Single source of truth for how a permission mode is spelled in the UI.
 *
 * The editor badge, `/status` and the mode picker all render through here so a
 * mode never shows as its raw id (`yolo`) in one place and as `YES` in another.
 */
export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return t('permission.auto');
    case 'yolo':
      return t('badge.yes');
    case 'bot':
      return t('badge.bot');
    case 'ask':
      return t('badge.ask');
  }
}
