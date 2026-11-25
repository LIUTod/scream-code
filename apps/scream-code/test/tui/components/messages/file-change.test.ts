import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changeRowCount, fileChangeOf, renderFileChange } from '#/tui/components/messages/file-change';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');
const bg = (hex: string): string => {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `\u001B[48;2;${String(r)};${String(g)};${String(b)}m`;
};

function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'c1', name, args } as unknown as ToolCallBlockData;
}
function result(display?: unknown, isError = false): ToolResultBlockData {
  return { tool_call_id: 'c1', output: 'ok', is_error: isError, display } as ToolResultBlockData;
}

/** An edit of lines 42–44: one line replaced, one kept, one added; a gap; one more change further down. */
const edited = result({
  kind: 'file_diff',
  added: 3,
  removed: 2,
  preview: [
    { kind: 'context', line: 41, text: 'function load() {' },
    { kind: 'delete', line: 42, text: '  const a = 1;' },
    { kind: 'add', line: 42, text: '  const a = 10;' },
    { kind: 'context', line: 43, text: '  const b = 2;' },
    { kind: 'add', line: 44, text: '  const c = 3;' },
    { kind: 'gap', count: 30 },
    { kind: 'delete', line: 74, text: '  return a;' },
    { kind: 'add', line: 75, text: '  return a + b + c;' },
  ],
  previewTotal: 5,
});
const editCall = call('Edit', { file_path: '/w/src/load.ts' });

describe('fileChangeOf', () => {
  it('takes the rows with their file line numbers from the result', () => {
    const change = fileChangeOf(editCall, edited);
    expect(change?.rows[1]).toEqual({ kind: 'delete', line: 42, text: '  const a = 1;' });
    expect(change?.total).toBe(5);
    expect(change?.lang).toBe('typescript');
  });

  it('falls back to an edit’s own strings on an older record, without line numbers', () => {
    const change = fileChangeOf(call('Edit', { old_string: 'a\nb', new_string: 'a\nc' }), result());
    expect(change?.rows).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'delete', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
  });

  it('shows nothing for other tools, failed or unfinished calls, or a write it cannot place', () => {
    expect(fileChangeOf(call('Bash'), edited)).toBeUndefined();
    expect(fileChangeOf(editCall, result(undefined, true))).toBeUndefined();
    expect(fileChangeOf(editCall, undefined)).toBeUndefined();
    expect(fileChangeOf(call('Write', { content: 'x' }), result())).toBeUndefined();
  });
});

describe('renderFileChange', () => {
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = level;
  });

  it('folded: only the changed lines, numbered, on full-width red and green bands', () => {
    const change = fileChangeOf(editCall, edited)!;
    const rows = renderFileChange(change, 'folded', 8, 60, darkColors);
    expect(rows.map(strip)).toEqual([
      expect.stringMatching(/^ {2}42 - {3}const a = 1; +$/),
      expect.stringMatching(/^ {2}42 \+ {3}const a = 10; +$/),
      expect.stringMatching(/^ {2}44 \+ {3}const c = 3; +$/),
      expect.stringMatching(/^ {2}74 - {3}return a; +$/),
      expect.stringMatching(/^ {2}75 \+ {3}return a \+ b \+ c; +$/),
    ]);
    for (const row of rows) expect(visibleWidth(row)).toBe(60);
    expect(rows[0]).toContain(bg(darkColors.diffRemovedBg));
    expect(rows[1]).toContain(bg(darkColors.diffAddedBg));
  });

  it('expanded: the same changed rows, plus the unchanged lines and the gap between changes', () => {
    const change = fileChangeOf(editCall, edited)!;
    const folded = renderFileChange(change, 'folded', 20, 60, darkColors).map(strip);
    const expanded = renderFileChange(change, 'expanded', 20, 60, darkColors).map(strip);
    expect(expanded[0]).toMatch(/^ {2}41 {3}function load\(\) \{/);
    expect(expanded[3]).toMatch(/^ {2}43 {5}const b = 2;/);
    expect(expanded[5]).toMatch(/30/); // "… 30 unchanged lines …"
    // Changed rows read identically in both views: same numbers, same text.
    const changed = expanded.filter((row) => /^ +\d+ [+-] /.test(row));
    expect(changed).toEqual(folded);
  });

  it('marks the words a one-line replacement changed, the same way in both views', () => {
    const change = fileChangeOf(editCall, edited)!;
    const mark = bg(darkColors.diffRemovedWordBg);
    for (const view of ['folded', 'expanded'] as const) {
      const rows = renderFileChange(change, view, 20, 60, darkColors);
      const removed = rows.find((row) => strip(row).includes('const a = 1;'))!;
      // The changed "1" sits on the deeper band, in bold; the rest does not.
      expect(removed).toMatch(new RegExp(`${mark.replaceAll('[', '\\[')}\\u001B\\[1m1`));
      expect(removed.split(mark)).toHaveLength(2);
      // "return a;" → "return a + b + c;" changed most of the line: no marks.
      const replaced = rows.find((row) => strip(row).includes('return a;'))!;
      expect(replaced).not.toContain(mark);
    }
  });

  it('caps the rows and counts the rest; folds removed lines whose text is unknown', () => {
    const change = {
      rows: [
        { kind: 'delete' as const, line: 3 },
        { kind: 'delete' as const, line: 4 },
        { kind: 'add' as const, line: 3, text: 'x' },
        { kind: 'add' as const, line: 4, text: 'y' },
      ],
      total: 9,
      lang: undefined,
    };
    const rows = renderFileChange(change, 'folded', 2, 50, darkColors).map(strip);
    expect(rows[0]).toMatch(/3 - .*2/); // "删除 2 行" / "2 lines removed"
    expect(rows[1]).toMatch(/3 \+ x/);
    expect(rows[2]).toMatch(/6/); // 9 changed − (2 folded + 1 shown) = 6 more
    expect(rows).toHaveLength(3);
    expect(changeRowCount(change, 'folded', 2)).toBe(3);
  });

  it('never ends a cut on an unchanged line', () => {
    const change = fileChangeOf(editCall, edited)!;
    const rows = renderFileChange(change, 'expanded', 4, 60, darkColors).map(strip);
    // 41 context, 42 -, 42 +, then the count — not "43 const b" before it.
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatch(/42 \+/);
    expect(rows[3]).toMatch(/3/);
  });

  it('highlights the code by the file’s language', () => {
    const plain = fileChangeOf(call('Edit', { file_path: '/w/notes' }), edited)!;
    const typed = fileChangeOf(editCall, edited)!;
    const row = (change: typeof plain): string => renderFileChange(change, 'folded', 1, 60, darkColors)[0]!;
    expect(strip(row(plain))).toBe(strip(row(typed)));
    expect(row(plain)).not.toBe(row(typed));
  });

  it('draws no band below 256 colours, and nothing at a zero limit', () => {
    const change = fileChangeOf(editCall, edited)!;
    chalk.level = 1;
    expect(renderFileChange(change, 'folded', 4, 60, darkColors)[0]).not.toMatch(/\u001B\[4[0-9;]*m|\u001B\[48;/);
    expect(renderFileChange(change, 'folded', 0, 60, darkColors)).toEqual([]);
  });
});
