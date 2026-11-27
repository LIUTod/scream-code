/**
 * Footer — the fixed block at the bottom of the TUI (distinct from the status
 * row above the editor, which says what is going on right now).
 *
 * Layout (two rows; one on a short terminal):
 *   Row 1  measurements  `Alpha 1   Cache 92%   ¥12.40   git +34 -8`  … `ctx ━━──────── 28%`
 *          (a transient hint takes the gauge's place while active)
 *   Row 2  controls      mode pills (计划/RLM/群狼, goal, background work, MCP
 *                        problem), then the keys that work now (`/ 命令  Shift+Tab 计划`,
 *                        or `Esc 中断` while working)
 *                        … the one notice in the notice slot, `◆ Line: Lark`
 *
 * What is not here: the work state (it lives in the status row; this row only
 * carries it when the terminal is too narrow for that row), MCP while healthy,
 * and anything with no data (cache before the first reply, a clean git tree,
 * a channel that is not running).
 *
 * Both rows are fitted item by item (utils/fit-row): when the terminal is too
 * narrow an item first shrinks to a shorter variant and is then dropped whole,
 * lowest priority first. Nothing is ever cut in the middle. A short terminal
 * (see COMPACT_FOOTER_ROWS) folds the two rows into one.
 */

import type { Component, TUI } from '@liutod-scream/pi-tui';
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import { CHROME_GUTTER, COMPACT_FOOTER_ROWS, STATUS_ROW_MIN_WIDTH } from '#/tui/constant/rendering';
import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, GoalBadgeInfo } from '#/tui/types';
import { contextLevel } from '#/tui/utils/context-level';
import { type FitItem, fitRow } from '#/tui/utils/fit-row';
import { motionEnabled } from '#/tui/utils/motion';
import { shimmerText } from '#/tui/utils/shimmer';
import { workState } from '#/tui/utils/status-text';
import { safeUsageRatio } from '#/utils/usage/usage-format';

function shortenModel(model: string): string {
  if (!model) return model;
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  return model?.displayName ?? model?.model ?? state.model;
}

const CONTEXT_BAR_WIDTH = 10;
// A thin gauge: heavy rule for the used share, light rule for the rest — one
// continuous line, lighter on the row than a chain of blocks (both 1 column).
const CONTEXT_BAR_FILLED = '━';
const CONTEXT_BAR_EMPTY = '─';
const BALANCE_FLASH_MS = 1500;
/** Repaint cadence while something runs: the clocks (goal, a stall) are information, not decoration. */
const CLOCK_TICK_MS = 1000;

