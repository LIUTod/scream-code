import { getCapabilities, resetCapabilitiesCache, setCapabilities } from '@liutod-scream/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#/tui/utils/ui-preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/utils/ui-preferences')>();
  return { ...actual, readActivityLinePrefs: () => ({}) };
});

import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { darkColors } from '#/tui/theme/colors';
import { refreshActivityLines } from '#/tui/utils/activity-lines';

const WIDTH = 90;
const strip = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageRead(): ToolCallComponent {
  const output = JSON.stringify([
    { type: 'text', text: '<image path="/w/shots/home.png">' },
    { type: 'image_url', imageUrl: { url: `data:image/png;base64,${PNG}` } },
  ]);
  return new ToolCallComponent(
    { id: 'm1', name: 'ReadMediaFile', args: { path: '/w/shots/home.png' } },
    { tool_call_id: 'm1', output, is_error: false },
    darkColors,
  );
}

describe('ActivityGroupComponent — image reads', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('is one row while folded and shows the thumbnail inside the tree once expanded', () => {
    setCapabilities({ ...getCapabilities(), images: 'kitty' });
    refreshActivityLines();
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(imageRead(), 1);
    group.setRunning(false);

    const folded = group.render(WIDTH).filter((row) => strip(row).trim().length > 0);
    expect(folded).toHaveLength(2);
    expect(strip(folded[1]!)).toMatch(/^ {2}└─ ✓ .*ReadMediaFile/);
    expect(folded.some((row) => row.includes('\u001B_G'))).toBe(false);

    group.setExpanded(true);
    const rows = group.render(WIDTH);
    const head = rows.findIndex((row) => strip(row).includes('ReadMediaFile'));
    expect(strip(rows[head]!)).toMatch(/^ {2}├─/);
    // The image escape is drawn after the tree prefix, on the row under the step.
    expect(rows[head + 1]?.startsWith('  └     ') || rows[head + 1]?.startsWith('  │     ')).toBe(true);
    expect(rows[head + 1]).toContain('\u001B_G');
    expect(rows.at(-1)?.startsWith('  └')).toBe(true);
  });

  it('shows no picture where the terminal cannot draw one: the row names the file', () => {
    setCapabilities({ ...getCapabilities(), images: null });
    refreshActivityLines();
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(imageRead(), 1);
    group.setRunning(false);
    group.setExpanded(true);
    const rows = group.render(WIDTH).filter((row) => strip(row).trim().length > 0);
    expect(rows.some((row) => row.includes('\u001B_G'))).toBe(false);
    expect(strip(rows.at(-1)!)).toMatch(/^ {2}└─ ✓ .*home\.png/);
  });
});
