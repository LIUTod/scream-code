/**
 * The session-status sidebar (Ctrl+X, `/sidebar`): one borderless column that
 * watches how Scream is being used and what it is doing right now.
 *
 *   title      会话状态                                  近 45 周
 *   heatmap    a year-shaped calendar, a cell per day, five shades by use
 *   usage      today, 7 days, 30 days, cache hit, active days, streak
 *   live       first-token time with its trend, the background jobs, the
 *              session's numbers, running agents, the goal
 *   models     each model's share of the last 30 days
 *
 * It is a plain column inside a scroll view: when the terminal is not tall
 * enough the mouse wheel (or the scrollbar) moves it, and the keyboard keeps
 * scrolling the transcript. A thin rule on the left tells it from the transcript.
 */

import { type Component, ScrollView, truncateToWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { GoalJudgeState, GoalStatus } from '#/tui/types';
import { displayWidth } from '#/tui/utils/display-width';
import { lerpGradient } from '#/tui/utils/gradient';
import type { SubagentSlot } from '#/tui/utils/subagent-slots';
import { addDays, localDateKey, summarizeUsage, type DayUsage, type UsageSnapshot, OTHER_MODELS } from '#/tui/utils/usage-ledger';

import type { SidebarManager } from './sidebar-manager';

/** Bounds for a width chosen with `/sidebar width`. */
export const SIDEBAR_MIN_WIDTH = 24;
export const SIDEBAR_MAX_WIDTH = 60;
/** The sidebar sits beside the transcript from this terminal width up. */
export const SIDEBAR_MIN_VIEWPORT_WIDTH = 90;
/** On its own the sidebar takes this share of the terminal, within these bounds (60 draws a whole year). */
const AUTO_SHARE = 0.4;
const AUTO_MIN_WIDTH = 40;

export function clampSidebarWidth(cols: number): number {
  if (!Number.isFinite(cols)) return AUTO_MIN_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(cols)));
}

/** The width the sidebar takes on a terminal `cols` wide when the person has not chosen one. */
export function sidebarWidthFor(cols: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(AUTO_MIN_WIDTH, Math.round(cols * AUTO_SHARE)));
}

export interface SidebarSessionStats {
  readonly turns: number;
  readonly toolCalls: number;
  readonly compactions: number;
  /** LLM requests this session: completed steps plus retried attempts. */
  readonly apiCalls: number;
  /** Cumulative token usage (all buckets summed) for this session. */
  readonly tokensTotal: number;
  /** Input tokens that were cache hits. */
  readonly tokensInputCacheHit: number;
  /** Input tokens that were not cached. */
  readonly tokensInputCacheMiss: number;
  /** Output tokens for this session (main agent and all subagents). */
  readonly tokensOutput: number;
}

export interface SidebarGoalData {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  /** Wall-clock ms at the last snapshot; render adds the time since `wallClockBaseAt`. */
  readonly wallClockMs: number;
  readonly wallClockBaseAt: number;
  readonly continuationCount: number;
  readonly completionCriterion: string | null;
  readonly tokensUsed: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly judge: GoalJudgeState;
}

/** Background jobs: only what is worth a row. */
export interface SidebarJobsData {
  readonly hostRunning: boolean;
  readonly waiting: number;
  readonly rows: readonly {
    readonly title: string;
    readonly lastOk: boolean | undefined;
    readonly nextRunAt: number | undefined;
  }[];
}

export interface SidebarData {
  readonly jobs?: SidebarJobsData;
  readonly sessionStats?: SidebarSessionStats;
  readonly agents?: readonly SubagentSlot[];
  readonly goal?: SidebarGoalData;
  /** First-token times of the latest requests, oldest first (ms). */
  readonly firstToken?: readonly number[];
}

const GLYPH = ['·', '░', '▒', '▓', '█'] as const;
const TREND_BARS = '▁▂▃▄▅▆▇█';
const TREND_CELLS = 10;
const MAX_WEEKS = 52;
/** A day is drawn up to this many columns wide. */
const MAX_CELL_COLS = 3;
/** The heatmap is laid out for at least this many weeks, so a new install does not get giant cells. */
const MIN_HISTORY_WEEKS = 12;
/** Fewer weeks than this are never traded for a wider day. */
const MIN_SHOWN_WEEKS = 16;
/** While the history is still being counted, lay out for this many weeks so the cells do not jump as it fills. */
const LOADING_HISTORY_WEEKS = 26;
/** A two-column table needs this much room; narrower, each reading gets its own row. */
const TWO_COLUMNS_FROM = 44;
const TOP_MODELS = 3;
/** Gradient cycle of a busy agent's dot; the 1 s heartbeat moves it half a cycle per tick. */
const AGENT_GRADIENT_CYCLE_MS = 2000;
/** Slow first token reads amber past this, red past the next. */
const FIRST_TOKEN_GOOD_MS = 5_000;
const FIRST_TOKEN_SLOW_MS = 15_000;

