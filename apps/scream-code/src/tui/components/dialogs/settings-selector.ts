import { t } from '@scream-code/config';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

export type SettingsSelection = 'model' | 'language' | 'theme' | 'editor' | 'permission' | 'usage';

function getSettingsOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'model',
      label: t('settings.model'),
      description: t('settings.model_desc'),
    },
    {
      value: 'language',
      label: t('settings.language'),
      description: t('settings.language_desc'),
    },
    {
      value: 'permission',
      label: t('settings.permission'),
      description: t('settings.permission_desc'),
    },
    {
      value: 'theme',
      label: t('settings.theme'),
      description: t('settings.theme_desc'),
    },
    {
      value: 'editor',
      label: t('settings.editor'),
      description: t('settings.editor_desc'),
    },
    {
      value: 'usage',
      label: t('settings.usage'),
      description: t('settings.usage_desc'),
    },
  ];
}

function isSettingsSelection(value: string): value is SettingsSelection {
  return (
    value === 'model' ||
    value === 'language' ||
    value === 'theme' ||
    value === 'editor' ||
    value === 'permission' ||
    value === 'usage'
  );
}

export interface SettingsSelectorOptions {
  readonly colors: ColorPalette;
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: t('settings.title'),
      options: [...getSettingsOptions()],
      colors: opts.colors,
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
