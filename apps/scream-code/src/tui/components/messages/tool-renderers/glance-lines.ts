import type { Component } from '@liutod-scream/pi-tui';
import { truncateToWidth } from '@liutod-scream/pi-tui';

/**
 * Renders pre-composed glance lines (ANSI-colored) with hard per-line
 * truncation to the actual render width. Unlike `Text`, long lines never
 * wrap — each logical line always occupies exactly one visual row, so
 * column-aligned samples (Grep matches) never break their alignment on
 * narrow terminals.
 */
export class GlanceLinesComponent implements Component {
  private readonly lines: readonly string[];

  constructor(lines: readonly string[]) {
    this.lines = lines;
  }

  invalidate(): void {
    // Static content — nothing to invalidate.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(width, 1);
    return this.lines.map((line) => truncateToWidth(`  ${line}`, safeWidth, '…'));
  }
}
