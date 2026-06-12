import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';

export class BackgroundAgentStatusComponent implements Component {
  private readonly bullet: string;
  private readonly textComponent: Text;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly data: BackgroundAgentStatusData,
    private readonly colors: ColorPalette,
  ) {
    const tone =
      data.phase === 'started'
        ? colors.primary
        : data.phase === 'completed'
          ? colors.success
          : colors.error;

    this.bullet = data.phase === 'failed' ? chalk.hex(tone)(FAILURE_MARK) : chalk.hex(tone)(STATUS_BULLET);
    const text =
      chalk.hex(tone)(data.headline) +
      (data.detail !== undefined && data.detail.length > 0
        ? chalk.hex(colors.textDim)(` (${data.detail})`)
        : '');

    this.textComponent = new Text(text, 0, 0);
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
