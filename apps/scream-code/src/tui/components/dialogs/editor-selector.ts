import { t } from '@scream-code/config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

function getEditorOptions(): readonly ChoiceOption[] {
  return [
    { value: 'code --wait', label: 'VS Code (code --wait)' },
    { value: 'vim', label: 'Vim' },
    { value: 'nvim', label: 'Neovim' },
    { value: 'nano', label: 'Nano' },
    { value: '', label: t('editor.auto_detect') },
  ];
}

export interface EditorSelectorOptions {
  readonly currentValue: string;
  readonly colors: ColorPalette;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

export class EditorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: EditorSelectorOptions) {
    super({
      title: t('editor.select_title'),
      options: [...getEditorOptions()],
      currentValue: opts.currentValue,
      colors: opts.colors,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
