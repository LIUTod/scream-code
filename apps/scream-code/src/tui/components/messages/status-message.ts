import { Container, Spacer, Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '../../theme/colors';

export class StatusMessageComponent extends Container {
  constructor(content: string, colors: ColorPalette, color?: string) {
    super();
    const text = color === undefined ? chalk.hex(colors.textDim)(content) : chalk.hex(color)(content);
    this.addChild(new Text(`  ${text}`, 0, 0));
  }
}

export class NoticeMessageComponent extends Container {
  constructor(title: string, detail: string | undefined, colors: ColorPalette) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(new Text(`  ${chalk.hex(colors.textStrong)(title)}`, 0, 0));
    if (detail !== undefined && detail.length > 0) {
      this.addChild(new Text(`  ${chalk.hex(colors.textDim)(detail)}`, 0, 0));
    }
  }
}
