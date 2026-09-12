import { Container, Spacer, Text } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { INTERJECTION_BULLET } from '#/tui/constant/symbols';
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
  constructor(
    title: string,
    detail: string | undefined,
    colors: ColorPalette,
    markerColor?: string,
  ) {
    super();
    // A plain notice carries no marker (that is how command feedback renders);
    // an interjection — a subagent cutting into the transcript — gets the
    // triangle, which keeps `■ ` reserved for user and assistant speech.
    const marker =
      markerColor === undefined ? MESSAGE_INDENT : chalk.hex(markerColor)(INTERJECTION_BULLET);
    this.addChild(new Spacer(1));
    this.addChild(new Text(`${marker}${chalk.hex(colors.textStrong)(replaceTabs(title))}`, 0, 0));
    if (detail !== undefined && detail.length > 0) {
      this.addChild(
        new Text(`${MESSAGE_INDENT}${chalk.hex(colors.textDim)(replaceTabs(detail))}`, 0, 0),
      );
    }
  }
}
