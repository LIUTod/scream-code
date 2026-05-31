import type { PermissionMode } from '@scream-cli/scream-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'manual',
    label: '手动',
    description:
      '执行命令、编辑等风险操作前询问。读取/搜索工具直接运行；会话审批规则生效。',
  },
  {
    value: 'auto',
    label: '自动',
    description:
      '完全无交互运行。工具操作自动批准，跳过代理问题以便其自行决策。',
  },
  {
    value: 'yolo',
    label: 'YES',
    description:
      '自动批准工具操作和计划转换。需要您输入时代理仍会明确提问。',
  },
];

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
      title: '选择权限模式',
      options: [...PERMISSION_OPTIONS],
      currentValue: opts.currentValue,
      colors: opts.colors,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
