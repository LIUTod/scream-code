import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { setLocale } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import {
  clampSidebarWidth,
  createSessionStatusView,
  formatNextRun,
  formatTokens,
  heatmapLines,
  SessionStatusBody,
  shortModelNames,
  sidebarWidthFor,
  type SidebarData,
} from '#/tui/components/sidebar/session-status';
import { darkColors } from '#/tui/theme/colors';
import type { SubagentSlot } from '#/tui/utils/subagent-slots';
import { OTHER_MODELS, type DayUsage, type UsageSnapshot } from '#/tui/utils/usage-ledger';

const strip = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
const sgr = (hex: string): string => {
  const v = hex.replace(/^#/, '');
  return `\u001B[38;2;${String(Number.parseInt(v.slice(0, 2), 16))};${String(Number.parseInt(v.slice(2, 4), 16))};${String(Number.parseInt(v.slice(4, 6), 16))}m`;
};

const TODAY = '2026-11-27'; // a Friday
const NOW = new Date(2026, 10, 27, 15).getTime();
const day = (tokens: number, extra: Partial<DayUsage> = {}): DayUsage => ({ tokens, input: tokens, cacheRead: 0, requests: 1, ...extra });
const snapshot = (entries: Record<string, DayUsage>, extra: Partial<UsageSnapshot> = {}): UsageSnapshot => ({ days: new Map(Object.entries(entries)), today: TODAY, ...extra });

let level = chalk.level;
beforeEach(() => {
  level = chalk.level;
  chalk.level = 3;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  setLocale('zh');
});
afterEach(() => {
  chalk.level = level;
  vi.restoreAllMocks();
  setLocale('zh');
});

describe('widths', () => {
  it('follows the terminal at about 40%, between 40 and 60 columns, and clamps a chosen width', () => {
    expect([90, 100, 130, 150, 300].map(sidebarWidthFor)).toEqual([40, 40, 52, 60, 60]);
    expect(clampSidebarWidth(10)).toBe(24);
    expect(clampSidebarWidth(90)).toBe(60);
    expect(clampSidebarWidth(36.4)).toBe(36);
  });
});

describe('formatTokens', () => {
  it('reads K, M and B, and does not round a thousand up into the next unit early', () => {
    expect([0, 999, 1_000, 361_000, 999_499, 999_500, 520_500_000, 4_800_000_000].map(formatTokens)).toEqual(['0', '999', '1K', '361K', '999K', '1.0M', '520.5M', '4.8B']);
  });
});

describe('formatNextRun', () => {
  it('says today, tomorrow, a weekday and a date', () => {
    expect(formatNextRun(new Date(2026, 10, 27, 18).getTime(), NOW)).toBe('今天 18:00');
    expect(formatNextRun(new Date(2026, 10, 28, 9).getTime(), NOW)).toBe('明天 09:00');
    expect(formatNextRun(new Date(2026, 10, 30, 8).getTime(), NOW)).toBe('周一 08:00');
    expect(formatNextRun(new Date(2026, 11, 20, 8).getTime(), NOW)).toBe('12-20 08:00');
  });
});

describe('heatmapLines', () => {
  const rowsOf = (width: number, snap = snapshot({})): { lines: string[]; weeks: number } => {
    const heat = heatmapLines(snap, width, darkColors);
    return { lines: heat.lines.map(strip), weeks: heat.weeks };
  };

  it('is a calendar: weeks across, seven weekdays down with Monday, Wednesday and Friday named, and a legend', () => {
    const { lines } = rowsOf(52);
    expect(lines).toHaveLength(1 + 7 + 1);
    const names = (rows: string[]): string[] => rows.slice(1, 8).map((l) => /^\S*/.exec(l)![0]);
    expect(names(lines)).toEqual(['', '周一', '', '周三', '', '周五', '']);
    expect(lines.at(-1)).toContain('少 ░░ ▒▒ ▓▓ ██ 多');
    setLocale('en');
    const en = heatmapLines(snapshot({}), 52, darkColors).lines.map(strip);
    expect(names(en)).toEqual(['', 'Mon', '', 'Wed', '', 'Fri', '']);
    expect(en.at(-1)).toContain('Less ░░ ▒▒ ▓▓ ██ More');
  });

  it('makes a day as wide as still shows a worthwhile stretch, and cuts a long history to its recent weeks', () => {
    // A new install: the whole (short) history fits with three-column days.
    expect(heatmapLines(snapshot({}), 52, darkColors)).toMatchObject({ cell: 3, weeks: 15 });
    // Forty weeks of history do not fit in 52 columns: two-column days, the recent half year.
    const long = snapshot({ '2026-02-06': day(10), [TODAY]: day(10) });
    expect(heatmapLines(long, 52, darkColors)).toMatchObject({ cell: 2, weeks: 23 });
    // A wide sidebar draws the whole year, a year at most.
    expect(heatmapLines(long, 400, darkColors)).toMatchObject({ cell: 3, weeks: 52 });
    // While the history is still being counted the cells are laid out for a long one, so they do not jump when it lands.
    expect(heatmapLines(snapshot({}, { loading: 0.3 }), 52, darkColors).cell).toBe(2);
    // Too narrow for two columns a day: one, and a few weeks at least.
    expect(heatmapLines(long, 20, darkColors)).toMatchObject({ cell: 1, weeks: 15 });
    expect(heatmapLines(long, 6, darkColors).weeks).toBe(8);
  });

  it('keeps every row inside the room it was given, the future blank', () => {
    for (const width of [20, 30, 44, 52, 56, 80]) {
      for (const line of heatmapLines(snapshot({ [TODAY]: day(10) }), width, darkColors).lines) {
        expect(visibleWidth(line), `width ${String(width)}`).toBeLessThanOrEqual(Math.max(width, 12));
      }
    }
    // Today is a Friday: the Saturday cell of this week has not happened yet.
    const { lines } = rowsOf(30);
    expect(visibleWidth(lines[7]!.trimEnd())).toBeLessThan(visibleWidth(lines[6]!.trimEnd()));
  });

  it('writes months in the interface language, each above the week it starts in, never two touching', () => {
    const { weeks, cell } = heatmapLines(snapshot({}), 52, darkColors);
    const zh = rowsOf(52).lines[0]!;
    expect(zh.trim().split(/\s+/).at(-1)).toBe('11月');
    expect(zh.trim().split(/\s+/).every((w) => /^\d+月$/.test(w))).toBe(true);
    // 2026-11-01 is a Sunday three weeks before the week of today: its label sits over that week's column.
    expect(visibleWidth(zh.slice(0, zh.indexOf('11月')))).toBe(5 + (weeks - 4) * cell);

    setLocale('en');
    // The English weekday names are a column narrower, which can add a week.
    const heat = heatmapLines(snapshot({}), 52, darkColors);
    const en = strip(heat.lines[0]!);
    const words = en.trim().split(/\s+/);
    expect(words.at(-1)).toBe('Nov');
    expect(words.every((w) => /^[A-Z][a-z]{2}$/.test(w))).toBe(true);
    expect(en.indexOf('Nov')).toBe(4 + (heat.weeks - 4) * heat.cell);
    expect(en).not.toMatch(/[a-z][A-Z]/);
  });

  it('spreads the months evenly on a one-column grid, the oldest dropped first when they would crowd', () => {
    setLocale('en');
    const long = snapshot({ '2026-02-06': day(10), [TODAY]: day(10) });
    const narrow = strip(heatmapLines(long, 20, darkColors).lines[0]!);
    const words = narrow.trim().split(/\s+/);
    expect(words.at(-1)).toBe('Nov');
    expect(words.length).toBeLessThanOrEqual(4);
    expect(narrow).not.toMatch(/[a-z][A-Z]/);
  });

  it('shades by the quartiles of the days that were used, and shows unused days as a dot', () => {
    const days: Record<string, DayUsage> = {};
    // Ten used days, 1..10 (the weekday rows are Sun..Sat; these fall in the last two weeks).
    for (let i = 0; i < 10; i++) {
      const d = new Date(2026, 10, 27 - i);
      days[`${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = day((10 - i) * 100);
    }
    const cells = heatmapLines(snapshot(days), 30, darkColors).lines.slice(1, 8).map(strip).join('');
    expect(cells).toContain('█');
    expect(cells).toContain('░');
    expect(cells).toContain('·');
    // Coloured with the brand colour, the unused dots in the quiet one.
    const raw = heatmapLines(snapshot(days), 30, darkColors).lines.join('');
    expect(raw).toContain(sgr(darkColors.primary));
    expect(raw).toContain(sgr(darkColors.textMuted));
  });

  it('shows nothing but dots when nothing was used', () => {
    expect(rowsOf(30).lines.slice(1, 8).join('')).not.toMatch(/[░▒▓█]/);
  });
});

describe('shortModelNames', () => {
  it('cuts the head when that keeps the names apart', () => {
    expect(shortModelNames(['alpha-v4.1-flash-1017', 'beta-5.3-flash'], 12)).toEqual(['alpha-v4.1-…', 'beta-5.3-fl…']);
  });

  it('keeps the end instead when the heads would be the same (versions sit at the end)', () => {
    const names = ['alpha-v4.1-flash-1017', 'alpha-v4.1-flash', 'alpha-v4.1-flash-1017-guan'];
    const short = shortModelNames(names, 12);
    expect(new Set(short).size).toBe(3);
    expect(short[0]).toBe('…-flash-1017');
    expect(short.every((n) => visibleWidth(n) <= 12)).toBe(true);
  });

  it('leaves a name that fits alone', () => {
    expect(shortModelNames(['a', 'bb'], 12)).toEqual(['a', 'bb']);
  });
});

describe('SessionStatusBody', () => {
  const slot = (type: string, status: SubagentSlot['status'], count = 1): SubagentSlot => ({ type, status, agentId: undefined, detail: undefined, count, lastActivityAt: NOW });
  const models = (entries: Record<string, number>): DayUsage => day(Object.values(entries).reduce((a, b) => a + b, 0), { models: entries });

  function make(data: SidebarData, snap: UsageSnapshot, open = true): { body: SessionStatusBody; manager: SidebarManager } {
    const manager = new SidebarManager(() => {});
    manager.setDataProvider(() => data);
    if (open) manager.toggle();
    const body = new SessionStatusBody({ manager, colors: darkColors, requestRender: () => {}, usage: () => snap });
    return { body, manager };
  }
  const plain = (lines: string[]): string[] => lines.map((l) => strip(l).trimEnd());
  const FULL = snapshot({
    '2026-11-27': models({ alpha: 600, beta: 200 }),
    '2026-11-26': models({ alpha: 100, gamma: 50, delta: 30, 'eps-1': 20 }),
    '2026-11-25': day(1000, { cacheRead: 970, input: 1000 }),
  });

  afterEach(() => undefined);

  it('is empty while the sidebar is closed', () => {
    const { body } = make({}, FULL, false);
    expect(body.render(130)).toEqual([]);
    body.dispose();
  });

  it('answers the stack\'s width question from the manager, and uses the room it is then given as is', () => {
    const { body, manager } = make({}, FULL);
    // Every row is exactly as wide as the sidebar: the stack measures a column by its widest row.
    expect(new Set(body.render(130).map((l) => visibleWidth(l)))).toEqual(new Set([manager.widthFor(130)]));
    expect(new Set(body.render(52).map((l) => visibleWidth(l)))).toEqual(new Set([52]));
    manager.setWidth(36);
    expect(new Set(body.render(150).map((l) => visibleWidth(l)))).toEqual(new Set([36]));
    body.dispose();
  });

  it('never draws a row wider than the room, at any width the sidebar can have, in both languages', () => {
    const data: SidebarData = {
      sessionStats: { turns: 25, toolCalls: 1, compactions: 0, apiCalls: 130, tokensTotal: 2_267_680, tokensInputCacheHit: 2_100_000, tokensInputCacheMiss: 120_000, tokensOutput: 47_680 },
      agents: [slot('coder', 'working', 2), slot('explore', 'outputting'), slot('plan', 'idle')],
      goal: { objective: '修复登录重定向并补齐所有相关测试用例以及文档', status: 'active', turnsUsed: 7, wallClockMs: 180_000, wallClockBaseAt: NOW, continuationCount: 0, completionCriterion: null, tokensUsed: 1, inputTokens: null, outputTokens: null, judge: 'awaiting' },
      jobs: { hostRunning: true, waiting: 0, rows: [{ title: 'x', lastOk: true, nextRunAt: NOW + 3_600_000 }] },
      firstToken: [1100, 1300, 900, 2400, 1800, 1200, 1300, 2100, 1500, 1300],
    };
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale);
      const { body } = make(data, FULL);
      for (let width = 24; width <= 60; width++) {
        for (const line of body.render(width)) expect(visibleWidth(line), `${locale} ${String(width)}: ${strip(line)}`).toBeLessThanOrEqual(width);
      }
      body.dispose();
    }
  });

  it('heads the column and sets a thin rule on the left of every row', () => {
    const { body } = make({}, FULL);
    const lines = plain(body.render(52));
    expect(lines[0]).toMatch(/^│ 会话状态 +近 \d+ 周$/);
    expect(lines.every((l) => l.startsWith('│'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/[┌┐└┘]/);
    body.dispose();
  });

  it('puts the usage numbers in two columns when there is room, one when there is not', () => {
    const { body } = make({}, FULL);
    const wide = plain(body.render(52)).join('\n');
    expect(wide).toMatch(/今日 +\S+ +近 7 天 +\S+/);
    const narrow = plain(body.render(40)).join('\n');
    expect(narrow).toMatch(/今日 +\S+\n│ 近 7 天/);
    expect(narrow).not.toMatch(/今日 +\S+ +近 7 天/);
    body.dispose();
  });

  it('reads today, 7 days, 30 days, the cache share, active days and the streak', () => {
    const { body } = make({}, FULL);
    const text = plain(body.render(52)).join('\n');
    expect(text).toMatch(/今日 +800/);
    expect(text).toMatch(/近 30 天 +2K/);
    expect(text).toMatch(/缓存命中 +49%/);
    expect(text).toMatch(/活跃天数 +3/);
    expect(text).toMatch(/连续 +3 天/);
    body.dispose();
  });

  it('says it is still counting the history, and does not claim the active days yet', () => {
    const { body } = make({}, snapshot({ [TODAY]: day(5) }, { loading: 0.4 }));
    const lines = plain(body.render(52));
    expect(lines[0]).toMatch(/正在统计历史用量 40%/);
    expect(lines.join('\n')).toMatch(/活跃天数 +…/);
    expect(body.render(52)[0]).toContain(sgr(darkColors.warning));
    body.dispose();
  });

  it('lists the three biggest models of the last 30 days and folds the rest', () => {
    const { body } = make({}, FULL);
    const text = plain(body.render(52)).join('\n');
    expect(text).toContain('模型 · 近 30 天');
    expect(text).toMatch(/alpha +█+░* +\d+%/);
    expect(text).toMatch(/其他 2 个 +░+ +\d+%/);
    const shares = [...text.matchAll(/(\d+)%\n/g)].map((m) => Number(m[1]));
    expect(shares.length).toBeGreaterThan(0);
    body.dispose();
  });

  it('counts a day\'s "other" models as the rest, and shows no model block without any model data', () => {
    const withOther = snapshot({ [TODAY]: models({ alpha: 80, [OTHER_MODELS]: 20 }) });
    const { body } = make({}, withOther);
    expect(plain(body.render(52)).join('\n')).toMatch(/其他 1 个 +░+ +20%/);
    const none = make({}, snapshot({ [TODAY]: day(10) }));
    expect(plain(none.body.render(52)).join('\n')).not.toContain('模型 ·');
    body.dispose();
    none.body.dispose();
  });

  it('shows the first-token time with its trend, coloured by how slow it is, and "--" before a measurement', () => {
    const fast = make({ firstToken: [3000, 1000, 2000] }, FULL);
    const row = fast.body.render(52).find((l) => strip(l).includes('首字延迟'))!;
    expect(strip(row).trimEnd()).toMatch(/首字延迟 +[▁-█]+ 2\.0s$/);
    expect(row).toContain(sgr(darkColors.success));
    const slow = make({ firstToken: [9000] }, FULL);
    expect(slow.body.render(52).find((l) => strip(l).includes('首字延迟'))).toContain(sgr(darkColors.warning));
    const dead = make({ firstToken: [20_000] }, FULL);
    expect(dead.body.render(52).find((l) => strip(l).includes('首字延迟'))).toContain(sgr(darkColors.error));
    const none = make({}, FULL);
    expect(plain(none.body.render(52)).join('\n')).toMatch(/首字延迟 +--/);
    for (const m of [fast, slow, dead, none]) m.body.dispose();
  });

  it('gives the background jobs one row, and only when there is something to say', () => {
    const jobs = (over: Partial<NonNullable<SidebarData['jobs']>>): SidebarData => ({
      jobs: { hostRunning: true, waiting: 0, rows: [{ title: 'a', lastOk: true, nextRunAt: new Date(2026, 10, 27, 18).getTime() }], ...over },
    });
    const row = (data: SidebarData): string | undefined => {
      const m = make(data, FULL);
      const line = plain(m.body.render(52)).find((l) => l.includes('后台任务'));
      m.body.dispose();
      return line;
    };
    expect(row(jobs({}))).toMatch(/后台任务 +下次 今天 18:00$/);
    expect(row(jobs({ waiting: 2 }))).toMatch(/后台任务 +待处理 2$/);
    expect(row(jobs({ hostRunning: false }))).toMatch(/后台任务 +未运行$/);
    expect(row(jobs({ rows: [] }))).toBeUndefined();
    expect(row({})).toBeUndefined();
    const m = make(jobs({ waiting: 1 }), FULL);
    expect(m.body.render(52).find((l) => strip(l).includes('待处理'))).toContain(sgr(darkColors.warning));
    m.body.dispose();
  });

  it('shows the session numbers only once it has made a request', () => {
    const stats = { turns: 25, toolCalls: 1, compactions: 0, apiCalls: 130, tokensTotal: 2_267_680, tokensInputCacheHit: 2_100_000, tokensInputCacheMiss: 120_000, tokensOutput: 1 };
    const live = make({ sessionStats: stats }, FULL);
    const text = plain(live.body.render(52)).join('\n');
    expect(text).toMatch(/本会话 +2\.3M/);
    expect(text).toMatch(/命中率 +95%/);
    expect(text).toMatch(/轮次 +25/);
    expect(text).toMatch(/调用 +130/);
    const quiet = make({ sessionStats: { ...stats, apiCalls: 0 } }, FULL);
    expect(plain(quiet.body.render(52)).join('\n')).not.toContain('本会话');
    live.body.dispose();
    quiet.body.dispose();
  });

  it('lists only the agents that are doing something, with their count', () => {
    const { body } = make({ agents: [slot('coder', 'working', 3), slot('explore', 'outputting'), slot('plan', 'idle'), slot('oracle', 'requesting')] }, FULL);
    const text = plain(body.render(52)).join('\n');
    expect(text).toMatch(/● Coder +工作中  ×3/);
    expect(text).toMatch(/● Explore +输出中/);
    expect(text).toMatch(/● Oracle +求助中/);
    expect(text).not.toContain('Plan');
    body.dispose();
  });

  it('shows the goal on two rows, and freezes its clock unless it is active', () => {
    const goal = (status: 'active' | 'paused' | 'complete', judge: 'awaiting' | 'judging' = 'awaiting'): SidebarData => ({
      goal: { objective: '修复登录重定向', status, turnsUsed: 7, wallClockMs: 180_000, wallClockBaseAt: NOW - 600_000, continuationCount: 0, completionCriterion: null, tokensUsed: 0, inputTokens: null, outputTokens: null, judge },
    });
    const read = (data: SidebarData): string[] => {
      const m = make(data, FULL);
      const lines = plain(m.body.render(52));
      m.body.dispose();
      return lines;
    };
    const active = read(goal('active'));
    const i = active.findIndex((l) => l.includes('◆ 修复登录重定向'));
    expect(active[i + 1]).toMatch(/进行中 · 7 轮 · 13 分钟/);
    expect(read(goal('paused')).join('\n')).toMatch(/已暂停 · 7 轮 · 3 分钟/);
    expect(read(goal('complete')).join('\n')).toMatch(/已完成 · 7 轮 · 3 分钟/);
    expect(read(goal('active', 'judging')).join('\n')).toMatch(/裁定中 · 7 轮/);
  });

  it('speaks English with an English interface', () => {
    setLocale('en');
    const { body } = make({ firstToken: [1000] }, FULL);
    const text = plain(body.render(52)).join('\n');
    expect(text).toContain('Session status');
    expect(text).toMatch(/Today +800/);
    expect(text).toMatch(/First token/);
    expect(text).toContain('Models · 30 days');
    expect(text).toMatch(/Mon /);
    expect(text).not.toMatch(/周一|\d月/);
    body.dispose();
  });

  it('writes the calendar\'s days and months in Chinese with a Chinese interface', () => {
    const { body } = make({}, FULL);
    const text = plain(body.render(52)).join('\n');
    expect(text).toMatch(/周一 /);
    expect(text).toMatch(/\d+月/);
    expect(text).not.toMatch(/Mon |Nov/);
    body.dispose();
  });

  it('repaints once a second while open, and stops when disposed', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const manager = new SidebarManager(() => {});
    manager.toggle();
    const body = new SessionStatusBody({ manager, colors: darkColors, requestRender: render, usage: () => FULL });
    vi.advanceTimersByTime(3000);
    expect(render).toHaveBeenCalledTimes(3);
    manager.toggle();
    render.mockClear();
    vi.advanceTimersByTime(3000);
    expect(render).not.toHaveBeenCalled();
    manager.toggle();
    body.dispose();
    vi.advanceTimersByTime(3000);
    expect(render).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('createSessionStatusView', () => {
  function build() {
    const manager = new SidebarManager(() => {});
    manager.toggle();
    const requestRender = vi.fn();
    const { view, body } = createSessionStatusView({ manager, colors: darkColors, requestRender, usage: () => snapshot({ [TODAY]: day(5) }) });
    return { view, body, manager, requestRender };
  }
  const setViewport = (view: object, rows: number): void => {
    Object.defineProperty(view, 'viewportHeight', { get: () => rows, configurable: true });
  };

  it('is a scroll view that keeps the wheel to itself and shows no scrollbar until it overflows', () => {
    const { view, body } = build();
    expect(view.overscroll).toBe('contain');
    expect(view.scrollbar).toBe('hidden');
    body.dispose();
  });

  it('turns the scrollbar on when the content is taller than the room, off when it fits, and asks for a repaint', () => {
    const { view, body, requestRender } = build();
    const rows = body.render(52).length;
    setViewport(view, rows - 3);
    body.render(52);
    expect(view.scrollbar).toBe('always');
    expect(requestRender).toHaveBeenCalled();
    requestRender.mockClear();
    body.render(52);
    expect(requestRender).not.toHaveBeenCalled();
    setViewport(view, rows + 5);
    body.render(52);
    expect(view.scrollbar).toBe('hidden');
    body.dispose();
  });

  it('draws the thumb as a bright ┃ in the brand colour', () => {
    const { view, body } = build();
    expect(view.scrollbarStyle(' ')).toBe(`${sgr(darkColors.primary)}┃\u001B[39m`);
    body.dispose();
  });

  it('hides the scrollbar while closed, so a closed sidebar leaves no bar behind', () => {
    const { view, body, manager } = build();
    setViewport(view, 5);
    body.render(52);
    expect(view.scrollbar).toBe('always');
    manager.toggle();
    body.render(52);
    expect(view.scrollbar).toBe('hidden');
    body.dispose();
  });
});
