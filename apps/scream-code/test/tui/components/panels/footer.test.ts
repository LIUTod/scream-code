import { visibleWidth } from '@liutod-scream/pi-tui';
import type { TUI } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import { applyMotionEnv, resetMotion } from '#/tui/utils/motion';

const strip = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');

/** SGR sequence chalk emits for a hex colour at level 3. */
function sgr(hex: string): string {
  const v = hex.replace(/^#/, '');
  return `\u001B[38;2;${String(Number.parseInt(v.slice(0, 2), 16))};${String(Number.parseInt(v.slice(2, 4), 16))};${String(Number.parseInt(v.slice(4, 6), 16))}m`;
}

const NOW = 1_700_000_000_000;

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'alpha-1',
    workDir: '/tmp',
    sessionId: 'sess_1',
    permissionMode: 'yolo',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0.28,
    contextTokens: 56_000,
    maxContextTokens: 200_000,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    pendingUserAction: null,
    pendingUserActionSince: null,
    lineActive: false,
    linePlatform: null,
    providerBalance: null,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: { 'alpha-1': { displayName: 'Alpha 1', model: 'alpha-1' } as never },
    sessionUsage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    ...overrides,
  } as AppState;
}

interface Opts {
  rows?: number;
  git?: { added: number; deleted: number } | null;
  notice?: { text: string; color: string } | null;
}

function makeFooter(state: AppState, opts: Opts = {}): FooterComponent {
  const ui = {
    requestRender: vi.fn(),
    ...(opts.rows === undefined ? {} : { terminal: { rows: opts.rows, columns: 100 } }),
  } as unknown as TUI;
  const footer = new FooterComponent(state, darkColors, ui);
  footer.setGitDiffProvider(() => opts.git ?? null);
  footer.setNoticeProvider(() => opts.notice ?? null);
  return footer;
}

function rowsOf(state: AppState, width: number, opts: Opts = {}): string[] {
  const footer = makeFooter(state, opts);
  try {
    return footer.render(width).map(strip);
  } finally {
    footer.dispose();
  }
}

const USED = { inputOther: 769, output: 1, inputCacheRead: 9231, inputCacheCreation: 0 };

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetMotion();
});

describe('FooterComponent — measurements', () => {
  it('says model, cache, balance and git on its one row, the gauge flush right', () => {
    const state = baseState({
      providerBalance: { currency: 'CNY', totalBalance: '12.40' } as never,
      sessionUsage: USED,
    });
    const rows = rowsOf(state, 100, { git: { added: 34, deleted: 8 } });
    expect(rows).toHaveLength(1);
    const [row1] = rows;
    expect(row1).toMatch(/^Alpha 1 {3}缓存 92% {3}¥12\.40 {3}git \+34 -8 +ctx {2}━━─{8} 28%$/);
    expect(visibleWidth(row1!)).toBe(100);
  });

  it('draws plain-text labels, no emoji', () => {
    const state = baseState({ sessionUsage: USED, lineActive: true, linePlatform: 'lark' });
    for (const width of [50, 80, 120]) {
      const text = rowsOf(state, width, { git: { added: 1, deleted: 1 } }).join('\n');
      expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    }
  });

  it('shows nothing about cache before the first reply, then the rate', () => {
    expect(rowsOf(baseState(), 100)[0]).not.toContain('缓存');
    expect(rowsOf(baseState({ sessionUsage: USED }), 100)[0]).toContain('缓存 92%');
  });

  it('colours a high cache rate and leaves a low one dim', () => {
    chalk.level = 3;
    try {
      const high = makeFooter(baseState({ sessionUsage: USED })).render(100).join('');
      expect(high).toContain(`${sgr(darkColors.success)}92%`);
      const low = makeFooter(
        baseState({ sessionUsage: { inputOther: 900, output: 1, inputCacheRead: 100, inputCacheCreation: 0 } }),
      )
        .render(100)
        .join('');
      expect(low).not.toContain(`${sgr(darkColors.success)}10%`);
    } finally {
      chalk.level = 1;
    }
  });

  it('never shrinks the cache readout to a bare number: it goes whole', () => {
    const state = baseState({ sessionUsage: USED, providerBalance: { currency: 'CNY', totalBalance: '12.40' } as never });
    for (let width = 12; width <= 80; width++) {
      const row = rowsOf(state, width, { git: { added: 3, deleted: 1 } })[0]!;
      expect(row.includes('92%') ? row.includes('缓存') : true, `width ${String(width)}: ${row}`).toBe(true);
    }
  });

  it('shows git only when the tree has changes, and survives a provider that throws', () => {
    expect(rowsOf(baseState(), 100, { git: { added: 12, deleted: 3 } })[0]).toContain('git +12 -3');
    expect(rowsOf(baseState(), 100, { git: { added: 0, deleted: 0 } })[0]).not.toContain('git');
    expect(rowsOf(baseState(), 100, { git: null })[0]).not.toContain('git');
    const footer = makeFooter(baseState());
    footer.setGitDiffProvider(() => {
      throw new Error('boom');
    });
    expect(() => footer.render(100)).not.toThrow();
    footer.dispose();
  });

  it('gives up git first, then balance, then cache, as the row narrows', () => {
    const state = baseState({ sessionUsage: USED, providerBalance: { currency: 'CNY', totalBalance: '12.40' } as never });
    const order: string[] = [];
    let previous = new Set(['git', '¥12.40', '缓存']);
    for (let width = 90; width >= 24; width--) {
      const row = rowsOf(state, width, { git: { added: 3, deleted: 1 } })[0]!;
      const present = new Set(['git', '¥12.40', '缓存'].filter((x) => row.includes(x)));
      for (const gone of previous) if (!present.has(gone)) order.push(gone);
      previous = present;
    }
    expect(order).toEqual(['git', '¥12.40', '缓存']);
  });
});

