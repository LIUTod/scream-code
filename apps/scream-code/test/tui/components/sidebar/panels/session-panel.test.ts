import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getLocale, setLocale } from '@scream-code/config';

import { sessionPanel } from '#/tui/components/sidebar/panels/session-panel';
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
  messages: 1204,
  compactions: 2,
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

  it('renders the bucket rows with aligned value columns', () => {
    const lines = sessionPanel.build(ctx(baseStats)).render(46);
    const text = lines.join('\n');
    expect(text).toContain('227,594,582');
    expect(text).toContain('224,079,377');
    expect(text).toContain('3,000,000');
    expect(text).toContain('515,205');

    // Alignment: all values start on the same column (labels padded to the
    // widest label, CJK-aware).
    const strip = (l: string) => l.replaceAll(/\x1B\[[0-9;]*m/g, '');
    const valueStartCols = lines
      .slice(0, 5)
      .map((l) => {
        const bare = strip(l);
        const match = /(\d[\d,]*|\d+[smh])/u.exec(bare)?.[1];
        return match === undefined ? -1 : bare.indexOf(match);
      });
    expect(new Set(valueStartCols).size).toBe(1);
  });
});
