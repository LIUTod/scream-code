import type { Component } from '@liutod-scream/pi-tui';
import { Text } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

/**
 * Returns the tail of `text` whose UTF-8 byte length is at most `maxBytes`.
 * Iterates by Unicode code points so multi-byte characters and surrogate
 * pairs are never split.
 */
function truncateTailBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const chars = Array.from(text);
  let start = chars.length;
  let bytes = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i];
    if (char === undefined) continue;
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    start = i;
  }
  return chars.slice(start).join('');
}

/**
 * Component that renders tool output with wrap-aware line truncation.
 * Uses pi-tui's Text component to compute actual visual wrapped lines, then
 * caps at `maxLines`. When collapsed the TAIL is shown (newest output, where
 * command errors land) with an expand hint at the top; when expanded the full
 * output is shown with a collapse hint at the top. Handles long single-line
 * output (e.g. JSON blobs) that would otherwise wrap to dozens of visual rows.
 */
export class TruncatedOutputComponent implements Component {
  private readonly textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly hintFormatter: ((remaining: number) => string) | undefined;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      colors: ColorPalette;
      maxLines?: number;
      maxBytes?: number;
      hintFormatter?: (remaining: number) => string;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.hintFormatter = options.hintFormatter;
    const tint = options.isError ? chalk.hex(options.colors.error) : chalk.dim;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    // Error output may contain ANSI codes from the command (npm/npx color
    // output in PTY mode). \x1b[0m drops the error tint, background codes
    // render as solid color blocks. Strip them so the tint applies uniformly.
    const stripped = options.isError ? cleaned.replaceAll(/\u001B\[[0-9;]*m/g, '') : cleaned;
    const truncated =
      options.maxBytes === undefined
        ? stripped
        : truncateTailBytes(stripped, options.maxBytes);
    // Tint per-line so each line carries its own ANSI reset. Without this the
    // trailing padding Text.render appends inherits the fg color, and terminals
    // that paint colored spaces show a solid color block instead of text.
    const tinted = truncated.split('\n').map((line) => tint(line)).join('\n');
    this.textComponent = new Text(tinted, 2, 0);
  }

  invalidate(): void {
    this.textComponent.invalidate();
  }

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);

    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    // Collapsed: show the TAIL (newest output, where errors land) and surface
    // an expand hint at the TOP so the preview reads top-down without the
    // hidden head pushing the useful lines out of view.
    const remaining = contentLines.length - this.maxLines;
    // slice(-0) === slice(0) === whole array in JS; treat maxLines=0 as "no
    // content shown, hint only" so a zero preview hides all output lines.
    const tail =
      this.maxLines <= 0 ? [] : contentLines.slice(-this.maxLines);
    const expandHint = this.hintFormatter
      ? this.hintFormatter(remaining)
      : t('shell.more_lines', { count: String(remaining) });
    // Render the hint through Text with the same 2-space padding as the
    // content lines above, so the hint aligns with the output instead of
    // sitting at column 0.
    const hintLines = new Text(chalk.dim(expandHint), 2, 0).render(width);
    return [...hintLines, ...tail];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
      colors: ctx.colors,
    }),
  ];
};
