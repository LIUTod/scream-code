import { afterEach, describe, expect, it, vi } from 'vitest';

import { visibleWidth } from '@liutod-scream/pi-tui';
import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import {
  ACTIVITY_GROUP_EXPANDED_LINES,
  ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
  ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
  ACTIVITY_GROUP_TOOL_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { darkColors } from '#/tui/theme/colors';
import { getSharedSpeedTracker, resetSharedSpeedTracker } from '#/tui/utils/speed-tracker';

const WIDTH = 90;
const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function bigOutput(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `output line ${i + 1}`).join('\n');
}

function makeTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  outputLines = 8,
): ToolCallComponent {
  return new ToolCallComponent(
    { id, name, args },
    { tool_call_id: id, output: bigOutput(outputLines), is_error: false },
    darkColors,
  );
}

function render(group: ActivityGroupComponent, width = WIDTH): string[] {
  return group.render(width).map(strip);
}

function nonEmpty(lines: string[]): string[] {
  return lines.filter((line) => line.trim().length > 0);
}

const THINKING = ['first reasoning line', 'second reasoning line', 'third reasoning line'].join('\n');
const LONG_THINKING = Array.from({ length: 14 }, (_, i) => `reasoning line ${i + 1}`).join('\n');

function makeGroup(): ActivityGroupComponent {
  const group = new ActivityGroupComponent(darkColors, undefined);
  group.attachTool(makeTool('t1', 'Bash', { command: 'ls -la' }), 1);
  group.attachTool(makeTool('t2', 'Edit', { file_path: '/workspace/a.ts' }), 2);
  return group;
}

