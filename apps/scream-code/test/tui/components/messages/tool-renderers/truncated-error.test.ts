import { describe, expect, it } from 'vitest';

import chalk from 'chalk';

// Force truecolor so chalk.hex emits deterministic \x1b[38;2;r;g;bm prefixes.
chalk.level = 3;

import { TruncatedOutputComponent } from '#/tui/components/messages/tool-renderers/truncated';
import { darkColors } from '#/tui/theme/colors';

// darkColors.error = '#E85454' -> RGB(232,84,84) -> \x1b[38;2;232;84;84m
const ERROR_FG = '\x1B[38;2;232;84;84m';
const RESET = '\x1B[39m';

describe('TruncatedOutputComponent error path', () => {
  it('strips original ANSI codes from error output for uniform tinting', () => {
    // Simulate npm/npx color output in PTY mode (red/green fg + reset)
    const output = '\x1B[31merror line\x1B[0m\n\x1B[32msecond line\x1B[0m';
    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: true,
      colors: darkColors,
    });
    const raw = component.render(80).join('\n');
    // Original ANSI codes must be stripped
    expect(raw).not.toContain('\x1B[31m');
    expect(raw).not.toContain('\x1B[32m');
    expect(raw).not.toContain('\x1B[0m');
    // Error tint must be present
    expect(raw).toContain(ERROR_FG);
    // Text content preserved
    expect(raw).toContain('error line');
    expect(raw).toContain('second line');
  });

  it('tints error output per-line with independent reset', () => {
    const component = new TruncatedOutputComponent('line1\nline2\nline3', {
      expanded: true,
      isError: true,
      colors: darkColors,
    });
    const lines = component.render(80);
    // Every content line should carry its own error tint prefix
    const tintedLines = lines.filter((l) => l.includes(ERROR_FG));
    expect(tintedLines.length).toBe(3);
    // Every tinted line should also carry a reset (per-line reset prevents
    // padding spaces from inheriting the fg color)
    for (const line of tintedLines) {
      expect(line).toContain(RESET);
    }
  });

  it('preserves ANSI codes in non-error output', () => {
    const output = '\x1B[32mgreen text\x1B[0m';
    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
    });
    const raw = component.render(80).join('\n');
    // Non-error path must NOT strip ANSI codes
    expect(raw).toContain('\x1B[32m');
  });

  it('handles empty error output without throwing', () => {
    expect(() => {
      const component = new TruncatedOutputComponent('', {
        expanded: false,
        isError: true,
        colors: darkColors,
      });
      component.render(80);
    }).not.toThrow();
  });
});