function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `; // unknown currency: show the code as its own label
}

/**
 * Context gauge: `ctx  ━━──────── 28%`.
 *
 * The label is dim; the used share and the percentage carry the usage colour
 * (plain text while usage is low, then warning, then error), and the unused
 * share is a dim track — so the reading, not the label, is what stands out.
 * The fill is floored so the gauge never overstates usage, but any non-zero
 * usage keeps one cell lit (an empty gauge next to "<1%" reads as a bug);
 * the percentage is floored too, `<1%` below one percent. `barWidth` 0 drops
 * the gauge on narrow rows and keeps label and percentage.
 */
function formatContextStatus(usage: number, barWidth: number, colors: ColorPalette, usageColor: string): string {
  const clamped = Math.min(1, Math.max(0, safeUsageRatio(usage)));
  const percent = clamped > 0 && clamped < 0.01 ? '<1%' : `${String(Math.floor(clamped * 100))}%`;
  const label = chalk.hex(colors.textDim)('ctx');
  const reading = chalk.hex(usageColor)(percent);
  if (barWidth <= 0) return `${label} ${reading}`;
  const filled =
    clamped >= 1 ? barWidth : clamped > 0 ? Math.max(1, Math.floor(clamped * barWidth)) : 0;
  const bar =
    chalk.hex(usageColor)(CONTEXT_BAR_FILLED.repeat(filled)) +
    chalk.hex(colors.border)(CONTEXT_BAR_EMPTY.repeat(barWidth - filled));
  return `${label}  ${bar} ${reading}`;
}

/** Format goal wall-clock duration compactly: `3m`, `1m30s`, `45s`. */
function formatGoalDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/**
 * Live wall-clock reading of the goal, in ms.
 *
 * The TUI only receives `goal.updated` events on state changes, so we keep a
 * local base timestamp and add the elapsed time since the last snapshot to
 * produce a live reading between sparse events.
 */
function liveGoalMs(goal: GoalBadgeInfo): number {
  return goal.wallClockMs + Math.max(0, Date.now() - goal.wallClockBaseAt);
}

/** Goal readout, longest first: `目标 3m · 7轮` → `目标 7轮` → `目标`. */
function goalVariants(goal: GoalBadgeInfo): string[] {
  const turns = String(goal.turnsUsed);
  return [
    t('footer.goal', { time: formatGoalDuration(liveGoalMs(goal)), turns }),
    t('footer.goal_turns', { turns }),
    t('badge.goal'),
  ];
}

// Context-usage threshold coloring: the used share OR an absolute token count,
// whichever trips first (see utils/context-level). Percent-only was late on 1M
// windows; on 200K/256K windows the percentage still decides.
function pickContextColor(usage: number, maxTokens: number, colors: ColorPalette): string {
  const level = contextLevel(safeUsageRatio(usage), maxTokens);
  if (level === 'error') return colors.error;
  if (level === 'warning') return colors.warning;
  // Plain text, not dim: the used share must stand out from the dim track.
  return colors.text;
}

/** Context gauge variants, widest bar first (10 cells → 6 → percentage only). */
const CONTEXT_BAR_STEPS = [CONTEXT_BAR_WIDTH, 6, 0] as const;

/** Display widths the model name may shrink to, widest first (`…` included). */
const MODEL_NAME_STEPS = [24, 18, 14, 11, 9, 7, 5] as const;

/**
 * Narrowest name the model is cut to before the gauge is given up. Steps down
 * to this width come before the gauge is dropped; cutting the name further
 * (down to `MODEL_NAME_STEPS`' last entry) only happens once the gauge is gone,
 * so a name is never butchered to keep a readout that could simply be dropped.
 */
const MODEL_NAME_COMFORT_COLS = 7;

/** Display widths the notice may shrink to before it is dropped. */
const NOTICE_STEPS = [48, 34, 22, 14] as const;

function shrinkVariants(text: string, steps: readonly number[]): string[] {
  const out = [text];
  const width = visibleWidth(text);
  for (const cols of steps) if (cols < width) out.push(truncateToWidth(text, cols, '…'));
  return out;
}

export class FooterComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private readonly ui: TUI;
  private transientHint: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render distinct badges. `bashTasks` covers `bash-*` BPM tasks spawned via
   * `Shell run_in_background=true`; `agentTasks` covers `agent-*` BPM tasks
   * (background subagents). Either zero hides its respective badge.
   */
  private backgroundBashTaskCount = 0;
  /** Git badge source (shares the sidebar's cache); null = not a repo.
   * Called from `render()`, so the provider must be a cached read, never a
   * process spawn. */
  private gitDiffProvider: (() => { added: number; deleted: number } | null) | null = null;
  /** The notice to draw now (the notice board's head), read on every render. */
  private noticeProvider: (() => { text: string; color: string } | null) | null = null;
  /** True while something other than the editor owns the keys (a picker, a panel). */
  private keysTakenProvider: (() => boolean) | null = null;
  /** Balance flash animation: shimmer the badge until this timestamp. */
  private balanceFlashUntil = 0;
  private balanceFlashTimer: NodeJS.Timeout | undefined;
  private lastBalanceUpdatedAt = 0;
  private backgroundAgentCount = 0;
  /** Foreground (non-background) subagents spawned by the current turn's
   *  Agent tool. Footer renders a separate badge; 0 hides it. */
  private foregroundSubagentCount = 0;
  constructor(state: AppState, colors: ColorPalette, ui: TUI) {
    this.state = state;
    this.colors = colors;
    this.ui = ui;
    this.#restartClock(state.streamingPhase, state.goalActive);
  }

  setState(state: AppState): void {
    const previousPhase = this.state?.streamingPhase;
    const previousGoalActive = this.state?.goalActive;
    // A completed balance fetch (60s poll or model switch) flashes the
    // badge with a shimmer sweep, even when the value is unchanged; a null
    // (unsupported provider) still counts as a fetch completion. States
    // without the field (older test fixtures) never flash.
    if (
      state.balanceUpdatedAt !== undefined &&
      state.balanceUpdatedAt !== this.lastBalanceUpdatedAt
    ) {
      this.lastBalanceUpdatedAt = state.balanceUpdatedAt;
      this.startBalanceFlash();
    }
    this.state = state;
    if (state.streamingPhase !== previousPhase || state.goalActive !== previousGoalActive) {
      this.#restartClock(state.streamingPhase, state.goalActive);
    }
  }

  /** Drive the shimmer for BALANCE_FLASH_MS, then let the badge settle. */
  private startBalanceFlash(): void {
    if (!motionEnabled()) return; // decoration: no flash with motion off
    this.balanceFlashUntil = Date.now() + BALANCE_FLASH_MS;
    if (this.balanceFlashTimer !== undefined) return;
    const tick = (): void => {
      this.ui?.requestRender();
      if (Date.now() < this.balanceFlashUntil) {
        this.balanceFlashTimer = setTimeout(tick, 50);
      } else {
        this.balanceFlashTimer = undefined;
      }
    };
    tick();
  }

  setColors(colors: ColorPalette): void {
    this.colors = colors;
  }

  /**
   * Short-lived hint that takes the context gauge's place on row 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  /**
   * Sync the running-work counters with live counts. Each non-zero count
   * appears in the counter run (`后台任务 xN · 后台Agent xN · 前台Agent xN`);
   * zeros leave their part out, and with all three at zero the run is not shown.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number; foregroundSubagents: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
    this.foregroundSubagentCount = Math.max(0, counts.foregroundSubagents);
  }

  /**
   * Wire the git badge to a diff-stats provider. The provider shares the
   * sidebar's git cache, so this costs no extra git spawns; `null` means "not a
   * repo" and hides the badge.
   */
  setGitDiffProvider(provider: (() => { added: number; deleted: number } | null) | null): void {
    this.gitDiffProvider = provider;
  }

  /** Wire the notice slot to the notice board (read live on every render). */
  setNoticeProvider(provider: (() => { text: string; color: string } | null) | null): void {
    this.noticeProvider = provider;
  }

  /**
   * Wire the key hints to "does something else own the keys right now"
   * (a picker or a panel with its own hint row): the footer stays quiet then,
   * so the same keys are not printed twice.
   */
  setKeysTakenProvider(provider: (() => boolean) | null): void {
    this.keysTakenProvider = provider;
  }

  /** Provider call isolated behind a guard: a status probe must never throw
   * inside `render()` and take the whole frame down. */
  private readGitDiff(): { added: number; deleted: number } | null {
    if (this.gitDiffProvider === null) return null;
    try {
      return this.gitDiffProvider();
    } catch {
      return null;
    }
  }

  private readNotice(): { text: string; color: string } | null {
    if (this.noticeProvider === null) return null;
    try {
      return this.noticeProvider();
    } catch {
      return null;
    }
  }

  private keysTaken(): boolean {
    if (this.keysTakenProvider === null) return false;
    try {
      return this.keysTakenProvider();
    } catch {
      return false;
    }
  }

  invalidate(): void {}

  /** Stop the clock timer. Idempotent and safe during disposal. */
  dispose(): void {
    this.#stopClock();
    if (this.balanceFlashTimer !== undefined) {
      clearTimeout(this.balanceFlashTimer);
      this.balanceFlashTimer = undefined;
    }
  }

  // ── Clock ───────────────────────────────────────────────────────────

  #restartClock(phase: AppState['streamingPhase'], goalActive: boolean): void {
    this.#stopClock();
    if (phase === 'idle' && !goalActive) return;
    // Nothing on this block animates; what moves is information (the goal
    // clock, a stall, the narrow-terminal state text), so it repaints once a
    // second. setTimeout self-rescheduling chain (not setInterval): a busy
    // event loop delays the next tick instead of stacking queued renders.
    this.#scheduleClockTick(CLOCK_TICK_MS);
  }

  #scheduleClockTick(delayMs: number): void {
    const timer = setTimeout(() => {
      if (this.statusTimer !== timer) return;
      const startedAt = performance.now();
      this.ui.requestRender();
      const tickCostMs = performance.now() - startedAt;
      if (this.statusTimer !== timer) return;
      this.#scheduleClockTick(Math.max(0, CLOCK_TICK_MS - tickCostMs));
    }, delayMs);
    this.statusTimer = timer;
  }

  #stopClock(): void {
    if (!this.statusTimer) return;
    clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  render(width: number): string[] {
    const colors = this.colors;
    const state = this.state;
    const dim = chalk.hex(colors.textDim);
    const text = chalk.hex(colors.text);
    const rows = this.ui?.terminal?.rows;
    const compact = rows !== undefined && rows < COMPACT_FOOTER_ROWS;
    // The status row is not drawn on a narrow terminal; the footer then says
    // what it would have said.
    const statusRowHidden = width + 2 * CHROME_GUTTER < STATUS_ROW_MIN_WIDTH;

    // ── Row 1: measurements (model · cache · balance · git) … context gauge ──
    // Under pressure git goes first, then balance, then cache, then the gauge
    // shrinks, and the model name is cut last. An empty hint counts as no hint.
    const hint = this.transientHint === null || this.transientHint === '' ? null : this.transientHint;
    const measures: FitItem[] = [];
    const model = shortenModel(modelDisplayName(state));
    if (model) {
      const names = [model];
      const fullWidth = visibleWidth(model);
      for (const cols of MODEL_NAME_STEPS) {
        if (cols < fullWidth) names.push(truncateToWidth(model, cols, '…'));
      }
      // One shrink priority per step (see FitItem.rank): the step that lands on a
      // comfortable name is more expendable than dropping the gauge (0.05), the
      // steps below that are less.
      const rank = names
        .slice(1)
        .map((name) => (visibleWidth(name) >= MODEL_NAME_COMFORT_COLS ? 0.1 : 0.01));
      // The model name is never dropped — except while the exit hint is up, which
      // must stay readable even on a terminal too narrow for both.
      measures.push({ id: 'model', rank, keep: hint === null, variants: names.map((name) => text.bold(name)) });
    }
    // Cache hit rate = cache-read / (cache-read + cache-created + non-cached
    // input) — the full billed input, matching how providers count tokens.
    // Nothing until the session has produced input tokens. Coloured only when
    // the rate is genuinely high (90%+), and only on the number. It is one
    // variant: a bare "92%" would not say what it measures, so it goes whole.
    const usage = state.sessionUsage ?? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    const totalInput = usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther;
    if (!compact && totalInput > 0) {
      const pct = (usage.inputCacheRead / totalInput) * 100;
      const number = chalk.hex(pct >= 90 ? colors.success : colors.textDim)(`${String(Math.round(pct))}%`);
      measures.push({ id: 'cache', rank: 8, variants: [`${dim(t('footer.cache'))} ${number}`] });
    }
    const balance = state.providerBalance;
    if (!compact && balance !== null && balance !== undefined) {
      const reading = `${currencySymbol(balance.currency)}${balance.totalBalance}`;
      measures.push({
        id: 'balance',
        rank: 9,
        variants: [Date.now() < this.balanceFlashUntil ? shimmerText(reading, colors) : dim(reading)],
      });
    }
    // A clean working tree has nothing to report.
    const gitDiff = this.readGitDiff();
    if (!compact && gitDiff !== null && (gitDiff.added > 0 || gitDiff.deleted > 0)) {
      measures.push({
        id: 'git',
        rank: 10,
        variants: [
          `${dim('git')} ${chalk.hex(colors.success)(`+${gitDiff.added}`)} ${chalk.hex(colors.error)(`-${gitDiff.deleted}`)}`,
        ],
      });
    }

    // Context gauge: `ctx  ━━──────── 28%` (see formatContextStatus). The bar
    // shrinks 10 → 6 → none cells before the gauge itself is dropped; a
    // transient hint (Ctrl+C confirmation) takes its place while active.
    const gauge: FitItem =
      hint === null
        ? {
            id: 'context',
            rank: 0.2,
            dropRank: 0.05,
            variants: CONTEXT_BAR_STEPS.map((barWidth) =>
              formatContextStatus(
                state.contextUsage,
                barWidth,
                colors,
                pickContextColor(state.contextUsage, state.maxContextTokens, colors),
              ),
            ),
          }
        : { id: 'hint', rank: 0.2, keep: true, variants: [chalk.hex(colors.warning).bold(hint)] };

    // ── Row 2: controls — pills, then key hints … notice, channel ──
    // Mode pills appear only while their mode is on, in the fixed order plan →
    // rlm → wolfpack, in the mode colour and bold. They outrank everything
    // transient on the row: a mode must stay readable while a notice shrinks.
    const pills: FitItem[] = [];
    const isFusion = state.planMode === 'fusionplan';
    // The plan pill has two labels (plan / fusion); its slot is as wide as the
    // wider one so switching between them does not move what follows.
    const planSlot = Math.max(visibleWidth(t('badge.plan')), visibleWidth(t('badge.fusion')));
    const pill = (id: string, label: string, color: string, slot = 0): FitItem => ({
      id,
      rank: 2,
      variants: [chalk.hex(color).bold(label) + ' '.repeat(Math.max(0, slot - visibleWidth(label)))],
    });
    if (state.planMode !== 'off') {
      pills.push(
        pill(
          'plan',
          isFusion ? t('badge.fusion') : t('badge.plan'),
          isFusion ? colors.fusionPlanMode : colors.planMode,
          planSlot,
        ),
      );
    }
    if (state.rlmEnabled) pills.push(pill('rlm', t('badge.rlm'), colors.rlmMode));
    if (state.wolfpackMode) pills.push(pill('wolfpack', t('badge.wolfpack'), colors.wolfpackMode));

    // The goal is rarely on, so it only appears while a goal is active; it
    // shortens before it is dropped.
    if (state.goalActive && state.goal) {
      const goalStyle = chalk.hex(colors.primary).bold;
      pills.push({
        id: 'goal',
        rank: 6,
        dropRank: 3.5,
        variants: goalVariants(state.goal).map((text2) => goalStyle(text2)),
      });
    }

    // Running work: `bash-*` tasks (shell processes), `agent-*` tasks
    // (background subagents) and foreground subagents, named separately so the
    // user can tell them apart at a glance; collapsed into one total when the
    // row is short.
    const counters: string[] = [];
    if (this.backgroundBashTaskCount > 0) {
      counters.push(t('footer.tasks_running', { count: String(this.backgroundBashTaskCount) }));
    }
    if (this.backgroundAgentCount > 0) {
      counters.push(t('footer.agents_running', { count: String(this.backgroundAgentCount) }));
    }
    if (this.foregroundSubagentCount > 0) {
      counters.push(t('footer.subagents_working', { count: String(this.foregroundSubagentCount) }));
    }
    if (counters.length > 0) {
      const running = chalk.hex(colors.primary);
      const total = this.backgroundBashTaskCount + this.backgroundAgentCount + this.foregroundSubagentCount;
      pills.push({
        id: 'running',
        rank: 9.5,
        dropRank: 4,
        variants: [running(counters.join(' · ')), running(t('footer.running_total', { count: String(total) }))],
      });
    }

    // MCP says nothing while healthy. A server that failed or needs auth stays
    // here until it is resolved: the notice that announced it lasts seconds.
    const mcp = state.mcpSummary;
    if (mcp !== undefined && mcp.failed + mcp.needsAuth > 0) {
      const paint = chalk.hex(mcp.failed > 0 ? colors.error : colors.warning);
      const mark = paint(mcp.failed > 0 ? '✕' : '◆');
      pills.push({
        id: 'mcp',
        rank: 0.4,
        variants: [`${mark} ${paint(`MCP ${String(mcp.connected)}/${String(mcp.total)}`)}`, mark],
      });
    }

    // Key hints: what works now. A panel or picker that owns the keys prints
    // its own hint row, so the footer stays quiet then; while a compaction runs
    // there is nothing to press.
    const hints: FitItem[] = [];
    const quiet = state.pendingUserAction !== null || state.isCompacting || this.keysTaken();
    const idle = state.streamingPhase === 'idle';
    if (!quiet && (!compact || !idle)) {
      // Idle hints are a background reminder, not a call to act: both the key
      // and its label sit in the quiet tones, so they never compete with the
      // row's real content. The interrupt key is what the person may need now.
      const quiet2 = chalk.hex(colors.textMuted);
      const idleKey = (k: string, label: string): string => `${dim(k)} ${quiet2(label)}`;
      const list = idle
        ? [idleKey('/', t('footer.hint_commands')), idleKey('Shift+Tab', t('footer.hint_plan'))]
        : [`${text('Esc')} ${dim(t('footer.hint_interrupt'))}`];
      // Idle hints are the first thing to go (they only teach), dropping from
      // the right; the interrupt key is the one to keep.
      list.forEach((variant, i) => {
        hints.push({ id: `hint-${String(i)}`, rank: idle ? 5 : 0.5, variants: [variant] });
      });
    }

    // Right side: the work state when the status row is not drawn, the notice
    // (it shrinks and drops before any mode pill does), the channel, and jobs
    // that need the person.
    const right: FitItem[] = [];
    if (statusRowHidden) {
      const work = workState(state);
      if (work !== null) {
        const paint = work.kind === 'working' ? dim : chalk.hex(colors.warning);
        right.push({ id: 'state', rank: 0.5, keep: true, variants: work.variants.map((v) => paint(v)) });
      }
    }
    const notice = this.readNotice();
    if (notice !== null) {
      right.push({
        id: 'notice',
        rank: 5,
        dropRank: 3.2,
        variants: shrinkVariants(chalk.hex(notice.color)(notice.text), NOTICE_STEPS),
      });
    }

    // Jobs: only what needs the person now — something waiting, or jobs that
    // nothing runs. A healthy background stays out of the footer (the
    // sidebar's Jobs panel has the details). Same dot + label form as the
    // channel, in the warning colour.
    const jobsOn = state.jobsEnabled ?? 0;
    const jobsWaiting = state.jobsWaiting ?? 0;
    const jobsStopped = jobsOn > 0 && state.jobsHostRunning === false;
    if (jobsWaiting > 0 || jobsStopped) {
      const warn = chalk.hex(colors.warning);
      const label =
        jobsWaiting > 0 ? t('footer.jobs_waiting', { count: String(jobsWaiting) }) : t('footer.jobs_stopped');
      right.push({ id: 'jobs', rank: 5.5, dropRank: 1.6, variants: [`${warn('◆')} ${warn(label)}`] });
    }

    // Channel: only while the daemon runs. Only the dot carries the channel
    // colour — blue for Lark, green for WeChat; the label stays muted. It
    // shortens to `Line` before it is dropped. A configured channel that is
    // not running is a normal state (stopped on purpose), so it says nothing.
    const platform = state.linePlatform ?? null;
    if (!compact && state.lineActive && platform !== null) {
      const dot = chalk.hex(platform === 'lark' ? colors.lineLark : colors.success)('◆');
      const platformName = platform === 'lark' ? t('footer.line_lark') : t('footer.line_wechat');
      right.push({
        id: 'channel',
        rank: 5,
        dropRank: 1.5,
        variants: [
          `${dot} ${dim(t('footer.line_status', { status: platformName }))}`,
          `${dot} ${dim(t('footer.line_short'))}`,
        ],
      });
    }

    const itemGap = 3;
    if (compact) {
      // One row: model and pills on the left, notice and gauge on the right.
      return [fitRow([...measures, ...pills, ...hints], [...right, gauge], width, { itemGap })];
    }
    return [
      fitRow(measures, [gauge], width, { itemGap }),
      fitRow([...pills, ...hints], right, width, { itemGap }),
    ];
  }
}