describe('FooterComponent — context gauge', () => {
  const gaugeOf = (usage: number, width = 100): string => rowsOf(baseState({ contextUsage: usage }), width)[0]!;

  it('floors the reading and never prints NaN', () => {
    expect(gaugeOf(0.427)).toContain(' 42%');
    expect(gaugeOf(Number.NaN)).toContain(' 0%');
    expect(gaugeOf(7)).toContain(' 100%');
    expect(gaugeOf(0.004)).toContain('<1%');
  });

  it('keeps one cell lit for a tiny usage, none at zero, all at full', () => {
    expect(gaugeOf(0.03)).toContain('━─────────');
    expect(gaugeOf(0)).toContain('──────────');
    expect(gaugeOf(1)).toContain('━━━━━━━━━━');
  });

  it('shrinks the bar 10 → 6 → none, then drops only the label: the percentage is never dropped', () => {
    const widths = new Map<number, string>();
    for (let width = 70; width >= 6; width--) {
      const row = rowsOf(baseState(), width)[0]!;
      const bar = /[━─]+/.exec(row)?.[0] ?? '';
      widths.set(width, bar);
    }
    const lengths = new Set([...widths.values()].map((bar) => bar.length));
    expect([...lengths].filter((n) => n > 0).toSorted((a, b) => b - a)).toEqual([10, 6]);
    expect(rowsOf(baseState(), 24)[0]).toMatch(/ctx 28%/);
    for (let width = 12; width <= 70; width++) expect(rowsOf(baseState(), width)[0], `width ${String(width)}`).toContain('28%');
  });

  it('colours by the used share, and by absolute tokens on a 1M window', () => {
    chalk.level = 3;
    try {
      const out = (usage: number, tokens: number, window: number): string =>
        makeFooter(baseState({ contextUsage: usage, contextTokens: tokens, maxContextTokens: window }))
          .render(120)
          .join('');
      expect(out(0.65, 130_000, 200_000)).toContain(sgr(darkColors.warning));
      expect(out(0.95, 190_000, 200_000)).toContain(sgr(darkColors.error));
      expect(out(0.45, 450_000, 1_000_000)).toContain(sgr(darkColors.warning));
      expect(out(0.75, 750_000, 1_000_000)).toContain(sgr(darkColors.error));
      const quiet = out(0.3, 300_000, 1_000_000);
      expect(quiet).not.toContain(sgr(darkColors.warning));
      expect(quiet).not.toContain(sgr(darkColors.error));
    } finally {
      chalk.level = 1;
    }
  });

  it('tracks the ratio across setState', () => {
    const footer = makeFooter(baseState({ contextUsage: 0.1 }));
    expect(strip(footer.render(100)[0]!)).toContain(' 10%');
    footer.setState(baseState({ contextUsage: 0.6 }));
    expect(strip(footer.render(100)[0]!)).toContain(' 60%');
    footer.dispose();
  });
});

