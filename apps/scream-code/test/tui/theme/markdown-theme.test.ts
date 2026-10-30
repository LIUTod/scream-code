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
