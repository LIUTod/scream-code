import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';
import type { Theme } from '#/tui/theme/index';

const THEME_OPTIONS: readonly ChoiceOption[] = [
  { value: 'auto', label: '自动（跟随终端）' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

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
      title: '选择主题',
      options: [...THEME_OPTIONS],
      currentValue: opts.currentValue,
      colors: opts.colors,
      onSelect: (value) => {
        if (isThemeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
