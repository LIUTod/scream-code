import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

const EDITOR_OPTIONS: readonly ChoiceOption[] = [
  { value: 'code --wait', label: 'VS Code (code --wait)' },
  { value: 'vim', label: 'Vim' },
  { value: 'nvim', label: 'Neovim' },
  { value: 'nano', label: 'Nano' },
  { value: '', label: '自动检测 ($VISUAL / $EDITOR)' },
];

export interface EditorSelectorOptions {
  readonly currentValue: string;
  readonly colors: ColorPalette;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

export class EditorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: EditorSelectorOptions) {
    super({
      title: '选择外部编辑器',
      options: [...EDITOR_OPTIONS],
      currentValue: opts.currentValue,
      colors: opts.colors,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
