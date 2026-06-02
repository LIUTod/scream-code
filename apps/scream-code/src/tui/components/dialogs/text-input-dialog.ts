import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export type TextInputResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

export interface TextInputDialogOptions {
  readonly title: string;
  readonly subtitle?: string;
  readonly placeholder?: string;
  /** When true, displayed characters are masked (e.g. for API keys). */
  readonly masked?: boolean;
  readonly colors: ColorPalette;
}

const FOOTER = 'Enter 提交 · Esc 取消';

function maskText(text: string): string {
  // Preserve ANSI sequences, mask everything else.
  const parts = text.split(/((?:\[[0-9;]*m|_pi:c))/);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.replaceAll(/./g, '•')))
    .join('');
}

export class TextInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input: Input;
  private readonly onDone: (result: TextInputResult) => void;
  private readonly opts: TextInputDialogOptions;
  private done = false;
  private emptyHinted = false;

  constructor(onDone: (result: TextInputResult) => void, opts: TextInputDialogOptions) {
    super();
    this.onDone = onDone;
    this.opts = opts;
    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    if (this.emptyHinted) this.emptyHinted = false;
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(28, width);
    const innerWidth = Math.max(10, safeWidth - 4);
    const pad = '  ';
    const border = (s: string): string => chalk.hex(this.opts.colors.primary)(s);

    const titleLine = truncateToWidth(
      chalk.bold.hex(this.opts.colors.textStrong)(this.opts.title),
      innerWidth,
      '…',
    );
    const subtitleText = this.emptyHinted
      ? '输入不能为空。'
      : (this.opts.subtitle ?? '');
    const subtitleLine = truncateToWidth(
      chalk.hex(this.opts.colors.textDim)(subtitleText),
      innerWidth,
      '…',
    );
    const footerLine = truncateToWidth(
      chalk.hex(this.opts.colors.textDim)(FOOTER),
      innerWidth,
      '…',
    );

    const rawInputLine = this.input.render(innerWidth)[0] ?? '> ';
    const inputLine =
      this.opts.masked && this.input.getValue() !== ''
        ? maskText(rawInputLine)
        : rawInputLine;

    const contentLines: string[] = [titleLine, '', subtitleLine, '', inputLine, '', footerLine];
    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];
    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }
    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines;
  }

  private submit(value: string): void {
    if (this.done) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.emptyHinted = true;
      return;
    }
    this.done = true;
    this.onDone({ kind: 'ok', value: trimmed });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
