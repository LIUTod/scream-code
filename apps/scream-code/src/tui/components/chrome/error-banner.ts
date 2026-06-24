/**
 * Persistent error banner pinned above the input box.
 *
 * Unlike the transcript "错误：…" line (which scrolls away as the conversation
 * grows), this stays in the fixed region directly above the editor so a turn
 * that ended on a provider error — e.g. 502 / rate limit / content filter —
 * cannot be missed. It is cleared when the user sends their next message or
 * switches sessions.
 *
 * Renders nothing when empty so it has zero visual footprint during normal
 * operation.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import { truncateErrorMessage } from '#/tui/utils/event-payload';

const MAX_BANNER_LINES = 3;
const CONTINUATION_INDENT = '  ';

export class ErrorBannerComponent implements Component {
  private message: string | undefined;
  private readonly colors: ColorPalette;

  constructor(colors: ColorPalette) {
    this.colors = colors;
  }

  setMessage(message: string): void {
    this.message = message;
  }

  clear(): void {
    this.message = undefined;
  }

  invalidate(): void {
    // Stateless beyond `message`; nothing to invalidate.
  }

  render(width: number): string[] {
    if (this.message === undefined) return [];

    const truncated = truncateErrorMessage(this.message, MAX_BANNER_LINES);
    const lines = truncated.split('\n');
    const err = chalk.hex(this.colors.error);
    const dim = chalk.hex(this.colors.textDim);

    // Reserve space for the bullet (first line) or 2-space indent (continuation).
    // Hard-truncate each line so a long single-line error (e.g. an HTML 502
    // body collapsed into one line) can't wrap and push the editor downward.
    const reserve = Math.max(STATUS_BULLET.length, CONTINUATION_INDENT.length);
    const contentWidth = Math.max(10, width - reserve);

    const out: string[] = [''];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (i === 0) {
        const trimmed = truncateToWidth(line, contentWidth);
        out.push(err(`${STATUS_BULLET}${trimmed}`));
      } else if (line.startsWith('… ')) {
        out.push(dim(CONTINUATION_INDENT + line));
      } else {
        const trimmed = truncateToWidth(line, contentWidth);
        out.push(err(CONTINUATION_INDENT + trimmed));
      }
    }
    return out;
  }
}
