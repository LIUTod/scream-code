/**
 * Transcript-side rendering of a pasted image.
 *
 * On terminals that speak the Kitty graphics protocol or iTerm2 inline
 * image protocol (detected by pi-tui's `getCapabilities()`), we show
 * the actual image. Everywhere else we fall back to a one-line text
 * marker matching the placeholder the user sees in the input box —
 * this keeps the transcript readable on Terminal.app / Linux default
 * terminals / `script` recordings without extra chrome.
 *
 * Height is capped at ~12 rows so a single screenshot can't monopolize
 * the viewport; pi-tui handles proportional scaling internally.
 */

import { Container, Image, Text, type ImageTheme, getCapabilities } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

const MAX_IMAGE_ROWS = 12;
const MAX_IMAGE_WIDTH = 40;

export class ImageThumbnail extends Container {
  constructor(attachment: ImageAttachment, colors: ColorPalette) {
    super();

    const caps = getCapabilities();
    const supportsInline = caps.images === 'kitty' || caps.images === 'iterm2';

    if (!supportsInline) {
      // Non-graphic terminal — show the placeholder text in dim cyan so
      // it's clearly an attachment reference but doesn't shout.
      this.addChild(new Text(chalk.hex(colors.accent)(attachment.placeholder), 0, 0));
      return;
    }

    const theme: ImageTheme = {
      fallbackColor: (s: string) => chalk.hex(colors.textDim)(s),
    };
    const base64 = Buffer.from(attachment.bytes).toString('base64');
    const image = new Image(
      base64,
      attachment.mime,
      theme,
      {
        maxHeightCells: MAX_IMAGE_ROWS,
        maxWidthCells: MAX_IMAGE_WIDTH,
        filename: attachment.placeholder,
      },
      { widthPx: attachment.width, heightPx: attachment.height },
    );
    this.addChild(image);
  }
}
