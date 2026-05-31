/**
 * Renders a user message in the transcript.
 */

import type { Component } from '@earendil-works/pi-tui';
import { Spacer, Text, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

export class UserMessageComponent implements Component {
  private color: string;
  private textComponent: Text;
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];

  constructor(text: string, colors: ColorPalette, images?: ImageAttachment[]) {
    this.color = colors.roleUser;
    this.textComponent = new Text(chalk.hex(colors.roleUser).bold(text), 0, 0);
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img, colors)) ?? [];
  }

  invalidate(): void {
    this.textComponent.invalidate();
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  render(width: number): string[] {
    const bullet = chalk.hex(this.color).bold(USER_MESSAGE_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, width - bulletWidth);

    const lines: string[] = [];

    // Spacer
    for (const line of this.spacerComponent.render(width)) {
      lines.push(line);
    }

    // Text
    const textLines = this.textComponent.render(contentWidth);
    for (let i = 0; i < textLines.length; i++) {
      const prefix = i === 0 ? bullet : ' '.repeat(bulletWidth);
      lines.push(prefix + textLines[i]);
    }

    // Images — indented to align with text after the bullet
    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(contentWidth);
      for (const line of imageLines) {
        lines.push(' '.repeat(bulletWidth) + line);
      }
    }

    return lines;
  }
}
