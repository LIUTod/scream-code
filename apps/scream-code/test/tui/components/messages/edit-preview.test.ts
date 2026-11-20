import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editPreviewOf, previewRowCount, renderEditPreview } from '#/tui/components/messages/edit-preview';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

function call(name: string, args: Record<string, unknown>): ToolCallBlockData {
  return { id: 'c1', name, args } as unknown as ToolCallBlockData;
}
function result(display?: unknown, isError = false): ToolResultBlockData {
  return { tool_call_id: 'c1', output: 'ok', is_error: isError, display } as ToolResultBlockData;
}

const edited = result({
  kind: 'file_diff',
  added: 2,
  removed: 1,
  preview: [
    { kind: 'delete', line: 128, text: 'const a = 1;' },
    { kind: 'add', line: 128, text: 'const a = 2;' },
    { kind: 'add', line: 129, text: 'const b = 3;' },
  ],
  previewTotal: 3,
});

describe('editPreviewOf', () => {
  it('takes the changed lines with their file line numbers from the result', () => {
    expect(editPreviewOf(call('Edit', {}), edited)?.rows[0]).toEqual({ kind: 'delete', line: 128, text: 'const a = 1;' });
  });

  it('falls back to an edit’s own strings on a replayed record, without line numbers', () => {
    const preview = editPreviewOf(call('Edit', { old_string: 'a\nb', new_string: 'a\nc' }), result());
    expect(preview?.rows).toEqual([
      { kind: 'delete', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
  });

  it('shows nothing for other tools, failed or unfinished calls, or a write it cannot place', () => {
    expect(editPreviewOf(call('Bash', {}), edited)).toBeUndefined();
    expect(editPreviewOf(call('Edit', {}), result(undefined, true))).toBeUndefined();
    expect(editPreviewOf(call('Edit', {}), undefined)).toBeUndefined();
    expect(editPreviewOf(call('Write', { content: 'x' }), result())).toBeUndefined();
  });
});

describe('renderEditPreview', () => {
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = level;
  });

  it('paints removed lines red and added lines green across the full width', () => {
    const preview = editPreviewOf(call('Edit', {}), edited)!;
    const rows = renderEditPreview(preview, 4, 60, darkColors, '  │  ');
    expect(rows.map(strip)).toEqual([
      expect.stringMatching(/^ {2}│ {3}128 - const a = 1; +$/),
      expect.stringMatching(/^ {2}│ {3}128 \+ const a = 2; +$/),
      expect.stringMatching(/^ {2}│ {3}129 \+ const b = 3; +$/),
    ]);
    for (const row of rows) expect(visibleWidth(row)).toBe(60);
    expect(rows[0]).toContain('\u001B[48;2;77;36;43m'); // diffRemovedBg
    expect(rows[1]).toContain('\u001B[48;2;36;66;42m'); // diffAddedBg
  });

  it('caps the rows and counts the rest; folds removed lines whose text is unknown', () => {
    const preview = {
      rows: [
        { kind: 'delete' as const, line: 3 },
        { kind: 'delete' as const, line: 4 },
        { kind: 'add' as const, line: 3, text: 'x' },
        { kind: 'add' as const, line: 4, text: 'y' },
      ],
      total: 9,
    };
    const rows = renderEditPreview(preview, 2, 50, darkColors, '     ').map(strip);
    expect(rows[0]).toMatch(/3 - .*2/); // "删除 2 行" / "2 lines removed"
    expect(rows[1]).toMatch(/3 \+ x/);
    expect(rows[2]).toMatch(/6/); // 9 changed − (2 folded + 1 shown) = 6 more
    expect(rows).toHaveLength(3);
    expect(previewRowCount(preview, 2)).toBe(3);
  });

  it('draws no background below 256 colours, and nothing at a zero limit', () => {
    const preview = editPreviewOf(call('Edit', {}), edited)!;
    chalk.level = 1;
    expect(renderEditPreview(preview, 4, 60, darkColors, '')[0]).not.toMatch(/\u001B\[4[0-9;]*m|\u001B\[48;/);
    expect(renderEditPreview(preview, 0, 60, darkColors, '')).toEqual([]);
  });
});
