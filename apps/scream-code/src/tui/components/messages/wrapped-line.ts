/**
 * WrappedLine renders `text` with a first-line prefix and a continuation
 * prefix that is re-applied to every wrapped line, so long content keeps
 * its hanging indentation instead of breaking the tree structure.
 *
 * This is the single shared component for tree-branch and indented
 * sub-content rendering, replacing the old `PrefixedWrappedLine`
 * (tool-call.ts) and the duplicate `BranchText` (agent-group.ts):
 * - default mode wraps like the old components (hanging indent, Text's
 *   word wrapping, rows padded to content width);
 * - `truncate: true` renders exactly one row clipped to the available
 *   width, so streaming rows keep a constant height and the transcript
 *   does not jump while a subagent's activity text grows.
 */

import type { Component } from '@liutod-scream/pi-tui';
import { Text, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';

export interface WrappedLineOptions {
  /**
   * Render the text as a single truncated line (with ellipsis) instead of
   * wrapping. The row count stays constant regardless of text length.
   */
  truncate?: boolean;
}

export class WrappedLine implements Component {
  private cachedText: string | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly firstPrefix: string,
    private readonly continuationPrefix: string,
    private text: string,
    private readonly options: WrappedLineOptions = {},
  ) {}

  render(width: number): string[] {
    if (
      this.cachedLines !== undefined &&
      this.cachedText === this.text &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    const prefixWidth = Math.max(
      visibleWidth(this.firstPrefix),
      visibleWidth(this.continuationPrefix),
    );
    const contentWidth = Math.max(1, width - prefixWidth);

    let lines: string[];
    if (this.options.truncate === true) {
      if (!this.text || this.text.trim() === '') {
        lines = [];
      } else {
        // Single-line the text first: embedded newlines/tabs would either
        // break the row contract or render as raw control characters.
        const singleLine = this.text.replaceAll(/\r\n|\r|\n/g, ' ').replaceAll(/\t/g, '   ');
        const line = this.firstPrefix + truncateToWidth(singleLine, contentWidth);
        const pad = Math.max(0, width - visibleWidth(line));
        lines = [line + ' '.repeat(pad)];
      }
    } else {
      // Text's word wrapping pads each row to contentWidth, so the
      // assembled rows match the viewport contract of plain Text.
      const wrapped = new Text(this.text, 0, 0).render(contentWidth);
      lines = wrapped.map((line, index) =>
        index === 0 ? `${this.firstPrefix}${line}` : `${this.continuationPrefix}${line}`,
      );
    }

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
