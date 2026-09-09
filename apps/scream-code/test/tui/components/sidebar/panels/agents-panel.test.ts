import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getLocale, setLocale } from '@scream-code/config';

import { agentsPanel } from '#/tui/components/sidebar/panels/agents-panel';
import type { ColorPalette } from '#/tui/theme/colors';
import type { SidebarPanelContext } from '#/tui/components/sidebar/sidebar-panel';
import { SubagentSlots } from '#/tui/utils/subagent-slots';

const fakePalette = {
  primary: '#79eb00',
  accent: '#f279a2',
  warning: '#e0ae21',
  textDim: '#888888',
  text: '#cccccc',
  textStrong: '#ffffff',
  success: '#3fb950',
  error: '#f85149',
} as unknown as ColorPalette;

function ctx(agents: ReturnType<SubagentSlots['getSlots']>): SidebarPanelContext {
  return {
    requestRender: () => {},
    getData: () => ({ agents }),
    colors: fakePalette,
  };
}

describe('AgentsPanel', () => {
  const originalLocale = getLocale();
  const originalChalkLevel = chalk.level;
  beforeAll(() => {
    setLocale('en');
    chalk.level = 3; // non-TTY test env strips ANSI otherwise
  });
  afterAll(() => {
    setLocale(originalLocale);
    chalk.level = originalChalkLevel;
  });

  it('renders the fixed 8 idle slots, greyed out with the idle label', () => {
    const lines = agentsPanel.build(ctx(new SubagentSlots().getSlots())).render(50);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('coder');
    expect(lines[0]).toContain('idle');
    expect(lines[7]).toContain('writer');
  });

  it('shows status per slot with no live output preview', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-1', 'coder', 'Review the sidebar change');
    const lines = agentsPanel.build(ctx(slots.getSlots())).render(50);
    const coder = lines.find((l) => l.includes('coder'));
    expect(coder).toContain('working');
    // No output preview / description in the line.
    expect(coder).not.toContain('Review the sidebar change');
  });

  it('shows the instance count only when more than one instance shares the slot', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-1', 'coder', 'a');
    let line = agentsPanel.build(ctx(slots.getSlots())).render(50).find((l) => l.includes('coder'))!;
    expect(line).not.toContain('×');

    slots.onSpawned('agent-2', 'coder', 'b');
    slots.onSpawned('agent-3', 'coder', 'c');
    line = agentsPanel.build(ctx(slots.getSlots())).render(50).find((l) => l.includes('coder'))!;
    expect(line).toContain('×3');

    slots.onTerminated('agent-1');
    line = agentsPanel.build(ctx(slots.getSlots())).render(50).find((l) => l.includes('coder'))!;
    expect(line).toContain('×2');
  });

  it('renders all 8 slots as one continuous column with no gaps', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-1', 'explore', 'a');
    slots.onSpawned('agent-2', 'explore', 'b');
    slots.onSpawned('agent-3', 'explore', 'c');
    const lines = agentsPanel.build(ctx(slots.getSlots())).render(42);
    expect(lines).toHaveLength(8);
    lines.forEach((l) => expect(l.trim().length).toBeGreaterThan(0)); // no blank rows
    expect(lines[0]).toContain('coder');
    expect(lines[1]).toContain('explore');
    expect(lines[1]).toContain('×3');
    expect(lines[2]).toContain('plan');
  });

  it('keeps the status word on the same column for idle and busy rows', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-1', 'explore', 'a');
    slots.onSpawned('agent-2', 'explore', 'b');
    const strip = (l: string) => l.replaceAll(/\x1B\[[0-9;]*m/g, '');
    const lines = agentsPanel.build(ctx(slots.getSlots())).render(42);
    const idle = strip(lines[0]!); // coder idle
    const busy = strip(lines[1]!); // explore working ×2
    expect(idle.indexOf('idle')).toBe(busy.indexOf('working'));
    expect(busy.indexOf('working') < busy.indexOf('×2')).toBe(true);
  });

  it('paints busy slots with a true-colour ANSI gradient and the colour changes over time', () => {
    // The idle slots stay grey; only busy ones carry a true-colour escape.
    expect(new SubagentSlots().getSlots().every((s) => s.status === 'idle')).toBe(true);
    const slots = new SubagentSlots();
    slots.onSpawned('agent-1', 'coder', 'a');
    const content = agentsPanel.build(ctx(slots.getSlots()));
    const line1 = content.render(50).find((l) => l.includes('coder'))!;
    expect(line1).toMatch(/\x1B\[38;2;\d+;\d+;\d+m/); // true-colour gradient

    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0 + 0);
      const first = content.render(50).find((l) => l.includes('coder'))!;
      vi.setSystemTime(t0 + 1000);
      const second = content.render(50).find((l) => l.includes('coder'))!;
      // 1s advances half of the 2s cycle → a different gradient colour.
      expect(first).not.toBe(second);
    } finally {
      vi.useRealTimers();
    }
  });
});
