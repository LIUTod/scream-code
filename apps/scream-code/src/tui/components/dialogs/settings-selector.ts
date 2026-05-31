import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

export type SettingsSelection = 'model' | 'theme' | 'editor' | 'permission' | 'usage';

const SETTINGS_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'model',
    label: '模型',
    description: '切换当前模型和思考模式。',
  },
  {
    value: 'permission',
    label: '权限',
    description: '选择工具操作的批准方式。',
  },
  {
    value: 'theme',
    label: '主题',
    description: '更改终端 UI 主题。',
  },
  {
    value: 'editor',
    label: '编辑器',
    description: '设置外部编辑器命令。',
  },
  {
    value: 'usage',
    label: '用量',
    description: '显示会话 token、上下文窗口和计划配额。',
  },
];

function isSettingsSelection(value: string): value is SettingsSelection {
  return (
    value === 'model' ||
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
      title: '设置',
      options: [...SETTINGS_OPTIONS],
      colors: opts.colors,
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