export function formatTokens(n: number): string {
  if (n >= 999_500_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${String(Math.round(n / 1_000))}K`;
  return String(n);
}

function formatLatency(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** "今天 09:00" / "明天 09:00" / "周一 08:00" / "11-25 09:00" (and the English equivalents). */
export function formatNextRun(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  const clock = `${p(date.getHours())}:${p(date.getMinutes())}`;
  const startOfDayMs = (ms: number): number => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDayMs(at) - startOfDayMs(now)) / 86_400_000);
  if (days <= 0) return t('sidebar.jobs_today', { time: clock });
  if (days === 1) return t('sidebar.jobs_tomorrow', { time: clock });
  if (days < 7) return t('sidebar.jobs_weekday', { day: t(`sidebar.jobs_day_${String(date.getDay())}`), time: clock });
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${clock}`;
}

function quartiles(days: ReadonlyMap<string, DayUsage>): readonly [number, number, number] | null {
  const counts = [...days.values()].map((d) => d.tokens).filter((n) => n > 0).toSorted((a, b) => a - b);
  if (counts.length === 0) return null;
  const at = (q: number): number => counts[Math.min(counts.length - 1, Math.floor(counts.length * q))]!;
  return [at(0.25), at(0.5), at(0.75)];
}

function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/**
 * The calendar: weeks across, weekdays down (Sunday first, Monday, Wednesday and
 * Friday named), the months along the top, five shades by the quartiles of the
 * days that were used. `width` is the room for the whole block.
 *
 * A terminal cell is about twice as tall as it is wide, so a day drawn one column
 * wide is a thin sliver and the whole picture looks squeezed. The grid therefore
 * makes a day two or three columns wide (the last column is air between days), as
 * wide as still shows 16 weeks (or the whole history when it is shorter); a longer history is cut to its recent
 * weeks, and only a sidebar too narrow for that goes back to one column. Days and months are written in the interface language.
 */
export function heatmapLines(
  snapshot: UsageSnapshot,
  width: number,
  colors: ColorPalette,
  options: { cell?: number } = {},
): { lines: string[]; weeks: number; cell: number } {
  const labelCols = Math.max(...[1, 3, 5].map((d) => displayWidth(t(`sidebar.weekday_${String(d)}`)))) + 1;
  const room = Math.max(8, width - labelCols);
  const today = parseKey(snapshot.today);
  // How many weeks the history spans decides how wide a day can be; while it is still being counted, assume a long one.
  let first: string | undefined;
  for (const [key, day] of snapshot.days) if (day.tokens > 0 && (first === undefined || key < first)) first = key;
  const spanWeeks = first === undefined ? 0 : Math.ceil((today.getTime() - parseKey(first).getTime()) / (7 * 86_400_000)) + 1;
  const wanted = Math.min(MAX_WEEKS, Math.max(snapshot.loading === undefined ? MIN_HISTORY_WEEKS : LOADING_HISTORY_WEEKS, spanWeeks + 1));
  // The widest day that still shows a worthwhile stretch of history: a long history is cut to its recent weeks
  // rather than squeezed into slivers.
  const fitting = [MAX_CELL_COLS, 2, 1].find((c) => Math.floor(room / c) >= Math.min(wanted, MIN_SHOWN_WEEKS)) ?? 1;
  const cell = options.cell ?? fitting;
  const weeks = Math.max(4, Math.min(MAX_WEEKS, Math.floor(room / cell)));
  const start = parseKey(addDays(localDateKey(today.getTime() - today.getDay() * 86_400_000 + 43_200_000), -(weeks - 1) * 7));
  const quartile = quartiles(snapshot.days);
  const quiet = chalk.hex(colors.textMuted);
  const ink = chalk.hex(colors.primary);

  // A used day is its shade with a column of air after it, so neighbours stay apart and every day can be told from
  // the next (a one-column day has no room for the air); an unused one is a dot on the same rhythm.
  const glyphs = cell >= 2 ? cell - 1 : 1;
  const solid = (shade: number): string => ink(GLYPH[shade]!.repeat(glyphs)) + ' '.repeat(cell - glyphs);
  const dot = quiet(GLYPH[0]) + ' '.repeat(cell - 1);
  const grid: string[][] = Array.from({ length: 7 }, () => Array.from({ length: weeks }, () => ' '.repeat(cell)));
  const monthStarts: Array<{ week: number; month: number }> = [];
  let lastMonth = -1;
  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + week * 7 + day);
      if (date.getTime() > today.getTime()) continue;
      if (day === 0 && date.getMonth() !== lastMonth) {
        monthStarts.push({ week, month: date.getMonth() + 1 });
        lastMonth = date.getMonth();
      }
      const tokens = snapshot.days.get(localDateKey(date.getTime() + 43_200_000))?.tokens ?? 0;
      const shade =
        tokens <= 0 || quartile === null ? 0 : tokens >= quartile[2] ? 4 : tokens >= quartile[1] ? 3 : tokens >= quartile[0] ? 2 : 1;
      grid[day]![week] = shade === 0 ? dot : solid(shade);
    }
  }

  // Months. A day two columns or wider leaves room to write each month where its first week is; on a one-column
  // grid the labels are spread evenly instead (the way a year-long calendar does), the oldest dropped first
  // when they would crowd. Either way two labels never touch.
  const total = weeks * cell;
  const names = monthStarts.map((m) => ({ ...m, text: t(`sidebar.month_${String(m.month)}`) }));
  const widest = Math.max(...names.map((m) => displayWidth(m.text)));
  const header: string[] = Array.from({ length: total }, () => ' ');
  const write = (col: number, text: string): void => {
    let at = col;
    for (const ch of text) {
      if (at >= total) return;
      header[at] = ch;
      at += displayWidth(ch);
      for (let k = 1; k < displayWidth(ch) && at - displayWidth(ch) + k < total; k++) header[at - displayWidth(ch) + k] = '';
    }
  };
  if (cell >= 2) {
    // Newest first: they are the ones read.
    let nextStart = total + 1;
    const kept: typeof names = [];
    for (const m of [...names].toReversed()) {
      const col = m.week * cell;
      if (col + displayWidth(m.text) > total || col + displayWidth(m.text) + 1 > nextStart) continue;
      kept.unshift(m);
      nextStart = col;
    }
    for (const m of kept) write(m.week * cell, m.text);
  } else {
    let kept = [...names];
    while (kept.length > 1 && Math.floor(total / kept.length) < widest + 1) kept = kept.slice(1);
    const slot = Math.floor(total / Math.max(kept.length, 1));
    kept.forEach((m, i) => write(i * slot, m.text));
  }
  const lines = [' '.repeat(labelCols) + quiet(header.join('').trimEnd())];
  for (let day = 0; day < 7; day++) {
    const label = day === 1 || day === 3 || day === 5 ? t(`sidebar.weekday_${String(day)}`) : '';
    lines.push(quiet(label + ' '.repeat(Math.max(0, labelCols - displayWidth(label)))) + grid[day]!.join(''));
  }
  // A blank row of air, then the legend.
  lines.push(
    '',
    ' '.repeat(labelCols) + quiet(`${t('sidebar.less')} `) + [1, 2, 3, 4].map((shade) => ink(GLYPH[shade]!.repeat(glyphs))).join(' ') + quiet(` ${t('sidebar.more')}`),
  );
  return { lines, weeks, cell };
}

