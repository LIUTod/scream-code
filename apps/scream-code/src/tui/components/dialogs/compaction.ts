/**
 * Renders a compaction block in the transcript.
 *
 * Lifecycle:
 *   - constructed on `compaction.started` → blinking white bullet +
 *     "Compacting context..." and optional custom instruction
 *   - `markDone()` on `compaction.completed` → solid green bullet +
 *     "Compaction complete (X → Y tokens)"
 *   - `markCanceled()` on `compaction.cancelled` → solid warning bullet +
 *     "Compaction cancelled"
 *
 * Bullet animation mirrors `ToolCallComponent` (500ms blink) so the user
 * reads the same "work in progress" signal across the UI.
 */

import { Container, Text, Spacer } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

const BLINK_INTERVAL = 500;

export class CompactionComponent extends Container {
  private readonly colors: ColorPalette;
  private readonly ui: TUI | undefined;
  private readonly headerText: Text;
  private blinkOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private done = false;
  private canceled = false;
  private tokensBefore: number | undefined;
  private tokensAfter: number | undefined;

  constructor(colors: ColorPalette, ui?: TUI, instruction?: string | undefined) {
    super();
    this.colors = colors;
    this.ui = ui;

    // Top margin so the block isn't glued to the previous transcript
    // entry (status line, tool result, etc.).
    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    if (instruction !== undefined) {
      this.addChild(new Text(chalk.dim(`  ${instruction}`), 0, 0));
    }

    this.startBlink();
  }

  markDone(tokensBefore?: number, tokensAfter?: number): void {
    if (this.done || this.canceled) return;
    this.done = true;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.stopBlink();
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  markCanceled(): void {
    if (this.done || this.canceled) return;
    this.canceled = true;
    this.stopBlink();
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopBlink();
  }

  private buildHeader(): string {
    if (this.done) {
      const bullet = chalk.hex(this.colors.success)(STATUS_BULLET);
      const label = chalk.hex(this.colors.success).bold('压缩完成');
      const detail =
        this.tokensBefore !== undefined && this.tokensAfter !== undefined
          ? chalk.dim(` (${String(this.tokensBefore)} → ${String(this.tokensAfter)} token)`)
          : '';
      return `${bullet}${label}${detail}`;
    }
    if (this.canceled) {
      const bullet = chalk.hex(this.colors.warning)(STATUS_BULLET);
      const label = chalk.hex(this.colors.warning).bold('压缩已取消');
      return `${bullet}${label}`;
    }
    const bullet = this.blinkOn ? chalk.hex(this.colors.roleAssistant)(STATUS_BULLET) : '  ';
    const label = chalk.hex(this.colors.primary).bold('正在压缩上下文...');
    return `${bullet}${label}`;
  }

  private startBlink(): void {
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.headerText.setText(this.buildHeader());
      this.ui?.requestRender();
    }, BLINK_INTERVAL);
  }

  private stopBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }
}
