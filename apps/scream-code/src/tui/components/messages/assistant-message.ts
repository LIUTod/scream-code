/**
 * Renders an assistant message using pi-tui Markdown.
 *
 * Displays a white bullet prefix with markdown content indented
 * to align after the bullet.
 */

import type { Component, MarkdownTheme, TUI } from '@liutod-scream/pi-tui';
import { Container, Markdown, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import {
  FADE_MS,
  buildFadeTable,
  fadeColor,
  isReducedMotion,
} from '#/tui/utils/streaming-fade';

const FADE_TICK_MS = 100;

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private markdownTheme: MarkdownTheme;
  private bulletColor: string;
  private accentColor: string;
  private lastText = '';
  private showBullet: boolean;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private markdownChild: Markdown | undefined;
  private readonly ui: TUI | undefined;
  private fadeStartMs: number | undefined;
  private fadeTimer: ReturnType<typeof setInterval> | undefined;
  private fadeTable: string[] | undefined;

  constructor(
    markdownTheme: MarkdownTheme,
    colors: ColorPalette,
    showBullet: boolean = true,
    ui?: TUI,
  ) {
    this.markdownTheme = markdownTheme;
    this.bulletColor = colors.roleAssistant;
    this.accentColor = colors.primary;
    this.showBullet = showBullet;
    this.ui = ui;
    this.contentContainer = new Container();
  }

  setShowBullet(show: boolean): void {
    if (this.showBullet === show) return;
    this.showBullet = show;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    if (!show) {
      // Bullet hidden — stop the fade timer so it doesn't keep firing
      // requestRender for a bullet that isn't drawn.
      this.stopFade();
    }
  }

  updateContent(text: string): void {
    const trimmedText = text.trim();
    const previousTrimmed = this.lastText.trim();
    if (trimmedText === previousTrimmed) {
      this.lastText = text;
      return;
    }

    this.lastText = text;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;

    if (this.markdownChild !== undefined) {
      this.markdownChild.setText(trimmedText);
    } else if (trimmedText.length > 0) {
      this.markdownChild = new Markdown(trimmedText, 0, 0, this.markdownTheme);
      this.contentContainer.addChild(this.markdownChild);
      this.startFade();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.contentContainer.invalidate?.();
  }

  dispose(): void {
    this.stopFade();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (this.lastText.trim().length === 0) return [];

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    const contentLines = this.contentContainer.render(contentWidth);

    const activeBulletColor = this.currentBulletColor();

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p =
        i === 0 && this.showBullet
          ? chalk.hex(activeBulletColor)(STATUS_BULLET)
          : MESSAGE_INDENT;
      lines.push(p + contentLines[i]);
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private currentBulletColor(): string {
    if (this.fadeStartMs === undefined || this.fadeTable === undefined) {
      return this.bulletColor;
    }
    const age = Date.now() - this.fadeStartMs;
    // startFade already gated on isReducedMotion() — if fade is active,
    // reduced is false, so skip re-querying process.env on every render tick.
    return fadeColor(age, this.fadeTable, false);
  }

  private startFade(): void {
    if (this.ui === undefined) return;
    if (!this.showBullet) return;
    if (isReducedMotion()) return;
    if (this.fadeTimer !== undefined) return;

    this.fadeTable = buildFadeTable(this.accentColor, this.bulletColor);
    this.fadeStartMs = Date.now();

    this.fadeTimer = setInterval(() => {
      const age = Date.now() - (this.fadeStartMs ?? 0);
      // Invalidate cache so render picks up the next fade bucket.
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
      this.ui?.requestComponentRender(this);
      if (age >= FADE_MS) {
        this.stopFade();
      }
    }, FADE_TICK_MS);

    // Kick the first frame so the accent-colored bullet shows immediately.
    this.ui.requestRender();
  }

  private stopFade(): void {
    if (this.fadeTimer !== undefined) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = undefined;
    }
    this.fadeStartMs = undefined;
    this.fadeTable = undefined;
    // One final invalidate so render settles on the ink color.
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