/** A model's name in `room` columns: the head when that keeps the names apart, else the tail (versions sit at the end). */
export function shortModelNames(names: readonly string[], room: number): string[] {
  // Plain code-point loops rather than the terminal truncation helper: a model id
  // is plain text and the result must be exactly `room` columns, ellipsis included.
  const fit = (name: string, fromEnd: boolean): string => {
    const chars = [...name];
    if (fromEnd) chars.reverse();
    let kept = '';
    let width = 0;
    for (const ch of chars) {
      const w = displayWidth(ch);
      if (width + w > room - 1) break;
      kept = fromEnd ? ch + kept : kept + ch;
      width += w;
    }
    return fromEnd ? `…${kept}` : `${kept}…`;
  };
  const head = names.map((n) => (displayWidth(n) > room ? fit(n, false) : n));
  if (new Set(head).size === head.length) return head;
  return names.map((n) => (displayWidth(n) > room ? fit(n, true) : n));
}

const displayType = (type: string): string => (type.length === 0 ? type : type.charAt(0).toUpperCase() + type.slice(1));

function agentWord(status: SubagentSlot['status']): string {
  switch (status) {
    case 'idle': return t('sidebar.agent_idle');
    case 'working': return t('sidebar.agent_working');
    case 'outputting': return t('sidebar.agent_outputting');
    case 'messaging': return t('sidebar.agent_messaging');
    case 'reworking': return t('sidebar.agent_reworking');
    case 'requesting': return t('sidebar.agent_requesting');
  }
}

