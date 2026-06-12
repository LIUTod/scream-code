/**
 * Renders an assistant message using pi-tui Markdown.
 *
 * Displays a white bullet prefix with markdown content indented
 * to align after the bullet.
 */

import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { Container, Markdown, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private markdownTheme: MarkdownTheme;
  private bulletColor: string;
  private lastText = '';
  private showBullet: boolean;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private markdownChild: Markdown | undefined;

  constructor(markdownTheme: MarkdownTheme, colors: ColorPalette, showBullet: boolean = true) {
    this.markdownTheme = markdownTheme;
    this.bulletColor = colors.roleAssistant;
    this.showBullet = showBullet;
    this.contentContainer = new Container();
  }

  setShowBullet(show: boolean): void {
    if (this.showBullet === show) return;
    this.showBullet = show;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
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

    const markdownChild = this.markdownChild;
    if (
      markdownChild !== undefined &&
      trimmedText.startsWith(previousTrimmed) &&
      trimmedText.length > previousTrimmed.length
    ) {
      markdownChild.setText(trimmedText);
      return;
    }

    this.contentContainer.clear();
    this.markdownChild = undefined;
    if (trimmedText.length > 0) {
      this.markdownChild = new Markdown(trimmedText, 0, 0, this.markdownTheme);
      this.contentContainer.addChild(this.markdownChild);
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.contentContainer.invalidate?.();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (this.lastText.trim().length === 0) return [];

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    const contentLines = this.contentContainer.render(contentWidth);

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p =
        i === 0 && this.showBullet ? chalk.hex(this.bulletColor)(STATUS_BULLET) : MESSAGE_INDENT;
      lines.push(p + contentLines[i]);
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