describe('FooterComponent — exit hint', () => {
  const HINT = 'Press Ctrl-C again to exit';
  it('takes the gauge place, and the model name gives way before the hint does', () => {
    const footer = makeFooter(baseState({ model: 'a-very-long-model-name-here', availableModels: {} }));
    footer.setTransientHint(HINT);
    for (const width of [100, 60, 40, 34]) {
      const row = strip(footer.render(width)[0]!);
      expect(row, `width ${String(width)}`).toContain(HINT);
      expect(row).not.toContain('ctx');
    }
    footer.setTransientHint('');
    expect(strip(footer.render(100)[0]!)).toContain('ctx');
    footer.dispose();
  });
});

describe('FooterComponent — modes and running work', () => {
  it('shows only the pills that are on, in the order plan → RLM → 群狼', () => {
    // (Working, so the idle key hints — one of which is "plan" — are out of the way.)
    const working = { streamingPhase: 'tool', streamingStartTime: NOW } as const;
    expect(rowsOf(baseState(working), 100)[0]).not.toMatch(/计划|RLM|群狼|目标/);
    const row = rowsOf(baseState({ ...working, planMode: 'plan', rlmEnabled: true, wolfpackMode: true }), 100)[0]!;
    expect(row.indexOf('计划')).toBeGreaterThanOrEqual(0);
    expect(row.indexOf('计划')).toBeLessThan(row.indexOf('RLM'));
    expect(row.indexOf('RLM')).toBeLessThan(row.indexOf('群狼'));
  });

  it('colours a pill with its own colour, in bold; fusion has its own', () => {
    chalk.level = 3;
    try {
      const plan = makeFooter(baseState({ planMode: 'plan' })).render(100)[0]!;
      expect(plan).toContain(sgr(darkColors.planMode));
      expect(plan).toContain('\u001B[1m');
      const fusion = makeFooter(baseState({ planMode: 'fusionplan' })).render(100)[0]!;
      expect(fusion).toContain(sgr(darkColors.fusionPlanMode));
    } finally {
      chalk.level = 1;
    }
  });

  it('keeps what follows the plan pill in place when plan switches to fusion', () => {
    const at = (planMode: 'plan' | 'fusionplan'): number => {
      const row = rowsOf(baseState({ planMode, rlmEnabled: true }), 100)[0]!;
      return visibleWidth(row.slice(0, row.indexOf('RLM')));
    };
    expect(at('plan')).toBe(at('fusionplan'));
  });

  it('shows the goal only while a goal is active, and shortens it but never drops it', () => {
    const goal = {
      objective: 'x',
      status: 'active',
      turnsUsed: 7,
      wallClockMs: 3 * 60_000,
      wallClockBaseAt: NOW,
      completionCriterion: null,
      tokensUsed: 0,
      inputTokens: null,
      outputTokens: null,
    } as never;
    expect(rowsOf(baseState(), 100)[0]).not.toContain('目标');
    const state = baseState({ goalActive: true, goal });
    expect(rowsOf(state, 100)[0]).toContain('目标 3m · 7轮');
    const forms = new Set<string>();
    for (let width = 100; width >= 24; width--) {
      const row = rowsOf(state, width)[0]!;
      if (row.includes('目标 3m · 7轮')) forms.add('full');
      else if (row.includes('目标 7轮')) forms.add('turns');
      else if (row.includes('目标')) forms.add('bare');
      else forms.add('none');
    }
    expect([...forms]).toEqual(['full', 'turns', 'bare']);
  });

  it('names background work by kind, folds it into a total when short, and never drops it', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1, foregroundSubagents: 0 });
    expect(strip(footer.render(100)[0]!)).toContain('后台任务 x2 · 后台Agent x1');
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1, foregroundSubagents: 1 });
    expect(strip(footer.render(100)[0]!)).toContain('后台任务 x2 · 后台Agent x1 · 前台Agent x1');
    const short = strip(footer.render(40)[0]!);
    expect(short).toContain('运行中 4');
    for (let width = 24; width <= 100; width++) expect(strip(footer.render(width)[0]!), `width ${String(width)}`).toMatch(/后台任务|运行中/);
    footer.setBackgroundCounts({ bashTasks: -3, agentTasks: 0, foregroundSubagents: 0 });
    expect(strip(footer.render(100)[0]!)).not.toMatch(/后台|运行中/);
    footer.dispose();
  });

  it('says nothing about MCP while it is healthy', () => {
    expect(rowsOf(baseState(), 100)[0]).not.toContain('MCP');
    const healthy = baseState({ mcpSummary: { total: 5, connected: 5, pending: 0, failed: 0, needsAuth: 0 } });
    expect(rowsOf(healthy, 100).join('\n')).not.toContain('MCP');
    const connecting = baseState({ mcpSummary: { total: 5, connected: 2, pending: 3, failed: 0, needsAuth: 0 } });
    expect(rowsOf(connecting, 100).join('\n')).not.toContain('MCP');
  });

  it('keeps a pill for a failed or auth-blocked server until it is resolved, and never drops it', () => {
    const failed = baseState({ mcpSummary: { total: 5, connected: 3, pending: 0, failed: 1, needsAuth: 1 } });
    expect(rowsOf(failed, 100)[0]).toContain('✕ MCP 3/5');
    const auth = baseState({ mcpSummary: { total: 5, connected: 4, pending: 0, failed: 0, needsAuth: 1 } });
    expect(rowsOf(auth, 100)[0]).toContain('◆ MCP 4/5');
    const busy = baseState({ ...failed, planMode: 'plan', rlmEnabled: true });
    for (let width = 30; width <= 100; width++) {
      const row = rowsOf(busy, width, { notice: { text: '1 个 MCP 服务器失败 · /mcp', color: '#f00' } })[0]!;
      expect(row.includes('✕'), `width ${String(width)}: ${row}`).toBe(true);
    }
  });
});

