import { describe, expect, it } from 'vitest';

import { sanitizeShellOutput } from '@/tui/utils/sanitize';

describe('sanitizeShellOutput', () => {
  it('preserves plain printable text', () => {
    expect(sanitizeShellOutput('plain output line')).toBe('plain output line');
  });

  it('removes carriage returns used by progress redraws', () => {
    const input = 'Downloading 25%\rDownloading 75%\rDone';
    expect(sanitizeShellOutput(input)).toBe('Downloading 25%Downloading 75%Done');
  });

  it('strips ANSI escape sequences (screen clear, cursor move, SGR color)', () => {
    const input = 'a\u001B[2Jb\u001B[1;1Hc\u001B[31mred\u001B[0m';
    expect(sanitizeShellOutput(input)).toBe('abcred');
  });

  it('strips OSC sequences (title / clipboard) up to ST or BEL', () => {
    const input = '\u001B]0;title\u0007visible\u001B]52;c;ZWNobyBoYXg=\u001B\\tail';
    expect(sanitizeShellOutput(input)).toBe('visibletail');
  });

  it('strips DCS / PM / APC sequences up to ST or BEL', () => {
    const input = '\u001BP1;2|payload\u001B\\visible\u001B^pm\u0007end\u001B_apc\u001B\\';
    expect(sanitizeShellOutput(input)).toBe('visibleend');
  });

  it('strips charset-selection and single-char selectors', () => {
    const input = '\u001B(B\u001B)0\u001B>selectable\u001B=';
    expect(sanitizeShellOutput(input)).toBe('selectable');
  });

  it('keeps newlines intact so multi-line output stays multi-line', () => {
    expect(sanitizeShellOutput('line1\nline2\nline3')).toBe('line1\nline2\nline3');
  });
});
