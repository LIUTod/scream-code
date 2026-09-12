import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getLocale, setLocale } from '@scream-code/config';

import { goalPanel } from '#/tui/components/sidebar/panels/goal-panel';
import { displayWidth } from '#/tui/utils/display-width';
import type { ColorPalette } from '#/tui/theme/colors';
import type { SidebarPanelContext } from '#/tui/components/sidebar/sidebar-panel';
import type { SidebarData } from '#/tui/components/sidebar/sidebar-panel';

const fakePalette = {
  primary: '#79eb00',
  accent: '#f279a2',
  warning: '#e0ae21',
  success: '#3fb950',
  textDim: '#888888',
  text: '#cccccc',
} as unknown as ColorPalette;

function ctx(goal: SidebarData['goal']): SidebarPanelContext {
  return {
    requestRender: () => {},
    getData: () => ({ goal }),
    colors: fakePalette,
  };
}

const baseGoal = {
  objective: 'Ship the sidebar',
  turnsUsed: 8,
  wallClockMs: 0,
  wallClockBaseAt: Date.now(),
  continuationCount: 0,
  completionCriterion: 'tests pass',
  tokensUsed: 12345,
  inputTokens: 9000,
  outputTokens: 3345,
  judge: 'awaiting' as const,
};

describe('GoalPanel', () => {
  // Captured inside beforeAll: vitest reuses one worker across files, so a
  // describe-time snapshot could inherit another file's locale.
  let originalLocale: ReturnType<typeof getLocale> | undefined;
  beforeAll(() => {
    originalLocale = getLocale();
    setLocale('en');
  });
  afterAll(() => {
    if (originalLocale !== undefined) setLocale(originalLocale);
  });

  it('shows a resting placeholder when no goal snapshot exists', () => {
    const lines = goalPanel.build(ctx(undefined)).render(40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no goal');
  });

  it('renders active goal with the token/turn/judge two-column metrics', () => {
    const lines = goalPanel.build(ctx({ ...baseGoal, status: 'active' })).render(40);
    const text = lines.join('\n');
    expect(text).toContain('active');
    expect(text).toContain('Ship the sidebar');
    expect(text).toContain('12,345'); // tokens
    expect(text).toContain('9,000'); // input tokens
    expect(text).toContain('3,345'); // output tokens
    expect(text).toContain('judge');
    expect(text).toContain('awaiting');
    expect(text).toContain('criterion');
    expect(text).toContain('tests pass');
  });

  it('shows a dash for legacy goals without per-direction token counts', () => {
    const lines = goalPanel
      .build(ctx({ ...baseGoal, status: 'active', inputTokens: null, outputTokens: null }))
      .render(40)
      .join('\n');
    expect(lines).toContain('—');
    expect(lines).not.toContain('9,000');
  });

  it('paused goal shows the paused badge, NOT completed (interrupted-goal bug)', () => {
    const lines = goalPanel.build(ctx({ ...baseGoal, status: 'paused' })).render(40);
    const text = lines.join('\n');
    expect(text).toContain('paused');
    expect(text).not.toContain('completed');
  });

  it('judging state overrides the badge with the adjudication marker', () => {
    const lines = goalPanel
      .build(ctx({ ...baseGoal, status: 'active', judge: 'judging' }))
      .render(40)
      .join('\n');
    expect(lines).toContain('judging');
  });

  it('freezes the wall-clock for non-active goals and only ticks while active', () => {
    const base = Date.now();
    const pausedCtx = ctx({ ...baseGoal, status: 'paused', wallClockMs: 60_000, wallClockBaseAt: base });
    const pausedPanel = goalPanel.build(pausedCtx);
    const linePausedA = pausedPanel.render(40).join('\n');
    // Simulate time passing; a paused goal must NOT grow its wall clock.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base + 5 * 60_000);
      const linePausedB = pausedPanel.render(40).join('\n');
      expect(linePausedA).toBe(linePausedB); // frozen

      const activeCtx = ctx({ ...baseGoal, status: 'active', wallClockMs: 60_000, wallClockBaseAt: base });
      const activePanel = goalPanel.build(activeCtx);
      vi.setSystemTime(base);
      const lineActiveA = activePanel.render(40).join('\n');
      vi.setSystemTime(base + 5 * 60_000);
      const lineActiveB = activePanel.render(40).join('\n');
      expect(lineActiveA).not.toBe(lineActiveB); // ticks while active
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the criterion row on the same value column as the metrics', () => {
    const lines = goalPanel
      .build(ctx({ ...baseGoal, status: 'active', completionCriterion: 'the reviewer approves' }))
      .render(34);
    const strip = (l: string) => l.replaceAll(/\u001B\[[0-9;]*m/g, '');
    const bare = lines.map(strip);
    const label = (line: string): string => line.replace(/^[●○]\s*/, '');
    const metricRow = bare.find((l) => label(l).startsWith('tokens'));
    const criterionRow = bare.find((l) => label(l).startsWith('criterion'));
    expect(metricRow).toBeDefined();
    expect(criterionRow).toBeDefined();

    // Shared grid contract: every row pays the marker column, and both readings
    // end on the panel's inner edge — the free-text criterion is pulled left
    // rather than truncated just to keep the column.
    expect(metricRow!.startsWith('● tokens')).toBe(true);
    expect(criterionRow!.startsWith('● criterion')).toBe(true);
    expect(displayWidth(metricRow!)).toBe(34);
    expect(displayWidth(criterionRow!)).toBe(34);
    expect(criterionRow).toContain('the reviewer approves');
    expect(bare.every((l) => displayWidth(l) <= 34)).toBe(true);
  });
});
