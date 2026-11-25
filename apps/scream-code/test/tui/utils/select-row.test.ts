import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { darkColors, lightColors } from '#/tui/theme/colors';
import { pointerCell, selectableRow, selectedRow } from '#/tui/utils/select-row';

describe('selected row', () => {
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = level;
  });

  // Dark bar: #79eb00 with #0d1600 text and #1f3a00 notes.
  const BAR = '48;2;121;235;0';
  const FG = '38;2;13;22;0';

  it('fills the whole width with the bar, also past inner colour resets', () => {
    const line = `${pointerCell(darkColors, true)}${chalk.bold('Model')}\u001B[0m tail`;
    const painted = selectedRow(darkColors, line, 30);
    expect(visibleWidth(painted)).toBe(30);
    expect(painted.startsWith(`\u001B[${BAR};${FG}m`)).toBe(true);
    // A full reset inside the line reopens the bar and its text colour.
    expect(painted).toContain(`\u001B[0;${BAR};${FG}m tail`);
    expect(painted.endsWith('\u001B[39;49m')).toBe(true);
  });

  it('leaves other rows alone and keeps the pointer cell two wide', () => {
    expect(selectableRow(darkColors, 'plain', 30, false)).toBe('plain');
    expect(visibleWidth(pointerCell(darkColors, true))).toBe(2);
    expect(pointerCell(darkColors, false)).toBe('  ');
  });

  it('draws no bar when colour is off or limited to 16 colours', () => {
    chalk.level = 0;
    expect(selectedRow(darkColors, 'abc', 6)).toBe('abc   ');
    chalk.level = 1;
    expect(selectedRow(darkColors, 'abc', 6)).toBe('abc   ');
    chalk.level = 2;
    expect(selectedRow(darkColors, 'abc', 6)).toMatch(/^\u001B\[48;5;\d+;38;5;\d+mabc {3}\u001B\[39;49m$/);
  });

  it('repaints every colour of the row so nothing green sits on the green bar', () => {
    const line = [
      chalk.hex(darkColors.primary)('❯ '),
      chalk.hex(darkColors.primary).bold('Model'),
      chalk.hex(darkColors.textMuted)(' note'),
      chalk.hex(darkColors.success)(' ← 当前'),
      chalk.hex(darkColors.error)(' failed'),
    ].join('');
    const painted = selectedRow(darkColors, line, 40);
    expect(painted).not.toMatch(/\u001B\[[0-9;]*38;2;121;235;0/); // no green text left
    expect(painted).not.toContain('38;2;232;84;84'); // nor the error red
    expect(painted).toContain(`\u001B[${FG}m\u001B[1mModel`); // label in the bar text colour, still bold
    expect(painted).toContain('\u001B[38;2;31;58;0m note'); // muted → selectionMuted
    expect(painted).toContain('\u001B[1m'); // bold kept
    // Each colour's own close (39) and any background close (49) keep the bar.
    expect(painted).not.toMatch(/\u001B\[(?:[0-9;]*;)?39m/);
    expect(painted).not.toMatch(/\u001B\[49m/);
  });

  it('keeps the reverse-video input cursor and replaces inner backgrounds with the bar', () => {
    const line = `edit\u001B[7m \u001B[27m${chalk.bgHex('#4d242b')('x')}`;
    const painted = selectedRow(darkColors, line, 10);
    expect(painted).toContain('\u001B[7m \u001B[27m');
    expect(painted).not.toContain('48;2;77;36;43');
  });

  it('inverts in the light palette too: white text on the deep green bar', () => {
    const painted = selectedRow(lightColors, chalk.hex(lightColors.primary)('Model'), 10);
    expect(painted.startsWith('\u001B[48;2;75;122;6;38;2;255;255;255m')).toBe(true);
    expect(painted).toContain('\u001B[38;2;255;255;255mModel');
  });
});