function goalWord(status: GoalStatus, judge: GoalJudgeState): string {
  if (judge === 'judging') return t('sidebar.goal_judging');
  switch (status) {
    case 'active': return t('sidebar.goal_active');
    case 'complete': return t('sidebar.goal_completed');
    case 'paused': return t('sidebar.goal_paused');
    case 'blocked': return t('sidebar.goal_blocked');
    default: return String(status);
  }
}

export interface SessionStatusOptions {
  readonly manager: SidebarManager;
  readonly colors: ColorPalette;
  readonly requestRender: () => void;
  /** The usage snapshot to draw; called on every frame the sidebar is open. */
  readonly usage: () => UsageSnapshot;
}

/** The column's content. `width` is the room it is given; on the measuring pass that is the whole terminal. */
export class SessionStatusBody implements Component {
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private view: ScrollView | undefined;

  constructor(private readonly options: SessionStatusOptions) {
    // Live values (the goal clock, a busy agent's colour) move while it is open.
    this.heartbeat = setInterval(() => {
      if (options.manager.isOpen) options.requestRender();
    }, 1000);
    this.heartbeat.unref();
  }

  dispose(): void {
    clearInterval(this.heartbeat);
  }

  /** The scroll view this column lives in: its scrollbar is shown only while the content is taller than the room. */
  attach(view: ScrollView): void {
    this.view = view;
  }

