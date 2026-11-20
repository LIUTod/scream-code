import { visibleWidth } from '@liutod-scream/pi-tui';
import { describe, expect, it, vi } from 'vitest';

vi.mock('#/tui/utils/ui-preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/utils/ui-preferences')>();
  // The documented defaults, whatever this machine's /blockrows says.
  return { ...actual, readActivityLinePrefs: () => ({}) };
});

import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { darkColors } from '#/tui/theme/colors';
import { refreshActivityLines } from '#/tui/utils/activity-lines';

const WIDTH = 100;
const strip = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');

function edit(id: string, file: string, line: number): ToolCallComponent {
  return new ToolCallComponent(
    { id, name: 'Edit', args: { file_path: `/workspace/${file}`, old_string: 'old', new_string: 'new' } },
    {
      tool_call_id: id,
      output: 'ok',
      is_error: false,
      display: {
        kind: 'file_diff',
        added: 2,
        removed: 1,
        preview: [
          { kind: 'delete', line, text: `${file} old` },
          { kind: 'add', line, text: `${file} new` },
          { kind: 'add', line: line + 1, text: `${file} extra` },
        ],
        previewTotal: 3,
      },
    },
    darkColors,
  );
}

describe('ActivityGroupComponent — inline edit previews while folded', () => {
  it('shows the changed lines under each edit that fits, the newest always, within the block budget', () => {
    refreshActivityLines();
    const group = new ActivityGroupComponent(darkColors, undefined);
    for (let i = 1; i <= 6; i++) group.attachTool(edit(`e${String(i)}`, `f${String(i)}.ts`, i * 10), i);
    const raw = group.render(WIDTH);
    const rows = raw.map(strip).filter((row) => row.trim().length > 0);

    // Header + 13 rows (default budget 14).
    expect(rows.length).toBeLessThanOrEqual(14);
    // The newest edit: header then its three changed lines, numbered.
    const newest = rows.findIndex((row) => row.includes('f6.ts') && !row.includes(' old') && !row.includes(' new'));
    expect(rows[newest + 1]).toMatch(/60 - f6\.ts old/);
    expect(rows[newest + 2]).toMatch(/60 \+ f6\.ts new/);
    expect(rows[newest + 3]).toMatch(/61 \+ f6\.ts extra/);
    // The preview sits inside the tree: the last row stays open (├─ / │) and
    // the tree closes on the preview's last line.
    expect(rows[newest]).toMatch(/^ {2}├─/);
    expect(rows[newest + 1]).toMatch(/^ {2}│/);
    expect(rows[newest + 3]).toMatch(/^ {2}└/);
    expect(rows.at(-1)).toBe(rows[newest + 3]);
    // An older edit that no longer fits keeps its header row alone.
    expect(rows.some((row) => row.includes('f3.ts') && !row.includes(' old'))).toBe(true);
    expect(rows.some((row) => row.includes('f3.ts old'))).toBe(false);
    for (const line of raw) if (line.length > 0) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
  });
});
