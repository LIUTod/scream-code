import { Container, Spacer, Text } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { replaceTabs } from '../../utils/sanitize';

import type { ColorPalette } from '../../theme/colors';

export class StatusMessageComponent extends Container {
  constructor(content: string, colors: ColorPalette, color?: string) {
    super();
    const sanitized = replaceTabs(content);
    const text = color === undefined ? chalk.hex(colors.textDim)(sanitized) : chalk.hex(color)(sanitized);
    this.addChild(new Text(`  ${text}`, 0, 0));
  }
}

export class NoticeMessageComponent extends Container {
  constructor(title: string, detail: string | undefined, colors: ColorPalette) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(new Text(`  ${chalk.hex(colors.textStrong)(replaceTabs(title))}`, 0, 0));
    if (detail !== undefined && detail.length > 0) {
      this.addChild(new Text(`  ${chalk.hex(colors.textDim)(replaceTabs(detail))}`, 0, 0));
    }
  }
}
