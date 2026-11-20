import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { darkColors } from '#/tui/theme/colors';
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

  it('fills the whole width with the bar, also past inner colour resets', () => {
    const line = `${pointerCell(darkColors, true)}${chalk.bold('Model')}\u001B[0m tail`;
    const painted = selectedRow(darkColors, line, 30);
    expect(visibleWidth(painted)).toBe(30);
    const open = '\u001B[48;2;59;81;36m';
    expect(painted.startsWith(open)).toBe(true);
    // The bar is reopened right after the full reset inside the line.
    expect(painted).toContain(`\u001B[0m${open}`);
    expect(painted.endsWith('\u001B[49m')).toBe(true);
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
    expect(selectedRow(darkColors, 'abc', 6)).toMatch(/^\u001B\[48;5;\d+mabc {3}\u001B\[49m$/);
  });

  it('lifts dim grey text on the bar so it stays readable, and leaves other colours', () => {
    const line = `${chalk.hex(darkColors.textMuted)('note')} ${chalk.hex(darkColors.primary)('Model')}`;
    const painted = selectedRow(darkColors, line, 30);
    expect(painted).toContain('\u001B[38;2;184;196;168mnote');
    expect(painted).not.toContain('\u001B[38;2;118;118;118m');
    expect(painted).toContain('\u001B[38;2;121;235;0mModel');
  });
});
