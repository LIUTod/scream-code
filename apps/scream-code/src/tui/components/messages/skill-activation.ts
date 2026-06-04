/**
 * Skill activation card.
 *
 * When the user runs `/skill:foo bar`, the TUI renders a compact card instead
 * of expanding the SKILL.md body into the user bubble:
 *
 *   ▶ Activated skill: foo
 *     bar
 *
 * The args line is optional. Core expands the skill body into the LLM context;
 * the TUI only consumes the `skill.activated` event and user_message origin
 * metadata.
 */

import { Container, Text, Spacer } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

const ARGS_PREVIEW_MAX = 200;

const TRIGGER_LABEL: Record<string, string> = {
  'user-slash': '（用户触发）',
  'model-tool': '（模型调用）',
  'nested-skill': '（嵌套调用）',
};

export class SkillActivationComponent extends Container {
  constructor(
    name: string,
    args: string | undefined,
    colors: ColorPalette,
    trigger?: 'user-slash' | 'model-tool' | 'nested-skill',
  ) {
    super();
    this.addChild(new Spacer(1));
    const triggerLabel = trigger !== undefined ? chalk.hex(colors.textDim)(TRIGGER_LABEL[trigger] ?? '') : '';
    const head =
      chalk.hex(colors.primary).bold('▶ 已激活 skill：') +
      chalk.hex(colors.roleUser).bold(name) +
      (triggerLabel.length > 0 ? ' ' + triggerLabel : '');
    this.addChild(new Text(head, 0, 0));
    const trimmed = args?.trim() ?? '';
    if (trimmed.length > 0) {
      const preview =
        trimmed.length > ARGS_PREVIEW_MAX ? trimmed.slice(0, ARGS_PREVIEW_MAX) + '…' : trimmed;
      this.addChild(new Text('  ' + chalk.hex(colors.textDim)(preview), 0, 0));
    }
  }
}