describe('FooterComponent — no key hints', () => {
  it('prints no keys: the tips teach them, and Esc sits on the status row', () => {
    for (const state of [
      baseState(),
      baseState({ streamingPhase: 'thinking', streamingStartTime: NOW - 5000 }),
      baseState({ streamingPhase: 'tool', pendingUserAction: 'approval', pendingUserActionSince: NOW }),
    ]) {
      const row = rowsOf(state, 140)[0]!;
      expect(row).not.toMatch(/Esc|命令|Shift\+Tab/);
    }
  });

  it('puts the notice on the right, before the gauge at the edge', () => {
    const row = rowsOf(baseState(), 100, { notice: { text: '⏰ 定时任务已触发：日报汇总', color: '#e0a030' } })[0]!;
    expect(row.indexOf('Alpha 1')).toBe(0);
    expect(row.indexOf('⏰ 定时任务已触发：日报汇总')).toBeGreaterThan(row.indexOf('Alpha 1'));
    expect(row.indexOf('⏰ 定时任务已触发：日报汇总')).toBeLessThan(row.indexOf('ctx'));
    expect(row.trimEnd().endsWith('28%')).toBe(true);
  });
});

describe('FooterComponent — notice slot', () => {
  const notice = { text: '⏰ 定时任务已触发：日报汇总', color: '#e0a030' };

  it('shrinks and drops before a mode pill does', () => {
    const state = baseState({ planMode: 'plan', rlmEnabled: true, streamingPhase: 'tool', streamingStartTime: NOW - 5000 });
    for (let width = 20; width <= 100; width++) {
      const row = rowsOf(state, width, { notice })[0]!;
      if (!row.includes('RLM')) continue;
      expect(row.includes('计划'), `width ${String(width)}: ${row}`).toBe(true);
    }
    const narrow = rowsOf(state, 40, { notice })[0]!;
    expect(narrow).toContain('计划');
    expect(narrow).toContain('RLM');
  });

  it('never shortens the notice while the gauge still has a bar to give', () => {
    const state = baseState({ planMode: 'plan', streamingPhase: 'tool', streamingStartTime: NOW - 5000 });
    const cutAt: number[] = [];
    for (let width = 40; width <= 140; width++) {
      const footer = makeFooter(state, { notice });
      footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 2 });
      const row = strip(footer.render(width)[0]!);
      footer.dispose();
      if (!row.includes('⏰') || row.includes(notice.text)) continue;
      cutAt.push(width);
      expect(row, `width ${String(width)}`).not.toMatch(/[━─]/);
    }
    // The range does reach widths where the notice is cut.
    expect(cutAt.length).toBeGreaterThan(0);
  });

  it('cuts the notice with one ellipsis, never mid-word into a bare dots chip', () => {
    for (let width = 30; width <= 80; width++) {
      const row = rowsOf(baseState({ planMode: 'plan' }), width, { notice })[0]!;
      expect(row).not.toMatch(/(^|\s)\.\.\.($|\s)/);
      expect((row.match(/…/g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it('reads the provider on every render and survives one that throws', () => {
    const footer = makeFooter(baseState());
    let current: { text: string; color: string } | null = null;
    footer.setNoticeProvider(() => current);
    expect(strip(footer.render(100)[0]!)).not.toContain('hello');
    current = { text: 'hello', color: '#fff' };
    expect(strip(footer.render(100)[0]!)).toContain('hello');
    footer.setNoticeProvider(() => {
      throw new Error('boom');
    });
    expect(() => footer.render(100)).not.toThrow();
    footer.dispose();
  });
});

describe('FooterComponent — channel', () => {
  it('shows the channel only while it runs; a configured but stopped one says nothing', () => {
    expect(rowsOf(baseState({ linePlatform: 'lark', lineActive: false }), 100)[0]).not.toContain('Line');
    expect(rowsOf(baseState(), 100)[0]).not.toContain('Line');
    expect(rowsOf(baseState({ linePlatform: 'lark', lineActive: true }), 100)[0]).toContain('◆ Line: Lark');
    expect(rowsOf(baseState({ linePlatform: 'wechat', lineActive: true }), 100)[0]).toContain('◆ Line: WeChat');
  });

  it('shortens to Line before it is dropped', () => {
    const state = baseState({ linePlatform: 'lark', lineActive: true, planMode: 'plan', rlmEnabled: true });
    const forms = new Set<string>();
    for (let width = 100; width >= 20; width--) {
      const m = /◆ Line(?:: \S+)?/.exec(rowsOf(state, width)[0]!);
      if (m) forms.add(m[0]);
    }
    expect([...forms]).toEqual(expect.arrayContaining(['◆ Line: Lark', '◆ Line']));
  });
});

describe('FooterComponent — one row at every size', () => {
  it('is one row on any terminal height and width', () => {
    for (const rows of [undefined, 10, 14, 19, 20, 40]) {
      for (const width of [30, 50, 80, 140]) expect(rowsOf(baseState(), width, { rows }), `${String(rows)}x${String(width)}`).toHaveLength(1);
    }
  });

  it('never carries the work state: the status row is drawn at every width', () => {
    const working = baseState({ streamingPhase: 'thinking', streamingStartTime: NOW - 12_000 });
    const waiting = baseState({
      streamingPhase: 'tool',
      streamingStartTime: NOW - 300_000,
      pendingUserAction: 'approval',
      pendingUserActionSince: NOW - 240_000,
    });
    for (const width of [40, 56, 100]) {
      expect(rowsOf(working, width)[0]).not.toContain('思考中');
      expect(rowsOf(waiting, width)[0]).not.toContain('等待批准');
    }
  });

  it('keeps the model, the modes, running work, MCP trouble, waiting jobs and the percentage on a narrow row', () => {
    const state = baseState({
      planMode: 'plan',
      rlmEnabled: true,
      jobsEnabled: 1,
      jobsWaiting: 1,
      jobsHostRunning: true,
      sessionUsage: USED,
      providerBalance: { currency: 'USD', totalBalance: '8.84' } as never,
      mcpSummary: { total: 3, connected: 2, pending: 0, failed: 1, needsAuth: 0 },
    } as never);
    const footer = makeFooter(state, { git: { added: 3, deleted: 1 }, notice: { text: '提醒 · 10 分钟后开会', color: '#fa0' } });
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 0, foregroundSubagents: 1 });
    const row = strip(footer.render(64)[0]!);
    footer.dispose();
    for (const kept of ['Alpha', '计划', 'RLM', '运行中 2', '✕', '◆ 待处理 1', '28%']) expect(row, row).toContain(kept);
    // The measurements gave way to them.
    expect(row).not.toMatch(/缓存|\$8\.84|git/);
  });
});

describe('FooterComponent — fit contract', () => {
  it('never exceeds the width, whatever is on', () => {
    const state = baseState({
      planMode: 'fusionplan',
      rlmEnabled: true,
      wolfpackMode: true,
      goalActive: true,
      goal: { objective: 'x', status: 'active', turnsUsed: 7, wallClockMs: 1000, wallClockBaseAt: NOW } as never,
      streamingPhase: 'tool',
      streamingStartTime: NOW - 47_000,
      sessionUsage: USED,
      providerBalance: { currency: 'CNY', totalBalance: '12.40' } as never,
      linePlatform: 'lark',
      lineActive: true,
      jobsWaiting: 2,
      mcpSummary: { total: 5, connected: 3, pending: 0, failed: 1, needsAuth: 1 },
    });
    for (const rows of [undefined, 14]) {
      for (let width = 8; width <= 200; width += 1) {
        const footer = makeFooter(state, { rows, git: { added: 34, deleted: 8 }, notice: { text: '⏰ 定时任务已触发：日报汇总', color: '#fa0' } });
        footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1, foregroundSubagents: 1 });
        for (const line of footer.render(width)) {
          expect(visibleWidth(line), `width ${String(width)}`).toBeLessThanOrEqual(width);
        }
        footer.dispose();
      }
    }
  });
});

