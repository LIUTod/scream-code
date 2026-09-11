import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getLocale, setLocale } from '@scream-code/config';

import { sessionPanel } from '#/tui/components/sidebar/panels/session-panel';
import { displayWidth } from '#/tui/utils/display-width';
import type { ColorPalette } from '#/tui/theme/colors';
import type { SidebarPanelContext } from '#/tui/components/sidebar/sidebar-panel';
import type { SidebarData } from '#/tui/components/sidebar/sidebar-panel';

const fakePalette = {
  primary: '#79eb00',
  textDim: '#888888',
  text: '#cccccc',
} as unknown as ColorPalette;

function ctx(sessionStats: SidebarData['sessionStats']): SidebarPanelContext {
  return {
    requestRender: () => {},
    getData: () => ({ sessionStats }),
    colors: fakePalette,
  };
}

const baseStats = {
  turns: 12,
  toolCalls: 87,
  compactions: 2,
  apiCalls: 317,
  tokensTotal: 227_594_582,
  tokensInputCacheHit: 224_079_377,
  tokensInputCacheMiss: 3_000_000,
  tokensOutput: 515_205,
  startedAt: Date.now() - 60_000,
};

describe('SessionPanel', () => {
  const originalLocale = getLocale();
  beforeAll(() => setLocale('en'));
  afterAll(() => setLocale(originalLocale));

  it('shows the empty state when no session data is present', () => {
    const lines = sessionPanel.build(ctx(undefined)).render(40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no session data');
  });

  it('clamps the value column so short values survive a narrow sidebar', () => {
    const lines = sessionPanel.build(ctx(baseStats)).render(16);
    const strip = (l: string) => l.replaceAll(/\u001B\[[0-9;]*m/g, '');
    const bare = lines.map(strip);

    // "Tool calls" (10) + gap (2) leaves 4 columns for values. The wide token
    // rows are cut, but a short value must never be pushed out of the frame
    // by its widest neighbour (right-aligned values used to vanish entirely).
    expect(bare.every((l) => displayWidth(l) <= 16)).toBe(true);
    expect(bare[5]).toMatch(/^Turns\s+12$/);
    expect(bare[8]).toMatch(/^Compacts\s+2$/);
  });

  it('switches token values to compact units when the sidebar is narrow', () => {
    const lines = sessionPanel.build(ctx(baseStats)).render(20);
    const strip = (l: string) => l.replaceAll(/\u001B\[[0-9;]*m/g, '');
    const bare = lines.map(strip);

    // Compact instead of a cut-off "227,59".
    expect(bare[0]).toMatch(/^Total\s+227\.6M$/);
    expect(bare[1]).toMatch(/^Cached\s+224\.1M$/);
    expect(bare[2]).toMatch(/^Uncached\s+3\.0M$/);
    expect(bare[3]).toMatch(/^Output\s+515K$/);
    // Nothing overflows the available columns and the grid stays aligned.
    expect(bare.every((l) => displayWidth(l) <= 20)).toBe(true);
    expect(new Set(bare.map((l) => displayWidth(l))).size).toBe(1);
  });

  it('renders one field per row on a shared two-column grid', () => {
    const lines = sessionPanel.build(ctx(baseStats)).render(46);
    const strip = (l: string) => l.replaceAll(/\u001B\[[0-9;]*m/g, '');
    const bare = lines.map(strip);
    const text = bare.join('\n');

    expect(text).toContain('227,594,582');
    expect(text).toContain('224,079,377');
    expect(text).toContain('3,000,000');
    expect(text).toContain('515,205');
    expect(text).toContain('317');

    // Nine fields, one per row: the paired "turns · tools" lines are gone.
    expect(bare).toHaveLength(9);
    expect(bare[0]).toMatch(/^Total\s+227,594,582$/);
    expect(bare[5]).toMatch(/^Turns\s+12$/);
    expect(bare[6]).toMatch(/^Tool calls\s+87$/);
    expect(bare[7]).toMatch(/^API calls\s+317$/);
    expect(bare[8]).toMatch(/^Compacts\s+2$/);

    // Fixed label column + right-aligned values => every row has exactly the
    // same display width, so both edges line up (CJK-aware).
    const widths = new Set(bare.map((l) => displayWidth(l)));
    expect(widths.size).toBe(1);
  });
});
