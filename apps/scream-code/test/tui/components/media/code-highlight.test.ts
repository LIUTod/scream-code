import { describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { darkColors, lightColors } from '#/tui/theme/colors';

import { captureProcessWrite } from '../../../helpers/process';

describe('code-highlight', () => {
  it('maps known file extensions to supported highlight languages', () => {
    expect(langFromPath('src/foo.ts')).toBe('typescript');
    expect(langFromPath('src/foo.TS')).toBe('typescript');
  });

  it('treats unsupported file extensions as plain text', () => {
    expect(langFromPath('src/foo.abcxyz')).toBeUndefined();
  });

  it('does not call cli-highlight for unsupported languages', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      expect(highlightLines('hello\nworld', 'abcxyz', lightColors)).toEqual(['hello', 'world']);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('maps code tokens through the theme palette (not terminal 16-color ANSI)', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const code = 'const n = 1; // hi';
      const light = highlightLines(code, 'typescript', lightColors).join('\n');
      const dark = highlightLines(code, 'typescript', darkColors).join('\n');

      // Keyword "const" must be tinted with the theme's code color: light
      // blue (#1565C0) in light mode, bright blue (#9CDCFE) in dark mode. If
      // the theme were ignored, both would be cli-highlight's blue 16-color
      // ANSI (ESC[34m) with no truecolor sequence at all.
      expect(light).toContain('\u001B[38;2;21;101;192m'); // #1565C0
      expect(dark).toContain('\u001B[38;2;156;220;254m'); // #9CDCFE

      // The two themes must differ — the palette flip actually reaches the output.
      expect(light).not.toBe(dark);
    } finally {
      chalk.level = previousLevel;
    }
  });
});

