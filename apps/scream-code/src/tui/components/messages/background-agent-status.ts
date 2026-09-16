import type { Component } from '@liutod-scream/pi-tui';
import { Text, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { BRAILLE_SPINNER_FRAMES, MESSAGE_INDENT } from '#/tui/constant/rendering';
import { DONE_MARK, FAILURE_MARK } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';

/** Bullet and coloured headline/detail pair of one background task notice. */
export interface BackgroundStatusView {
  readonly bullet: string;
  readonly text: string;
}

/**
 * Builds the bullet + text of a background task notice. Shared by the standalone
 * card and the activity block row so a notice looks the same in both places.
 */
export function renderBackgroundStatus(
  data: BackgroundAgentStatusData,
  colors: ColorPalette,
  /**
   * Cells the caller can spend on the text. Passing it keeps a block row at one
   * line: the notice is clipped instead of wrapping. Omit it for the standalone
   * card, which is allowed to wrap like every other message.
   */
  maxCells?: number,
): BackgroundStatusView {
  const tone =
    data.phase === 'started'
      ? colors.primary
      : data.phase === 'completed'
        ? colors.success
        : colors.error;

  const bullet =
    data.phase === 'completed'
      ? chalk.hex(colors.success)(DONE_MARK)
      : data.phase === 'failed'
        ? chalk.hex(colors.error)(FAILURE_MARK)
        : // Running, like any tool row: the same spinner glyph, one step behind the
          // block header's animated one.
          chalk.hex(colors.textDim)(`${BRAILLE_SPINNER_FRAMES[0] ?? '⠋'} `);

  const hasDetail = data.detail !== undefined && data.detail.length > 0;
  const plain = hasDetail ? `${data.headline} (${data.detail ?? ''})` : data.headline;
  if (maxCells !== undefined && visibleWidth(plain) > maxCells) {
    // Clipped: colouring headline and detail separately no longer matches what
    // is left of the text, so the row keeps the phase tone only.
    return { bullet, text: chalk.hex(tone)(truncateToWidth(plain, maxCells, '…')) };
  }
  const text =
    chalk.hex(tone)(data.headline) +
    (hasDetail ? chalk.hex(colors.textDim)(` (${data.detail ?? ''})`) : '');
  return { bullet, text };
}

export class BackgroundAgentStatusComponent implements Component {
  private readonly bullet: string;
  private readonly textComponent: Text;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly data: BackgroundAgentStatusData,
    private readonly colors: ColorPalette,
  ) {
    const view = renderBackgroundStatus(data, colors);
    this.bullet = view.bullet;
    this.textComponent = new Text(view.text, 0, 0);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.textComponent.render(contentWidth);
    const lines = [
      '',
      ...contentLines.map((line, index) => (index === 0 ? this.bullet : MESSAGE_INDENT) + line),
    ];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
