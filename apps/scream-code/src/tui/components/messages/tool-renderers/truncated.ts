import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  const tint = result.is_error ? chalk.hex(ctx.colors.error) : chalk.dim;
  const lines = result.output.split('\n');
  if (ctx.expanded) {
    return [new Text(tint(result.output), 2, 0)];
  }
  const shown = lines.slice(0, PREVIEW_LINES);
  const remaining = lines.length - shown.length;
  const out: Component[] = [new Text(tint(shown.join('\n')), 2, 0)];
  if (remaining > 0) {
    out.push(new Text(chalk.dim(`... (${String(remaining)} more lines, ctrl+o to expand)`), 2, 0));
  }
  return out;
};
