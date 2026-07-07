import type { PermissionMode } from '@scream-code/scream-code-sdk';

import { t } from '@scream-code/config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

function getPermissionOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'manual',
      label: t('permission.manual'),
      description: t('permission.manual_desc'),
    },
    {
      value: 'auto',
      label: t('permission.auto'),
      description: t('permission.auto_desc'),
    },
    {
      value: 'yolo',
      label: 'YES',
      description: t('permission.yolo_desc'),
    },
  ];
}

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'yolo';
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
