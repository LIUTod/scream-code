/**
 * HelpPanel — modal `/help` display. Lists keyboard shortcuts, slash
 * commands (with aliases + descriptions) in colour-coded sections.
 *
 * Mirrors the container-replacement pattern used by SessionPicker /
 * ApprovalPanel: host mounts the panel into `editorContainer`, picks
 * it as the focused component, and tears it down on the `onClose`
 * callback (fired on Esc / Enter / q).
 */

import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

export interface HelpPanelCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

/** Static list — keep in sync with the global editor bindings. */
export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: 'Shift-Tab', description: '切换计划模式' },
  // { keys: 'Ctrl-G', description: 'Edit in external editor ($VISUAL / $EDITOR)' },
  { keys: 'Ctrl-O', description: '切换工具输出展开' },
  { keys: 'Ctrl-S', description: '中途干预 — 在流式传输中插入后续提示' },
  { keys: 'Shift-Enter / Ctrl-J', description: '插入换行' },
  { keys: 'Ctrl-C', description: '中断流 / 清空输入' },
  { keys: 'Ctrl-D', description: '退出（空输入时）' },
  { keys: 'Esc', description: '关闭对话框 / 中断流' },
  { keys: '↑ / ↓', description: '浏览输入历史' },
  { keys: 'Enter', description: '提交' },
];

export interface HelpPanelOptions {
  readonly commands: readonly HelpPanelCommand[];
  readonly shortcuts?: readonly KeyboardShortcut[];
  readonly colors: ColorPalette;
  readonly onClose: () => void;
  /** Terminal height — used to decide whether to show the hint tail. */
  readonly maxVisible?: number;
}

export class HelpPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: HelpPanelOptions;
  private scrollTop = 0;

  constructor(opts: HelpPanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1; // render clamps
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
    }
  }

  override render(width: number): string[] {
    const colors = this.opts.colors;
    const accent = chalk.hex(colors.primary);
    const dim = chalk.hex(colors.textDim);
    const muted = chalk.hex(colors.textMuted);
    const kbdColor = chalk.hex(colors.warning);
    const slashColor = chalk.hex(colors.primary);

    const shortcuts = this.opts.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS;
    const kbdWidth = Math.max(8, ...shortcuts.map((s) => s.keys.length));
    const sortedCmds = [...this.opts.commands].toSorted((a, b) => a.name.localeCompare(b.name));
    const cmdLabels = sortedCmds.map((c) => {
      const aliases = c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
      return `/${c.name}${aliases}`;
    });
    const cmdWidth = Math.max(12, ...cmdLabels.map((l) => l.length));
    const lines: string[] = [
      accent('─'.repeat(width)),
      accent.bold(' 帮助 ') + muted('· Esc / Enter / q 关闭 · ↑↓ 滚动'),
      '',
      // Greeting
      `  ${dim('Scream 已准备好帮助您！发送消息即可开始。')}`,
      '',
      // Section: keyboard shortcuts
      `  ${chalk.bold('键盘快捷键')}`,
      ...shortcuts.map((s) => `    ${kbdColor(s.keys.padEnd(kbdWidth))}  ${dim(s.description)}`),
      '',
      // Section: slash commands
      `  ${chalk.bold('斜杠命令')}`,
      ...sortedCmds.map((cmd, i) => {
        const label = cmdLabels[i] ?? `/${cmd.name}`;
        return `    ${slashColor(label.padEnd(cmdWidth))}  ${dim(cmd.description)}`;
      }),
      '',
      accent('─'.repeat(width)),
    ];

    // Apply scroll windowing — keep the borders visible.
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = muted(
        ` 显示 ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} / ${String(content.length)}`,
      );
      return [lines[0] ?? '', ...slice, scrollInfo, lines.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }
    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}
