/**
 * Renders a user message in the transcript.
 */

import type { Component } from '@liutod-scream/pi-tui';
import { Box, Spacer, Text, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { contrastTextHex, type ColorPalette } from '#/tui/theme/colors';
import { isUserMessageHighlightEnabled } from '#/tui/utils/ui-preferences';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

export class UserMessageComponent implements Component {
  private color: string;
  private bgColor: string;
  private isSystemReminder: boolean;
  private textComponent: Text;
  private textContent: string;
  private currentFg: string | undefined;
  private box: Box;
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private cachedHighlight: boolean | undefined;

  constructor(text: string, colors: ColorPalette, images?: ImageAttachment[]) {
    this.color = colors.roleUser;
    this.bgColor = colors.roleUserBg;
    // System reminders are stored as role:'user' in the context but are NOT
    // real user messages — skip the background block for them.
    this.isSystemReminder = text.trimStart().startsWith('<system-reminder>');
    this.textContent = text;
    this.textComponent = new Text('', 0, 0);
    this.applyTextColor(this.isSystemReminder ? colors.roleUser : contrastTextHex(colors.roleUserBg));
    // Box applies background to all lines INCLUDING top/bottom padding (paddingY=1),
    // so the entire message block — leading pad, content, trailing pad — gets the
    // background color and fills the terminal width. Mirrors pi's user-message.
    this.box = new Box(0, 1, (content: string) => chalk.bgHex(this.bgColor)(content));
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img, colors)) ?? [];
  }

  /** Rebuild the Text with the fg color matching the current highlight state. */
  private applyTextColor(fg: string): void {
    if (this.currentFg === fg) return;
    this.currentFg = fg;
    const fgCode = chalk.hex(fg);
    this.textComponent.setText(chalk.bold(fgCode(this.textContent)));
    this.textComponent.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.textComponent.invalidate();
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  render(width: number): string[] {
    // /hl toggle is read live; the cache is keyed by toggle state so a change
    // invalidates on the next render without an external transcript rebuild.
    const highlightEnabled = isUserMessageHighlightEnabled();
    if (
      this.cachedLines !== undefined &&
      this.cachedWidth === width &&
      this.cachedHighlight === highlightEnabled
    ) {
      return this.cachedLines;
    }

    // System reminders: no background block — render as plain user-colored text.
    // Also skipped when /hl is disabled (default look: ■ prefix only).
    if (this.isSystemReminder || !highlightEnabled) {
      // Highlight off → text goes back to the roleUser color (yellow /
      // orange-red), not the white from the background contrast.
      this.applyTextColor(this.color);
      const border = chalk.hex(this.color).bold(USER_MESSAGE_BULLET);
      const borderWidth = visibleWidth(border);
      const contentWidth = Math.max(1, width - borderWidth);
      const lines: string[] = [];
      for (const line of this.spacerComponent.render(width)) {
        lines.push(line);
      }
      const textLines = this.textComponent.render(contentWidth);
      for (let i = 0; i < textLines.length; i++) {
        const prefix = i === 0 ? border : ' '.repeat(borderWidth);
        lines.push(prefix + textLines[i]);
      }

      // Images — indented to align with text after the border (no background).
      for (const thumbnail of this.imageThumbnails) {
        const imageLines = thumbnail.render(contentWidth);
        for (const line of imageLines) {
          lines.push(' '.repeat(borderWidth) + line);
        }
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      this.cachedHighlight = highlightEnabled;
      return lines;
    }

    const border = chalk.bgHex(this.bgColor)(chalk.hex(this.color).bold(USER_MESSAGE_BULLET));
    const borderWidth = visibleWidth(border);
    const contentWidth = Math.max(1, width - borderWidth);

    // Highlight on (non-system-reminder): text must be the contrast color
    // (white on the bright background block).
    if (!this.isSystemReminder) {
      this.applyTextColor(contrastTextHex(this.bgColor));
    }

    // Build content lines (text + images) — Box handles top/bottom padding.
    const contentLines: string[] = [];

    // Text — first line gets the ■ border, continuation lines get blank padding.
    const textLines = this.textComponent.render(contentWidth);
    for (let i = 0; i < textLines.length; i++) {
      const prefix = i === 0 ? border : chalk.bgHex(this.bgColor)(' '.repeat(borderWidth));
      contentLines.push(prefix + textLines[i]);
    }

    // Images — indented to align with text after the border.
    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(contentWidth);
      for (const line of imageLines) {
        contentLines.push(chalk.bgHex(this.bgColor)(' '.repeat(borderWidth)) + line);
      }
    }

    // Feed content into Box — Box applies background + top/bottom padding rows.
    this.box.clear();
    this.box.addChild({
      render: () => contentLines,
      invalidate: () => {},
    });
    const bgLines = this.box.render(width);

    // Spacer goes OUTSIDE the box (no background on the spacer line).
    const lines: string[] = [];
    for (const line of this.spacerComponent.render(width)) {
      lines.push(line);
    }
    lines.push(...bgLines);

    this.cachedWidth = width;
    this.cachedLines = lines;
    this.cachedHighlight = highlightEnabled;
    return lines;
  }
}