  private syncScrollbar(rows: number): void {
    const view = this.view;
    if (view === undefined) return;
    const wanted = view.viewportHeight > 0 && rows > view.viewportHeight ? 'always' : 'hidden';
    if (view.scrollbar === wanted) return;
    view.setScrollbar(wanted);
    // The content gives up a column to the bar (or takes it back) on the next frame.
    this.options.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { manager, colors: c } = this.options;
    if (!manager.isOpen) {
      this.syncScrollbar(0);
      return [];
    }
    // A width as big as the terminal is the stack asking how wide we want to be.
    const total = width >= SIDEBAR_MIN_VIEWPORT_WIDTH ? manager.widthFor(width) : width;
    const inner = Math.max(10, total - 3); // the rule, a column of air, and one for the scrollbar
    const data = manager.getData();
    const snapshot = this.options.usage();
    const summary = summarizeUsage(snapshot);

    const quiet = chalk.hex(c.textDim);
    const faint = chalk.hex(c.textMuted);
    const text = chalk.hex(c.text);
    const rule = chalk.hex(c.border);
    const out: string[] = [];
    // Every row is exactly `total` wide: the rule, a column of air, the content held to
    // the room (a long goal or an unusual name is cut, never overflows) and a column of
    // air before the scrollbar. The stack measures the column by its widest row, so the
    // sidebar takes the width it was meant to.
    const put = (s = ''): void => {
      const content = displayWidth(s) > inner ? truncateToWidth(s, inner, '…') : s;
      out.push(`${rule('│')} ${content}${' '.repeat(Math.max(0, inner - displayWidth(content)))} `);
    };
    // Left and right with the gap between; when they do not both fit, the right
    // gives way (cut with an ellipsis) before the left does, and nothing passes `room`.
    const pad = (left: string, right: string, room: number): string => {
      const leftWidth = displayWidth(left);
      const rightWidth = displayWidth(right);
      if (leftWidth + rightWidth + 1 <= room) return left + ' '.repeat(room - leftWidth - rightWidth) + right;
      const rightRoom = room - leftWidth - 1;
      return truncateToWidth(rightRoom > 0 ? `${left} ${truncateToWidth(right, rightRoom, '…')}` : left, room, '…');
    };
    const heading = (label: string): void => {
      put();
      put(`${quiet(label)} ${rule('─'.repeat(Math.max(0, inner - displayWidth(label) - 1)))}`);
    };
    // Label · value pairs, two columns when there is room.
    const cells = (items: ReadonlyArray<readonly [string, string]>): void => {
      if (inner >= TWO_COLUMNS_FROM) {
        const half = Math.floor((inner - 3) / 2);
        for (let i = 0; i < items.length; i += 2) {
          const a = items[i]!;
          const b = items[i + 1];
          put(pad(quiet(a[0]), text(a[1]), half) + '   ' + (b === undefined ? '' : pad(quiet(b[0]), text(b[1]), half)));
        }
      } else {
        for (const [label, value] of items) put(pad(quiet(label), text(value), inner));
      }
    };

    // ── title and heatmap ──
    const heat = heatmapLines(snapshot, inner, c);
    const note =
      snapshot.loading === undefined
        ? faint(t('sidebar.weeks', { n: heat.weeks }))
        : chalk.hex(c.warning)(t('sidebar.loading', { pct: Math.round(snapshot.loading * 100) }));
    put(pad(chalk.hex(c.primary).bold(t('sidebar.title')), note, inner));
    put();
    for (const line of heat.lines) put(line);

    // ── usage ──
    heading(t('sidebar.usage'));
    cells([
      [t('sidebar.today'), formatTokens(summary.today)],
      [t('sidebar.days7'), formatTokens(summary.last7)],
      [t('sidebar.days30'), formatTokens(summary.last30)],
      [t('sidebar.cache_hit'), summary.cacheHit === undefined ? '--' : `${String(Math.round(summary.cacheHit * 100))}%`],
      [t('sidebar.active_days'), snapshot.loading === undefined ? String(summary.activeDays) : '…'],
      [t('sidebar.streak'), t('sidebar.streak_value', { n: summary.streak })],
    ]);

    // ── live ──
    heading(t('sidebar.live'));
    this.liveRows(data, put, pad, cells, inner);

    // ── models ──
    const total30 = summary.models.reduce((sum, m) => sum + m.tokens, 0);
    if (total30 > 0) {
      heading(t('sidebar.models'));
      const real = summary.models.filter((m) => m.id !== OTHER_MODELS);
      const top = real.slice(0, TOP_MODELS);
      const restTokens = total30 - top.reduce((sum, m) => sum + m.tokens, 0);
      const restCount = real.length - top.length + (summary.models.length - real.length);
      const barCols = inner >= TWO_COLUMNS_FROM ? 10 : 6;
      const room = Math.max(8, inner - barCols - 2 - 4);
      const names = shortModelNames(top.map((m) => m.id), room);
      const padName = (name: string): string => name + ' '.repeat(Math.max(0, room - displayWidth(name)));
      top.forEach((m, i) => {
        const share = m.tokens / total30;
        const filled = Math.max(1, Math.round(share * barCols));
        put(
          quiet(padName(names[i]!)) + ' ' + chalk.hex(c.primary)('█'.repeat(filled)) + chalk.hex(c.border)('░'.repeat(barCols - filled)) +
            ' ' + text(`${String(Math.round(share * 100))}%`.padStart(4)),
        );
      });
      if (restTokens > 0) {
        put(
          faint(padName(t('sidebar.models_other', { n: Math.max(1, restCount) }))) + ' ' + chalk.hex(c.border)('░'.repeat(barCols)) + ' ' +
            faint(`${String(Math.round((restTokens / total30) * 100))}%`.padStart(4)),
        );
      }
    }
    this.syncScrollbar(out.length);
    return out;
  }