describe('ActivityGroupComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSharedSpeedTracker();
  });

  it('collapses reasoning plus tool calls into exactly three rows', () => {
    const group = makeGroup();
    group.setThinking(THINKING, false);

    const lines = nonEmpty(render(group));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('工具执行中');
    expect(lines[0]).toContain('2 步');
    expect(lines[0]).toContain('2 个工具');
    expect(lines[0]).toContain('ctrl+o');
  });

  it('shows the latest tool and the reasoning summary in the collapsed rows', () => {
    const group = makeGroup();
    group.setThinking(THINKING, false);

    const lines = nonEmpty(render(group));

    expect(lines[1]?.startsWith('  │  ')).toBe(true);
    expect(lines[1]).toContain('✓');
    expect(lines[1]).toContain('Edit');
    expect(lines[1]).not.toContain('Bash');
    expect(lines[2]?.startsWith('  └─')).toBe(true);
    expect(lines[2]).toContain('思考：first reasoning line');
    // The token estimate belongs to the header row only: the reasoning row used
    // to repeat the same number right below it.
    expect(lines[2]).not.toContain('tok');
  });

  it('drops the reasoning row when nothing was reasoned about', () => {
    const group = makeGroup();

    const lines = nonEmpty(render(group));

    expect(lines).toHaveLength(2);
    expect(lines[1]?.startsWith('  └─')).toBe(true);
    expect(lines[1]).toContain('Edit');
  });

  it('renders reasoning only turns without a tool row', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.setThinking(THINKING, false);

    const lines = nonEmpty(render(group));

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('思考：first reasoning line');
  });

  it('renders nothing while it owns neither reasoning nor tool calls', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);

    expect(render(group)).toEqual([]);
  });

  it('expands into a tree with per-tool previews and a reasoning excerpt', () => {
    const group = makeGroup();
    group.setThinking(THINKING, false);
    group.setExpanded(true);

    const lines = nonEmpty(render(group));
    const branches = lines.filter((line) => line.startsWith('  ├─'));
    const previews = lines.filter((line) => line.startsWith('  │  '));

    expect(lines[1]?.trimEnd()).toBe('  │');
    expect(branches).toHaveLength(2);
    expect(branches[0]).toContain('Bash');
    expect(branches[1]).toContain('Edit');
    expect(previews.length).toBeLessThanOrEqual(ACTIVITY_GROUP_TOOL_EXPANDED_LINES * 2);
    expect(previews.length).toBeGreaterThan(0);
    // Preview rows continue a branch with the card's own preview (the command
    // line for a shell tool) rather than repeating the branch header.
    expect(previews.some((line) => line.includes('$ ls -la'))).toBe(true);
    expect(previews.some((line) => line.includes('Used Bash'))).toBe(false);
  });

  it('caps the reasoning excerpt and points at the hidden lines', () => {
    const group = makeGroup();
    group.setThinking(LONG_THINKING, false);
    group.setExpanded(true);

    const lines = render(group);
    const excerpt = lines.filter((line) => line.startsWith('     reasoning line'));

    expect(excerpt.length).toBe(ACTIVITY_GROUP_THINKING_EXCERPT_LINES);
    expect(excerpt[0]).toContain('reasoning line 1');
    expect(lines.some((line) => line.includes('还有'))).toBe(true);
  });

  it('previews the newest reasoning lines while streaming', () => {
    const group = makeGroup();
    group.setThinking(LONG_THINKING, true);
    group.setExpanded(true);

    const lines = render(group);
    const excerpt = lines.filter((line) => line.startsWith('     reasoning line'));

    expect(excerpt.length).toBe(ACTIVITY_GROUP_THINKING_EXCERPT_LINES);
    expect(excerpt.at(-1)).toContain('reasoning line 14');
    expect(lines.some((line) => line.includes('前面还有'))).toBe(true);
  });

  it('spins the header while running and settles on a bullet', () => {
    const group = makeGroup();

    const running = nonEmpty(render(group))[0] ?? '';
    expect(running).toContain('工具执行中');
    expect(SPINNER_FRAMES.includes(running.trim().charAt(0))).toBe(true);

    group.setRunning(false);
    const settled = nonEmpty(render(group))[0] ?? '';
    expect(settled).toContain('■');
    expect(settled).toContain('工具执行完成');
    expect(SPINNER_FRAMES.includes(settled.trim().charAt(0))).toBe(false);
  });

  it('keeps the rate slot visible and fills it while reasoning streams', () => {
    const group = makeGroup();

    // Idle: the slot stays put with a dash so the header never reflows.
    expect(nonEmpty(render(group))[0]).toContain('- toks/s');

    getSharedSpeedTracker().observe(80, 1000, performance.now());
    group.setThinking(THINKING, true);
    const streaming = nonEmpty(render(group))[0] ?? '';
    expect(streaming).toContain('toks/s');
    expect(streaming).not.toContain('- toks/s');

    // Settled: back to the dash, the numbers would be stale.
    group.endThinking();
    expect(nonEmpty(render(group))[0]).toContain('- toks/s');
  });

  it('sizes the header estimate by reasoning plus every tool result', () => {
    const tokenValue = (header: string): number => {
      const match = /≈([\d.]+)(K?) tok/.exec(header);
      if (match === null) return -1;
      const value = Number.parseFloat(match[1] ?? '0');
      return match[2] === 'K' ? value * 1000 : value;
    };
    const bare = new ActivityGroupComponent(darkColors, undefined);
    bare.attachTool(makeTool('t1', 'Bash', { command: 'ls' }, 2), 1);
    const busy = new ActivityGroupComponent(darkColors, undefined);
    busy.attachTool(makeTool('t1', 'Bash', { command: 'ls' }, 400), 1);

    const bareTokens = tokenValue(nonEmpty(render(bare))[0] ?? '');
    const busyTokens = tokenValue(nonEmpty(render(busy))[0] ?? '');

    expect(bareTokens).toBeGreaterThan(0);
    expect(busyTokens).toBeGreaterThan(bareTokens);
  });

  it('counts Chinese reasoning at roughly one token per character', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.setThinking('推'.repeat(2000), false);

    // 2000 CJK chars ≈ 2.0K tokens; the old chars/2.5 heuristic reported 800.
    expect(nonEmpty(render(group))[0]).toContain('≈2.0K tok');
  });

  it('borrows each card once and toggles expansiveness', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    const first = makeTool('t1', 'Bash', { command: 'ls' });
    group.attachTool(first, 1);
    group.attachTool(first, 1);
    group.attachTool(makeTool('t2', 'Edit', { file_path: '/workspace/b.ts' }), 1);

    expect(nonEmpty(render(group))).toHaveLength(2);
    expect(group.isExpanded()).toBe(false);

    group.setExpanded(true);
    expect(group.isExpanded()).toBe(true);
    expect(render(group).some((line) => line.startsWith('  ├─'))).toBe(true);

    group.setExpanded(false);
    expect(nonEmpty(render(group))).toHaveLength(2);
  });

  it('rebuilds its rows after an external invalidate', () => {
    const group = makeGroup();
    group.setThinking(THINKING, false);
    const before = render(group);

    group.invalidate();

    expect(render(group)).toEqual(before);
  });

  it('condenses the shell command to its action segment', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    const long = new ToolCallComponent(
      {
        id: 't1',
        name: 'Bash',
        args: { command: 'cd /workspace/proj && sqlite3 db/app.db "SELECT a || \' | \' || b FROM t;"' },
      },
      { tool_call_id: 't1', output: 'a | b', is_error: false },
      darkColors,
    );
    group.attachTool(long, 1);

    const row = nonEmpty(render(group, 120))[1] ?? '';
    expect(row).toContain('sqlite3');
    expect(row).not.toContain('cd /workspace/proj');
    // The quoted `||` is SQL, not a shell pipeline separator.
    expect(row).toContain("SELECT a || ' | ' || b FROM t;");
  });

  it('shortens path arguments and keeps the card chip', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(
      new ToolCallComponent(
        {
          id: 't1',
          name: 'Edit',
          args: { file_path: '/Users/someone/very/deep/project/src/main.py', old_string: 'a', new_string: 'b' },
        },
        { tool_call_id: 't1', output: 'Updated src/main.py', is_error: false },
        darkColors,
      ),
      1,
    );

    const row = nonEmpty(render(group, 120))[1] ?? '';
    expect(row).toContain('…/src/main.py');
    expect(row).not.toContain('/Users/someone/very/deep');
    expect(row).toMatch(/·\s*\+\d/); // the card's own diff chip survives
  });

  it('recaps pattern tools and never leaks a wrapped header into the body', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(
      new ToolCallComponent(
        {
          id: 't1',
          name: 'Bash',
          args: {
            command: `cd /workspace && echo "${'x'.repeat(200)}" && printf done`,
          },
        },
        { tool_call_id: 't1', output: 'done', is_error: false },
        darkColors,
      ),
      1,
    );
    group.setExpanded(true);

    const lines = render(group, 80);
    const bodyRows = lines.filter((line) => line.startsWith('  │  '));
    // Only real indented body rows may appear; the header's wrap continuation
    // must not be rendered as a preview row.
    for (const line of bodyRows) expect(line.slice(5).startsWith('x'.repeat(30))).toBe(false);
    expect(nonEmpty(lines).some((line) => line.includes('printf done'))).toBe(true);
  });

  it('never lets a row overflow the viewport', () => {
    const group = makeGroup();
    group.setThinking(LONG_THINKING, true);
    group.setExpanded(true);

    for (const line of render(group, 60)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    for (const line of render(group, WIDTH)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('stays three rows tall on a narrow terminal instead of wrapping', () => {
    const group = makeGroup();
    group.setThinking('a very long reasoning summary that would never fit in a narrow window', false);

    for (const width of [48, 60, 72]) {
      const lines = nonEmpty(render(group, width));
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('previews more of each result once the group is expanded', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(makeTool('t1', 'Bash', { command: 'ls' }, 60), 1);

    group.setExpanded(true);
    const expandedRows = render(group).filter((line) => line.includes('output line'));
    expect(expandedRows.length).toBeGreaterThan(ACTIVITY_GROUP_TOOL_PREVIEW_LINES);
    expect(expandedRows.length).toBeLessThanOrEqual(ACTIVITY_GROUP_TOOL_EXPANDED_LINES);

    group.setExpanded(false);
    // Collapsed returns to the card's own summary: no result lines, and the
    // card is collapsed again so its preview budget is restored.
    expect(render(group).some((line) => line.includes('output line'))).toBe(false);
  });

  it('keeps the expanded tree inside its block budget', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    for (let i = 0; i < 8; i += 1) {
      group.attachTool(makeTool(`t${String(i)}`, 'Bash', { command: `ls ${String(i)}` }, 40), i + 1);
    }
    group.setThinking(LONG_THINKING, false);
    group.setExpanded(true);

    const lines = nonEmpty(render(group, 100));
    // Budget covers the tree body only (the header and its spacer sit outside it).
    const bodyRows = lines.filter((line) => /^\s*(│|├─|└─| {5})/.test(line));
    expect(bodyRows.length).toBeLessThanOrEqual(ACTIVITY_GROUP_EXPANDED_LINES);

    const summary = lines.find((line) => line.includes('还有'));
    expect(summary).toBeDefined();
    expect(summary).toContain('5'); // 8 tools, 3 fit the budget, 5 summarised
    // The summarised row closes the tree, so the last shown tool keeps a branch.
    expect(lines.some((line) => line.startsWith('  ├─'))).toBe(true);
  });

  it('caps the excerpt by rendered lines for a wrapped paragraph', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.setThinking('word '.repeat(400).trim(), false);
    group.setExpanded(true);

    const lines = render(group, 60);
    const excerptBody = lines.filter((line) => line.startsWith('     '));
    expect(excerptBody.length).toBeLessThanOrEqual(ACTIVITY_GROUP_THINKING_EXCERPT_LINES + 1);
    // A single paragraph is clipped rather than line-trimmed, so the truncation
    // has to stay visible.
    expect(excerptBody.some((line) => line.includes('…'))).toBe(true);
  });

  it('stays three rows tall on a very narrow terminal', () => {
    const group = makeGroup();
    group.setThinking('reasoning that cannot possibly fit', false);

    for (const width of [30, 40, 48]) {
      const lines = nonEmpty(render(group, width));
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('drops the statistics before overflowing on an extreme width', () => {
    const group = makeGroup();
    group.setThinking('reasoning', false);

    const header = nonEmpty(render(group, 12))[0] ?? '';
    expect(visibleWidth(header)).toBeLessThanOrEqual(12);
    expect(header).not.toContain('tok');
  });

  it('mirrors the card status: failed rows are marked, running rows spin', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    const running = new ToolCallComponent(
      { id: 't1', name: 'Bash', args: { command: 'sleep 5' } },
      undefined,
      darkColors,
    );
    group.attachTool(running, 1);

    const runningRow = nonEmpty(render(group))[1] ?? '';
    expect(new RegExp(`[${SPINNER_FRAMES}]`).test(runningRow)).toBe(true);

    const failed = new ToolCallComponent(
      { id: 't2', name: 'Bash', args: { command: 'exit 1' } },
      { tool_call_id: 't2', output: 'boom', is_error: true },
      darkColors,
    );
    const failedGroup = new ActivityGroupComponent(darkColors, undefined);
    failedGroup.attachTool(failed, 1);

    const failedRow = nonEmpty(render(failedGroup))[1] ?? '';
    expect(failedRow).toContain('✗');
    expect(failedRow).toContain('Bash');
  });

  it('rebuilds borrowed cards on invalidate but caches them between renders', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    const tool = makeTool('t1', 'Bash', { command: 'ls' });
    const spy = vi.spyOn(tool, 'render');
    group.attachTool(tool, 1);

    group.render(WIDTH);
    group.render(WIDTH);
    const callsAfterCachedRenders = spy.mock.calls.length;

    group.invalidate();
    group.render(WIDTH);
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterCachedRenders);
  });
});
