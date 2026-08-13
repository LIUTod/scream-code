import { afterEach, describe, expect, it, vi } from 'vitest';

import { visibleWidth } from '@liutod-scream/pi-tui';
import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { darkColors } from '#/tui/theme/colors';

const THROTTLE_WAIT_MS = 300;

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeAgent(id: string, description: string, activity: string): ToolCallComponent {
  const tc = new ToolCallComponent(
    { id, name: 'Agent', args: { description } },
    undefined,
    darkColors,
  );
  tc.onSubagentSpawned({ agentId: `sub_${id}`, agentName: 'coder', runInBackground: false });
  tc.appendSubagentText(activity, 'thinking');
  return tc;
}

const WOLFPACK_DESC =
  '并行整理明朝奇闻趣事: /Users/tod/Desktop/明朝奇闻-宫廷秘闻 ::\n宫廷秘闻（皇帝后宫、朝堂内幕、皇家怪事）';
const LONG_ACTIVITY =
  "4. Search the web for at least 8 real, documented Ming Dynasty anecdotes about " +
  "imperial palace secrets (emperors' harem, court)";

describe('AgentGroupComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a full-width tree whose rows never overflow the viewport', () => {
    const group = new AgentGroupComponent(darkColors, undefined);
    for (let i = 0; i < 5; i++) {
      group.attach(
        `call_${i}`,
        makeAgent(`call_${i}`, WOLFPACK_DESC, LONG_ACTIVITY),
      );
    }
    const lines = group.render(60).map(strip);
    expect(lines.length).toBeGreaterThan(0);
    // Non-empty rows (header + tree body; the leading Spacer emits an
    // empty row by design) must all be exactly the viewport width.
    const nonEmpty = lines.filter((l) => l.length > 0);
    expect(nonEmpty.length).toBeGreaterThan(0);
    for (const line of nonEmpty) {
      expect(visibleWidth(line)).toBe(60);
    }
  });

  it('keeps the tree connected: every row carries a branch or vertical connector', () => {
    const group = new AgentGroupComponent(darkColors, undefined);
    for (let i = 0; i < 3; i++) {
      group.attach(`call_${i}`, makeAgent(`call_${i}`, WOLFPACK_DESC, LONG_ACTIVITY));
    }
    const lines = group.render(60).map(strip);
    // Tree body rows start with the two-space indent plus a connector
    // column that is ├ └ or │. The header row (■ …) and the Spacer row are
    // skipped.
    const bodyRows = lines.filter((l) => l.startsWith('  '));
    expect(bodyRows.length).toBeGreaterThan(0);
    for (const line of bodyRows) {
      const connector = line[2];
      expect(['├', '└', '│', ' ']).toContain(connector);
    }
    // The row right under a non-last branch head keeps the vertical line.
    const headIdx = lines.findIndex((l) => l.startsWith('  ├'));
    const secondRow = lines[headIdx + 1];
    expect(secondRow?.[2]).toBe('│');
  });

  it('keeps the group height stable while activity streams (no bounce)', () => {
    vi.useFakeTimers();
    const tc = makeAgent('call_1', '整理明朝科举轶事', 'short activity');
    const group = new AgentGroupComponent(darkColors, undefined);
    group.attach('call_1', tc);
    const heightBefore = group.render(60).length;

    // Activity keeps growing past the viewport width; the truncated single
    // row must keep the total height unchanged.
    tc.appendSubagentText('x'.repeat(400), 'thinking');
    vi.advanceTimersByTime(THROTTLE_WAIT_MS);
    const heightAfter = group.render(60).length;
    expect(heightAfter).toBe(heightBefore);
  });

  it('wraps failed error lines with the vertical connector preserved', () => {
    vi.useFakeTimers();
    const failedTc = new ToolCallComponent(
      { id: 'call_fail', name: 'Agent', args: { description: 'fails' } },
      undefined,
      darkColors,
    );
    failedTc.onSubagentSpawned({ agentId: 'sub_fail', agentName: 'coder', runInBackground: false });
    failedTc.appendSubagentText('x'.repeat(400), 'thinking');
    failedTc.onSubagentFailed({ error: 'a very long error message '.repeat(10) + 'boom' });
    vi.advanceTimersByTime(THROTTLE_WAIT_MS);

    const group = new AgentGroupComponent(darkColors, undefined);
    // First of two entries: not the last branch, so the connector must live.
    group.attach('call_fail', failedTc);
    group.attach('call_ok', makeAgent('call_ok', 'fine', 'working'));
    vi.advanceTimersByTime(THROTTLE_WAIT_MS);

    const lines = group.render(60).map(strip);
    const errIdx = lines.findIndex((l) => l.includes('error'));
    expect(errIdx).toBeGreaterThan(0);
    // The failed entry is not last, so its error row keeps the │ connector.
    expect(lines[errIdx]?.[2]).toBe('│');
    // Wrapped continuations of the error keep the connector until the next
    // branch head.
    for (const rest of lines.slice(errIdx + 1)) {
      if (rest.startsWith('  ├') || rest.startsWith('  └')) break;
      if (rest.trim().length === 0) break;
      expect(rest[2]).toBe('│');
    }
  });

  it('omits the bare "0 tools" noise during startup', () => {
    const tc = makeAgent('call_1', '整理明朝科举轶事', 'initializing…');
    const group = new AgentGroupComponent(darkColors, undefined);
    group.attach('call_1', tc);
    const out = strip(group.render(80).join('\n'));
    expect(out).not.toContain('0 tools');
  });
});