  private liveRows(
    data: SidebarData,
    put: (s?: string) => void,
    pad: (left: string, right: string, room: number) => string,
    cells: (items: ReadonlyArray<readonly [string, string]>) => void,
    inner: number,
  ): void {
    const c = this.options.colors;
    const quiet = chalk.hex(c.textDim);
    const faint = chalk.hex(c.textMuted);
    const text = chalk.hex(c.text);

    // First-token time of the model in use, with the last few requests as a trend.
    const history = data.firstToken ?? [];
    const last = history.at(-1);
    const label = t('sidebar.first_token');
    if (last === undefined) {
      put(pad(quiet(label), faint('--'), inner));
    } else {
      const value = formatLatency(last);
      // The trend gives up cells before the reading or the label does.
      const cells = Math.max(0, Math.min(TREND_CELLS, inner - displayWidth(label) - displayWidth(value) - 2));
      const recent = history.slice(-cells);
      const max = Math.max(...recent, 1);
      const trend = recent.map((ms) => TREND_BARS[Math.min(7, Math.floor((ms / max) * 7.999))]!).join('');
      const tone = last <= FIRST_TOKEN_GOOD_MS ? c.success : last <= FIRST_TOKEN_SLOW_MS ? c.warning : c.error;
      put(pad(quiet(label), `${cells > 0 ? `${faint(trend)} ` : ''}${chalk.hex(tone)(value)}`, inner));
    }

    // Background jobs: one row, and only when there is something to say.
    const jobs = data.jobs;
    if (jobs !== undefined && (jobs.rows.length > 0 || jobs.waiting > 0)) {
      const next = jobs.rows
        .map((row) => row.nextRunAt)
        .filter((at): at is number => at !== undefined)
        .toSorted((a, b) => a - b)[0];
      const name = quiet(t('sidebar.jobs'));
      if (jobs.waiting > 0) put(pad(name, chalk.hex(c.warning)(t('sidebar.jobs_waiting_n', { n: jobs.waiting })), inner));
      else if (!jobs.hostRunning) put(pad(name, chalk.hex(c.warning)(t('sidebar.jobs_stopped')), inner));
      else put(pad(name, text(next === undefined ? t('sidebar.jobs_running') : t('sidebar.jobs_next', { when: formatNextRun(next) })), inner));
    }

    // The session's own numbers, once it has made a request.
    const stats = data.sessionStats;
    if (stats !== undefined && stats.apiCalls > 0) {
      const input = stats.tokensInputCacheHit + stats.tokensInputCacheMiss;
      cells([
        [t('sidebar.session'), formatTokens(stats.tokensTotal)],
        [t('sidebar.hit_rate'), input > 0 ? `${String(Math.round((stats.tokensInputCacheHit / input) * 100))}%` : '--'],
        [t('sidebar.turns'), String(stats.turns)],
        [t('sidebar.calls'), String(stats.apiCalls)],
      ]);
    }

    // Only the agents that are doing something; a busy one pulses along the brand gradient.
    const running = (data.agents ?? []).filter((slot) => slot.status !== 'idle');
    running.forEach((slot, index) => {
      const busy = slot.status === 'working' || slot.status === 'outputting';
      const phase = ((Date.now() % AGENT_GRADIENT_CYCLE_MS) / AGENT_GRADIENT_CYCLE_MS + index * 0.6180339887498949) % 1;
      const paint = busy ? chalk.hex(lerpGradient(phase)).bold : chalk.hex(slot.status === 'requesting' ? c.warning : c.primary);
      const word = agentWord(slot.status) + (slot.count > 1 ? `  ×${String(slot.count)}` : '');
      put(pad(`${paint('●')} ${text(displayType(slot.type))}`, busy ? paint(word) : quiet(word), inner));
    });

    // The goal: what it is, then where it stands.
    const goal = data.goal;
    if (goal !== undefined) {
      // The clock only runs while the goal does: paused, blocked and finished goals are frozen.
      const wallMs = goal.status === 'active' ? goal.wallClockMs + Math.max(0, Date.now() - goal.wallClockBaseAt) : goal.wallClockMs;
      const minutes = Math.max(1, Math.round(wallMs / 60_000));
      put(`${chalk.hex(c.primary)('◆')} ${text(displayWidth(goal.objective) > inner - 2 ? truncateToWidth(goal.objective, inner - 2) : goal.objective)}`);
      put(quiet(`  ${t('sidebar.goal_line', { status: goalWord(goal.status, goal.judge), turns: goal.turnsUsed, minutes })}`));
    }
  }
}

/**
 * The scrollable column the layout mounts. The scrollbar is a bright `┃` on the
 * right edge, drawn only while the content is taller than the room; the wheel
 * over it scrolls it and never the transcript.
 */
export function createSessionStatusView(options: SessionStatusOptions): { view: ScrollView; body: SessionStatusBody } {
  const body = new SessionStatusBody(options);
  const view = new ScrollView(body, {
    follow: 'none',
    overscroll: 'contain',
    scrollbar: 'hidden',
    scrollbarStyle: () => chalk.hex(options.colors.primary)('┃'),
  });
  body.attach(view);
  return { view, body };
}
