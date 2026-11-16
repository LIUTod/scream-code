import type { PermissionMode } from '@scream-code/scream-code-sdk';

import { t } from '@scream-code/config';
import { permissionModeLabel } from '#/tui/permission-mode-label';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

function getPermissionOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'auto',
      label: t('permission.auto'),
      description: t('permission.auto_desc'),
    },
    {
      value: 'yolo',
      label: permissionModeLabel('yolo'),
      description: t('permission.yolo_desc'),
    },
    {
      value: 'bot',
      label: permissionModeLabel('bot'),
      description: t('permission.bot_desc'),
    },
    {
      value: 'ask',
      label: permissionModeLabel('ask'),
      description: t('permission.ask_desc'),
    },
  ];
}

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'auto' || value === 'yolo' || value === 'bot' || value === 'ask';
}

export interface PermissionSelectorOptions {
  readonly currentValue: PermissionMode;
  readonly colors: ColorPalette;
  readonly onSelect: (mode: PermissionMode) => void;
  readonly onCancel: () => void;
}

export class PermissionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PermissionSelectorOptions) {
    super({
      title: t('permission.select_title'),
      options: [...getPermissionOptions()],
      currentValue: opts.currentValue,
      colors: opts.colors,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
