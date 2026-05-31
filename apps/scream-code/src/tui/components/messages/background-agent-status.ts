import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';

export class BackgroundAgentStatusComponent implements Component {
  constructor(
    private readonly data: BackgroundAgentStatusData,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const tone =
      this.data.phase === 'started'
        ? this.colors.primary
        : this.data.phase === 'completed'
          ? this.colors.success
          : this.colors.error;

    const bullet =
      this.data.phase === 'failed' ? chalk.hex(tone)(FAILURE_MARK) : chalk.hex(tone)(STATUS_BULLET);
    const text =
      chalk.hex(tone)(this.data.headline) +
      (this.data.detail !== undefined && this.data.detail.length > 0
        ? chalk.hex(this.colors.textDim)(` (${this.data.detail})`)
        : '');

    const textComponent = new Text(text, 0, 0);
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = textComponent.render(contentWidth);
    return [
      '',
      ...contentLines.map((line, index) => (index === 0 ? bullet : MESSAGE_INDENT) + line),
    ];
  }
}
