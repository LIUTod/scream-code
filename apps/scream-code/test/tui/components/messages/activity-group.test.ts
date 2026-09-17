import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '@scream-code/config';
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
    group.appendThinking(THINKING, false);

    const lines = nonEmpty(render(group));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('工具执行中');
    expect(lines[0]).toContain('2 步');
    expect(lines[0]).toContain('2 个工具');
    expect(lines[0]).toContain('ctrl+o');
  });

  it('shows the two newest steps of the timeline in the collapsed rows', () => {
    const group = makeGroup();
    group.appendThinking(THINKING, false);

    const lines = nonEmpty(render(group));

    // Timeline is [Bash, Edit, reasoning]: the newest two steps are the second
    // tool and the reasoning run that followed it.
    expect(lines[1]?.startsWith('  ├─')).toBe(true);
    expect(lines[1]).toContain('✓');
    expect(lines[1]).toContain('Edit');
    expect(lines[1]).not.toContain('Bash');
    expect(lines[2]?.startsWith('  └─')).toBe(true);
    expect(lines[2]).toContain(t('activitygroup.thinking_summary', { summary: 'first reasoning line' }));
    // The token estimate belongs to the header row only: the reasoning row used
    // to repeat the same number right below it.
    expect(lines[2]).not.toContain('tok');
  });

  it('keeps a background task notice on the timeline as a normal step', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.appendThinking('先起一个后台任务', false);
    group.attachNotice({ phase: 'started', headline: '后台任务已启动', detail: 'bash-1' });
    group.attachTool(makeTool('t1', 'Bash', { command: 'npm test' }), 1);

    const lines = nonEmpty(render(group));

    expect(lines).toHaveLength(3);
    expect(lines[1]?.startsWith('  ├─')).toBe(true);
    expect(lines[1]).toContain('后台任务已启动');
    expect(lines[2]?.startsWith('  └─')).toBe(true);
    expect(lines[2]).toContain('Bash');
  });

  it('marks a background task notice with the same glyphs as a tool row', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachNotice({ phase: 'started', headline: '后台任务已启动', detail: 'bash-1' });
    group.attachNotice({ phase: 'completed', headline: '后台任务已完成', detail: 'bash-1' });
    group.attachNotice({ phase: 'failed', headline: '后台任务失败', detail: 'bash-2' });
    group.setExpanded(true);

    const body = render(group).map(strip).join('\n');

    // Running shows the spinner glyph a pending tool row uses, done and failed
    // show the marks a finished tool row uses.
    expect(body).toContain('⠋ 后台任务已启动');
    expect(body).toContain('✓ 后台任务已完成');
    expect(body).toContain('✗ 后台任务失败');
  });

  it('spends the whole row width on the collapsed reasoning summary', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.appendThinking('一二三四五六七八九十'.repeat(20), false);

    const lines = nonEmpty(render(group, 100));

    // Bounded by the terminal, not by the fixed 42-cell slice this row used to keep.
    expect(visibleWidth(lines[1] ?? '')).toBeGreaterThan(80);
    expect(lines[1]).toContain('…');
  });

  it('keeps a background task notice out of the header stats', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(makeTool('t1', 'Bash', { command: 'ls -la' }), 1);
    const before = nonEmpty(render(group))[0];

    group.attachNotice({ phase: 'completed', headline: '后台任务已完成', detail: 'bash-1' });

    expect(nonEmpty(render(group))[0]).toBe(before);
  });

  it('pairs the newest tool with the reasoning run that led to it', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.appendThinking(THINKING, false);
    group.attachTool(makeTool('t1', 'Bash', { command: 'ls -la' }), 1);
    group.appendThinking('second run reasoning', false);
    group.attachTool(makeTool('t2', 'Edit', { file_path: '/workspace/a.ts' }), 2);

    const lines = nonEmpty(render(group));

    expect(lines).toHaveLength(3);
    // Chronological within the row budget: reasoning above the tool it produced.
    expect(lines[1]?.startsWith('  ├─')).toBe(true);
    expect(lines[1]).toContain(t('activitygroup.thinking_summary', { summary: 'second run reasoning' }));
    expect(lines[2]?.startsWith('  └─')).toBe(true);
    expect(lines[2]).toContain('Edit');
    expect(lines[2]).not.toContain('Bash');
  });

  it('opens a new reasoning row for each run instead of merging them', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.appendThinking('first run', false);
    group.attachTool(makeTool('t1', 'Bash', { command: 'ls -la' }), 1);
    group.appendThinking('second run', false);
    group.setExpanded(true);

    const lines = nonEmpty(render(group));
    const labels = lines.filter((line) => line.includes(t('activitygroup.thinking_label')));

    expect(labels).toHaveLength(2);
    // Order on screen is the order the work happened in.
    expect(lines.findIndex((line) => line.includes('first run'))).toBeLessThan(
      lines.findIndex((line) => line.includes('Bash')),
    );
    expect(lines.findIndex((line) => line.includes('Bash'))).toBeLessThan(
      lines.findIndex((line) => line.includes('second run')),
    );
  });

  it('drops the reasoning row when nothing was reasoned about', () => {
    const group = makeGroup();

    const lines = nonEmpty(render(group));

    // No reasoning run: the row budget goes to the newest tool calls instead.
    expect(lines).toHaveLength(3);
    expect(lines[1]?.startsWith('  ├─')).toBe(true);
    expect(lines[1]).toContain('Bash');
    expect(lines[2]?.startsWith('  └─')).toBe(true);
    expect(lines[2]).toContain('Edit');
  });

  it('renders reasoning only turns without a tool row', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.appendThinking(THINKING, false);

    const lines = nonEmpty(render(group));

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(t('activitygroup.thinking_summary', { summary: 'first reasoning line' }));
  });

  it('renders nothing while it owns neither reasoning nor tool calls', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);

    expect(render(group)).toEqual([]);
  });

  it('expands into a tree with per-tool previews and a reasoning excerpt', () => {
    const group = makeGroup();
    group.appendThinking(THINKING, false);
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
    group.appendThinking(LONG_THINKING, false);
    group.setExpanded(true);

    const lines = render(group);
    const excerpt = lines.filter((line) => line.startsWith('     reasoning line'));

    expect(excerpt.length).toBe(ACTIVITY_GROUP_THINKING_EXCERPT_LINES);
    expect(excerpt[0]).toContain('reasoning line 1');
    expect(lines.some((line) => line.includes('还有'))).toBe(true);
  });

  it('previews the newest reasoning lines while streaming', () => {
    const group = makeGroup();
    group.appendThinking(LONG_THINKING, true);
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
    group.appendThinking(THINKING, true);
    const streaming = nonEmpty(render(group))[0] ?? '';
    expect(streaming).toContain('toks/s');
    expect(streaming).not.toContain('- toks/s');

    // Settled: back to the dash, the numbers would be stale.
    group.endThinking();
    expect(nonEmpty(render(group))[0]).toContain('- toks/s');
  });

  it('borrows each card once and toggles expansiveness', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    const first = makeTool('t1', 'Bash', { command: 'ls' });
    group.attachTool(first, 1);
    group.attachTool(first, 1);
    group.attachTool(makeTool('t2', 'Edit', { file_path: '/workspace/b.ts' }), 1);

    // The duplicate borrow is a no-op, so the block holds two steps: header plus
    // both tool rows inside the collapsed row budget.
    expect(nonEmpty(render(group))).toHaveLength(3);
    expect(group.isExpanded()).toBe(false);

    group.setExpanded(true);
    expect(group.isExpanded()).toBe(true);
    expect(render(group).some((line) => line.startsWith('  ├─'))).toBe(true);

    group.setExpanded(false);
    expect(nonEmpty(render(group))).toHaveLength(3);
  });

  it('rebuilds its rows after an external invalidate', () => {
    const group = makeGroup();
    group.appendThinking(THINKING, false);
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

  it('keeps a notice row inside the terminal width instead of wrapping', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachNotice({
      phase: 'completed',
      headline: '后台任务已完成',
      detail: 'a-really-long-command-line --with --many --arguments '.repeat(4),
    });

    for (const width of [40, 72]) {
      const lines = nonEmpty(render(group, width));
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('does not repeat reasoning when a notice splits the run', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.appendThinking('第一段推理', true);
    group.attachNotice({ phase: 'started', headline: '后台任务已启动' });
    // The run text is cumulative and keeps growing after the notice: everything
    // already shown must stay out of the continuation row on every flush, not
    // just the first one.
    group.appendThinking('第一段推理\n第二段推理', true);
    group.appendThinking('第一段推理\n第二段推理\n第三段推理', true);
    group.setExpanded(true);

    const body = render(group).map(strip).join('\n');

    expect(body.match(/第一段推理/g)).toHaveLength(1);
    expect(body).toContain('第二段推理');
    expect(body).toContain('第三段推理');
  });

  it('never lets a row overflow the viewport', () => {
    const group = makeGroup();
    group.appendThinking(LONG_THINKING, true);
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
    group.appendThinking('a very long reasoning summary that would never fit in a narrow window', false);

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
    group.appendThinking(LONG_THINKING, false);
    group.setExpanded(true);

    const lines = nonEmpty(render(group, 100));
    // Budget covers the tree body only (the header and its spacer sit outside it).
    const bodyRows = lines.filter((line) => /^\s*(│|├─|└─| {5})/.test(line));
    expect(bodyRows.length).toBeLessThanOrEqual(ACTIVITY_GROUP_EXPANDED_LINES);

    const summary = lines.find((line) => line.includes('还有'));
    expect(summary).toBeDefined();
    // Nine steps (8 tools plus the reasoning run): 3 fit the budget, 6 summarised.
    expect(summary).toContain('6');
    // The summarised row closes the tree, so the last shown tool keeps a branch.
    expect(lines.some((line) => line.startsWith('  ├─'))).toBe(true);
  });

  it('caps the excerpt by rendered lines for a wrapped paragraph', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.appendThinking('word '.repeat(400).trim(), false);
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
    group.appendThinking('reasoning that cannot possibly fit', false);

    for (const width of [30, 40, 48]) {
      const lines = nonEmpty(render(group, width));
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('drops the statistics before overflowing on an extreme width', () => {
    const group = makeGroup();
    group.appendThinking('reasoning', false);

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

describe('header diff stat', () => {
  function editTool(id: string, oldString: string, newString: string, isError = false): ToolCallComponent {
    return new ToolCallComponent(
      { id, name: 'Edit', args: { file_path: '/workspace/a.ts', old_string: oldString, new_string: newString } },
      { tool_call_id: id, output: isError ? 'error' : 'ok', is_error: isError },
      darkColors,
    );
  }

  it('sums successful Edit and Write calls, skipping failures and read-only tools', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(editTool('e1', 'a\nb', 'a\nb\nc'), 1); // +1 -0
    group.attachTool(
      new ToolCallComponent(
        { id: 'w1', name: 'Write', args: { file_path: '/workspace/b.ts', content: 'x\ny\nz' } },
        { tool_call_id: 'w1', output: 'ok', is_error: false },
        darkColors,
      ),
      2,
    ); // +3, deletions unknown (record predates the tools reporting their own diff)
    group.attachTool(editTool('e2', 'p', 'q', true), 3); // failed: ignored
    group.attachTool(makeTool('r1', 'Read', { file_path: '/workspace/a.ts' }), 4); // read-only

    const header = nonEmpty(render(group))[0] ?? '';
    // Additions always add up. The Write cannot report how many lines it
    // replaced, so the group claims no deletion figure at all — rendering a
    // "-0" here would state a deletion count that was never measured.
    expect(header).toContain('+4');
    expect(header).not.toContain('+4 -');
    expect(header).toContain('实速');
  });

  it('omits the diff segment for a read-only group', () => {
    const group = new ActivityGroupComponent(darkColors, undefined);
    group.attachTool(makeTool('t1', 'Bash', { command: 'ls' }), 1);
    group.attachTool(makeTool('t2', 'Read', { file_path: '/workspace/a.ts' }), 2);

    const header = nonEmpty(render(group))[0] ?? '';
    expect(header).not.toMatch(/\+\d/);
    expect(header).not.toMatch(/-\d/);
  });
});
