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

import { Container, Image, Text, type Component, type ImageTheme, getCapabilities } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

const MAX_IMAGE_ROWS = 12;
const MAX_IMAGE_WIDTH = 40;

export interface CreateImageComponentOptions {
  base64: string;
  mime: string;
  width: number;
  height: number;
  filename?: string;
}

export function createImageComponent(
  opts: CreateImageComponentOptions,
  colors: ColorPalette,
): Component {
  const caps = getCapabilities();
  const supportsInline = caps.images === 'kitty' || caps.images === 'iterm2';

  if (!supportsInline) {
    const label = opts.filename ?? `[${opts.mime}]`;
    return new Text(chalk.hex(colors.accent)(label), 0, 0);
  }

  const theme: ImageTheme = {
    fallbackColor: (s: string) => chalk.hex(colors.textDim)(s),
  };
  return new Image(
    opts.base64,
    opts.mime,
    theme,
    {
      maxHeightCells: MAX_IMAGE_ROWS,
      maxWidthCells: MAX_IMAGE_WIDTH,
      filename: opts.filename,
    },
    { widthPx: opts.width, heightPx: opts.height },
  );
}

export class ImageThumbnail extends Container {
  constructor(attachment: ImageAttachment, colors: ColorPalette) {
    super();
    const base64 = Buffer.from(attachment.bytes).toString('base64');
    this.addChild(
      createImageComponent(
        {
          base64,
          mime: attachment.mime,
          width: attachment.width,
          height: attachment.height,
          filename: attachment.placeholder,
        },
        colors,
      ),
    );
  }
}
