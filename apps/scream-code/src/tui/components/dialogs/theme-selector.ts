import { t } from '@scream-code/config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';
import type { Theme } from '#/tui/theme/index';

function getThemeOptions(): readonly ChoiceOption[] {
  return [
    { value: 'auto', label: t('theme.auto') },
    { value: 'dark', label: t('theme.dark') },
    { value: 'light', label: t('theme.light') },
  ];
}

function isThemeChoice(value: string): value is Theme {
  return value === 'auto' || value === 'dark' || value === 'light';
}

export interface ThemeSelectorOptions {
  readonly currentValue: Theme;
  readonly colors: ColorPalette;
  readonly onSelect: (theme: Theme) => void;
  readonly onCancel: () => void;
}

export class ThemeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ThemeSelectorOptions) {
    super({
      title: t('theme.select_title'),
      options: [...getThemeOptions()],
      currentValue: opts.currentValue,
      colors: opts.colors,
      onSelect: (value) => {
        if (isThemeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