describe('FooterComponent — model name glow', () => {
  const WORKING = { streamingStartTime: NOW - 10_000 } as const;
  const render = (state: AppState, at: number): string => {
    vi.spyOn(Date, 'now').mockReturnValue(at);
    const footer = makeFooter(state);
    const row = footer.render(100)[0]!;
    footer.dispose();
    return row;
  };
  beforeEach(() => {
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = 1;
  });

  it('glows while the model works, and the glow moves with the clock', () => {
    for (const phase of ['thinking', 'waiting', 'composing', 'tool-args'] as const) {
      const state = baseState({ streamingPhase: phase, ...WORKING });
      const frames = new Set([0, 100, 200, 300, 400, 500].map((offset) => render(state, NOW + offset)));
      expect(frames.size, phase).toBeGreaterThan(1);
    }
  });

  it('is plain bold text while idle, with no glow', () => {
    const state = baseState();
    expect(render(state, NOW)).toBe(render(state, NOW + 300));
    expect(render(state, NOW)).toContain(`${sgr(darkColors.text)}\u001B[1mAlpha 1`);
  });

  it('holds one steady colour with motion off: green while the model works, blue while a tool runs', () => {
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    for (const phase of ['thinking', 'waiting', 'composing', 'tool-args'] as const) {
      const state = baseState({ streamingPhase: phase, ...WORKING });
      const first = render(state, NOW);
      expect(render(state, NOW + 137), phase).toBe(first);
      expect(first, phase).toContain(`${sgr(darkColors.primary)}Alpha 1`);
    }
    const tool = baseState({ streamingPhase: 'tool', ...WORKING });
    const first = render(tool, NOW);
    expect(render(tool, NOW + 211)).toBe(first);
    expect(first).toContain(`${sgr(darkColors.planMode)}Alpha 1`);
  });

  it('uses the blue of a running tool for its glow, not the green', () => {
    const tool = baseState({ streamingPhase: 'tool', ...WORKING });
    const frames = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((offset) => render(tool, NOW + offset)).join('');
    expect(frames).not.toContain(sgr(darkColors.primary));
  });
});

