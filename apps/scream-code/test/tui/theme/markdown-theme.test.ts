/**
 * Markdown reply styling contracts.
 *
 * Two things the palette guarantees and no component may re-decide:
 *  - emphasis (`**text**`) is coloured with `mdBold` and stays bold;
 *  - asides (`> quote`) use `mdQuote`, and `mdBold` is always the heavier of
 *    the two in the active mode (brighter on dark, deeper on light), so a
 *    side note can never outrank an emphasis.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { darkColors, lightColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

import { withoutRowMarkers } from '../../helpers/row-markers';

/** SGR prefix chalk emits for a hex colour at level 3. */
function sgr(hex: string): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return `38;2;${String((value >> 16) & 255)};${String((value >> 8) & 255)};${String(value & 255)}m`;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(channels[0]!) + 0.7152 * lin(channels[1]!) + 0.0722 * lin(channels[2]!);
}

describe('markdown theme colours', () => {
  const originalLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3; // non-TTY test env strips ANSI otherwise
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  for (const [name, colors] of [
    ['dark', darkColors],
    ['light', lightColors],
  ] as const) {
    describe(name, () => {
      const theme = () => createMarkdownTheme(colors);

      it('renders emphasis in mdBold and keeps it bold', () => {
        const out = theme().bold('重点');
        expect(out).toContain(sgr(colors.mdBold));
        expect(out).toContain('\u001B[1m');
        expect(out).not.toContain(sgr(colors.mdQuote));
      });

      it('keeps headings amber even though the renderer bolds them first', () => {
        // pi-tui calls `heading(bold(text))`; a coloured `bold` must not leak
        // into the heading, which is what made every heading violet.
        const out = theme().heading(theme().bold('构建流程'));
        expect(out).toContain(sgr(colors.mdHeading));
        expect(out).not.toContain(sgr(colors.mdBold));
        expect(out).toContain('\u001B[1m');
      });

      it('keeps table headers weight-only', () => {
        const out = theme().tableHeader?.('命令') ?? '';
        expect(out).toContain('\u001B[1m');
        expect(out).not.toContain(sgr(colors.mdBold));
      });

      it('renders block quotes in mdQuote, border included', () => {
        expect(theme().quote('旁注')).toContain(sgr(colors.mdQuote));
        expect(theme().quoteBorder('│')).toContain(sgr(colors.mdQuote));
      });

      it('keeps emphasis heavier than an aside', () => {
        // Dark mode reads "heavier" as brighter, light mode as deeper; either
        // way the emphasis must sit at the stronger end of the pair.
        if (name === 'dark') {
          expect(luminance(colors.mdBold)).toBeGreaterThan(luminance(colors.mdQuote));
        } else {
          expect(luminance(colors.mdBold)).toBeLessThan(luminance(colors.mdQuote));
        }
      });
    });
  }
});

/**
 * Code block chrome.
 *
 * Two contracts the renderer must hold, both of which were broken when the
 * language tag lived inside the first code row:
 *  1. the tag is chrome, not code — copying the block must not pick it up;
 *  2. no columns are reserved for it — the wrap point depends only on width.
 */
describe('code block language caption', () => {
  const strip = (value: string): string => withoutRowMarkers(value.replaceAll(/\u001B\[[0-9;]*m/g, ''));

  for (const [name, colors] of [
    ['dark', darkColors],
    ['light', lightColors],
  ] as const) {
    describe(name, () => {
      const theme = () => createMarkdownTheme(colors);
      const border = (fence: string): string | null =>
        theme().codeBlockBorder?.(fence) ?? null;
      const rowsOf = (source: string, width: number): string[] =>
        (theme().codeBlockLine?.(source, { index: 0, lang: 'bash', width, total: 1 }) ?? '').split(
          '\n',
        );

      it('puts the language on a caption row of its own', () => {
        const caption = border('```bash');
        expect(caption).not.toBeNull();
        expect(strip(caption ?? '')).toContain('bash');
        // The closing fence stays out of the layout.
        expect(border('```')).toBeNull();
        // A fence without a language gets no caption either.
        expect(border('```')).toBeNull();
      });

      it('takes only the language word out of a fence that carries attributes', () => {
        // `marked` hands over the raw info string; a caption that printed
        // `ts title="x"` would just move the junk out of the code row.
        expect(strip(border('```ts title="x"') ?? '')).toBe('\u0020ts');
      });

      it('keeps the language out of every code row', () => {
        const rows = rowsOf('npm cache clean --force && npm i -g', 80);

        for (const row of rows) expect(strip(row)).not.toContain('bash');
      });

      it('gives the full width to the code, so the wrap point is the terminal alone', () => {
        const rows = rowsOf('x'.repeat(100), 40);
        const first = rows[0] ?? '';

        // 1 gutter cell + 39 columns of code: no label columns withheld.
        expect(strip(first)).toHaveLength(40);
        expect(strip(first).endsWith('x')).toBe(true);
      });

      it('round-trips to the source when the rows are copied', () => {
        const source = 'npm cache clean --force && npm i -g scream-code@0.20.6 --prefer-online';
        const rows = rowsOf(source, 40);

        const copied = rows.map((row) => strip(row).trimEnd().slice(1)).join('');
        expect(copied).toBe(source);

        // Hard wrapping keeps every cell at any width (a word wrapper would drop
        // the space at each break: "-gscream-code").
        for (const width of [24, 33, 80]) {
          const joined = rowsOf(source, width)
            .map((row) => strip(row).trimEnd().slice(1))
            .join('');
          expect(joined, `width ${width}`).toBe(source);
        }
      });
    });
  }
});

describe('code rows survive absurd widths', () => {
  const strip = (value: string): string => withoutRowMarkers(value.replaceAll(/\u001B\[[0-9;]*m/g, ''));
  const rowsOf = (source: string, width: number): string[] =>
    (
      createMarkdownTheme(darkColors).codeBlockLine?.(source, {
        index: 0,
        lang: 'bash',
        width,
        total: 1,
      }) ?? ''
    ).split('\n');

  it('never drops the remainder of a line at a width a tab cannot fit', () => {
    // 3-cell tab, 1-cell rows: strict slicing alone would return "" forever and
    // the loop would either spin or drop the rest of the line.
    const rows = rowsOf('\tabc', 2);
    const joined = rows.map((row) => strip(row).trimEnd().slice(1)).join('');

    expect(joined).toBe('\tabc');
  });

  it('keeps a wide character whole instead of losing it', () => {
    const rows = rowsOf('中文中文中文', 5);
    const joined = rows.map((row) => strip(row).trimEnd().slice(1)).join('');

    expect(joined).toBe('中文中文中文');
  });
});