describe('FooterComponent — clock', () => {
  function make(state: AppState) {
    const requestRender = vi.fn();
    const footer = new FooterComponent(state, darkColors, { requestRender } as unknown as TUI);
    return { footer, requestRender };
  }

  it('stays quiet while idle and repaints at 30 frames a second in every active phase (the glow)', () => {
    vi.useFakeTimers();
    const { footer, requestRender } = make(baseState());
    vi.advanceTimersByTime(3000);
    expect(requestRender).not.toHaveBeenCalled();
    for (const phase of ['waiting', 'tool', 'composing'] as const) {
      footer.setState(baseState({ streamingPhase: phase }));
      requestRender.mockClear();
      vi.advanceTimersByTime(1000);
      expect(requestRender.mock.calls.length, phase).toBeGreaterThanOrEqual(29);
      expect(requestRender.mock.calls.length, phase).toBeLessThanOrEqual(31);
    }
    footer.dispose();
  });

  it('ticks at the same cadence with motion off', () => {
    vi.useFakeTimers();
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const { footer, requestRender } = make(baseState({ streamingPhase: 'thinking' }));
    vi.advanceTimersByTime(3000);
    expect(requestRender).toHaveBeenCalledTimes(3);
    footer.dispose();
  });

  it('keeps the goal clock moving while idle, and stops on idle without a goal and on dispose', () => {
    vi.useFakeTimers();
    const goalState = baseState({ goalActive: true, goal: { turnsUsed: 1, wallClockMs: 0, wallClockBaseAt: NOW } as never });
    const { footer, requestRender } = make(goalState);
    vi.advanceTimersByTime(2000);
    expect(requestRender).toHaveBeenCalledTimes(2);
    footer.setState(baseState());
    requestRender.mockClear();
    vi.advanceTimersByTime(3000);
    expect(requestRender).not.toHaveBeenCalled();
    footer.setState(baseState({ streamingPhase: 'tool' }));
    footer.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(3000);
    expect(requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not stack timers across rapid phase changes', () => {
    vi.useFakeTimers();
    const { footer } = make(baseState());
    for (const phase of ['waiting', 'thinking', 'tool', 'composing', 'idle', 'tool'] as const) {
      footer.setState(baseState({ streamingPhase: phase }));
    }
    expect(vi.getTimerCount()).toBe(1);
    footer.dispose();
  });
});

describe('FooterComponent — balance flash', () => {
  it('does not start a flash with motion off, and starts one with motion on', () => {
    vi.useFakeTimers();
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const off = new FooterComponent(baseState({ balanceUpdatedAt: 1 }), darkColors, { requestRender: vi.fn() } as unknown as TUI);
    off.setState(baseState({ balanceUpdatedAt: 2 }));
    expect(vi.getTimerCount()).toBe(0);
    off.dispose();
    resetMotion();
    const on = new FooterComponent(baseState({ balanceUpdatedAt: 1 }), darkColors, { requestRender: vi.fn() } as unknown as TUI);
    on.setState(baseState({ balanceUpdatedAt: 2 }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    on.dispose();
  });

  it('stops flashing after dispose, even mid-animation', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const footer = new FooterComponent(baseState(), darkColors, { requestRender } as unknown as TUI);
    footer.setState(baseState({ balanceUpdatedAt: 2000 }));
    vi.advanceTimersByTime(200);
    expect(requestRender).toHaveBeenCalled();
    footer.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(2000);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
