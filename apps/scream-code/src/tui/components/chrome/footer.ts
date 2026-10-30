/**
 * Footer/status bar — fixed two-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1 (identity strip): `📟️ <model>` · `<balance>` · `📁 工作区Git +N-M`
 *           … right-aligned: `<line-dot> Line: <Lark|Wechat|未连接> ↓ Hitr: xx%
 *           <work status>`
 *   Line 2 (run strip): `🗒️ 计划/融合计划` · `🪐 RLM` · `🐺 群狼` · `GOAL …` ·
 *           task badges … right-aligned: `🗑️ 上下文:tokens/max bar`
 *           When a transient hint owns line 1's right half, line 2 keeps its
 *           context readout.
 *
 * Both rows are always rendered, so the dock must reserve two rows for the
 * footer (see LifecycleController.buildLayout) — a one-row slot would clip the
 * context readout away. Every row is width-safe: emoji are counted by
 * `visibleWidth` and each line is finally clamped with `truncateToWidth`.
 */

import type { Component, TUI } from '@liutod-scream/pi-tui';
import { sliceByColumn, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, GoalBadgeInfo } from '#/tui/types';
import { GRADIENT_CYCLE_MS, lerpGradient } from '#/tui/utils/gradient';
import { shimmerText, shimmerTextWithPalette } from '#/tui/utils/shimmer';
import { safeUsageRatio } from '#/utils/usage/usage-format';

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " | ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
//
// This is deliberately code-level configuration: edit the interval and the
// TOOLBAR_TIPS array below to change what the footer advertises.
export const TIP_ROTATE_INTERVAL_MS = 10_000;
export const TIP_SEPARATOR = ' | ';

export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

export function getToolbarTips(): readonly ToolbarTip[] {
  return [
    { text: t('footer.shift_tab') },
    { text: t('footer.model') },
    { text: t('footer.ctrl_s'), priority: 2 },
    { text: t('footer.compact'), priority: 2 },
    { text: t('footer.ctrl_o') },
    { text: t('footer.tasks') },
    { text: t('footer.shift_enter') },
    { text: t('footer.init'), priority: 2 },
    { text: t('footer.at') },
    { text: t('footer.ctrl_c') },
    { text: t('footer.skill'), priority: 2 },
    { text: t('footer.help') },
    { text: t('footer.config'), solo: true, priority: 3 },
    { text: t('footer.reminder'), solo: true, priority: 3 },
  ];
}

/**
 * Expand tips into a rotation sequence using smooth weighted round-robin
 * (the nginx SWRR algorithm). Higher-`priority` tips appear more often while
 * staying evenly spread, so a tip generally does not land next to its own
 * duplicate. Deterministic and computed once at module load. Exported for
 * unit testing.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): readonly ToolbarTip[] {
  const items = tips.map((t) => ({
    tip: t,
    weight: Math.max(1, Math.trunc(t.priority ?? 1)),
    current: 0,
  }));
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  const seq: ToolbarTip[] = [];
  for (let n = 0; n < total; n++) {
    let best = items[0]!;
    for (const it of items) {
      it.current += it.weight;
      if (it.current > best.current) best = it;
    }
    best.current -= total;
    seq.push(best.tip);
  }
  return seq;
}

let _rotation: readonly ToolbarTip[] | null = null;
function getRotation(): readonly ToolbarTip[] {
  if (_rotation === null) _rotation = buildWeightedTips(getToolbarTips());
  return _rotation;
}

/** Invalidate cached rotation (call after locale change). */
export function invalidateRotation(): void { _rotation = null; }

export function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

/**
 * Pick the tip(s) for a rotation index over the weighted ROTATION sequence.
 * `primary` is always shown when it fits; `pair` (primary + next tip joined
 * by the separator) is offered for wide terminals. Pairing is skipped when
 * the current/next tip is `solo` or when the neighbour is a duplicate of the
 * current tip (which can happen at the wrap boundary), keeping long/important
 * tips on their own and avoiding "X | X".
 */
export function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const rotation = getRotation();
  const n = rotation.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = rotation[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = rotation[(offset + 1) % n]!;
  if (next.solo || next.text === current.text) return { primary: current.text, pair: null };
  return { primary: current.text, pair: current.text + TIP_SEPARATOR + next.text };
}

function shortenModel(model: string): string {
  if (!model) return model;
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  return model?.displayName ?? model?.model ?? state.model;
}

function safeUsage(usage: number): number {
  return safeUsageRatio(usage);
}

const CONTEXT_BAR_WIDTH = 10;
// Water-level progress bar glyphs: solid depth (█) with a foam transition
// (▓▒) hugging the water line; unused cells read as air (░).
const CONTEXT_BAR_DEEP = '█';
const CONTEXT_BAR_FOAM = '▓▒';
const CONTEXT_BAR_AIR = '░';
const BALANCE_FLASH_MS = 1500;

function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `; // unknown currency: show the code as its own label
}

/**
 * Water-level progress bar for context usage: `█████▓▒░░░` (10 cells).
 * Used cells read as water — solid depth (█) with a foam transition (▓▒)
 * hugging the water line; unused cells read as air (░). Cell count is
 * rounded from the clamped ratio, so 0% is all-air and >=100% is all-water;
 * NaN/undefined coerce through safeUsageRatio first.
 */
function formatContextBar(usage: number, width: number = CONTEXT_BAR_WIDTH): string {
  const clamped = Math.min(1, Math.max(0, safeUsageRatio(usage)));
  const filled = Math.round(clamped * width);
  const foam = Math.min(2, filled);
  const deep = Math.max(0, filled - foam);
  const used = CONTEXT_BAR_DEEP.repeat(deep) + CONTEXT_BAR_FOAM.slice(0, foam);
  const air = CONTEXT_BAR_AIR.repeat(width - filled);
  return `${used}${air}`;
}

function formatContextStatus(usage: number, barWidth = CONTEXT_BAR_WIDTH): string {
  // `上下文🗑️：5.5% ▓░░░░░░░░░` — the percentage is the metric, the bar is its
  // gauge. Absolute token counts were dropped: they made the row read like a
  // ledger and duplicated what `/status` already reports.
  // `barWidth` 0 collapses the bar on narrow terminals, which needs its own
  // template so no trailing space is left where the bar used to sit.
  const clamped = Number.isFinite(usage) ? Math.min(1, Math.max(0, usage)) : 0;
  const percent = `${(clamped * 100).toFixed(1)}%`;
  if (barWidth <= 0) return t('footer.context_plain', { percent });
  return t('footer.context', { percent, bar: formatContextBar(usage, barWidth) });
}

/** Format goal wall-clock duration compactly: `3m`, `1m30s`, `45s`. */
function formatGoalDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/** Build the footer goal badge: `GOAL 3m · 7 turns`.
 *
 * The TUI only receives `goal.updated` events on state changes, so we keep a
 * local base timestamp and add the elapsed time since the last snapshot to
 * produce a live wall-clock reading between sparse events.
 */
function formatGoalBadge(goal: GoalBadgeInfo): string {
  const elapsedSinceSnapshot = Date.now() - goal.wallClockBaseAt;
  const liveWallClockMs = goal.wallClockMs + Math.max(0, elapsedSinceSnapshot);
  return `GOAL ${formatGoalDuration(liveWallClockMs)} · ${goal.turnsUsed} turns`;
}

// Context-usage threshold coloring. Pure percent — works uniformly across
// all model context windows (256k / 1M / etc.) without hardcoding absolute
// token counts that misfire when the window size differs from the assumed
// baseline.
const CONTEXT_WARNING_PERCENT_THRESHOLD = 60;
const CONTEXT_ERROR_PERCENT_THRESHOLD = 90;

function pickContextColor(usage: number, colors: ColorPalette): string {
  const percent = safeUsage(usage) * 100;
  if (percent >= CONTEXT_ERROR_PERCENT_THRESHOLD) return colors.error;
  if (percent >= CONTEXT_WARNING_PERCENT_THRESHOLD) return colors.warning;
  return colors.textDim;
}

// ── Gradient status line for footer line 2 ───────────────────────────
// Shared with the sidebar agent slots (see utils/gradient.ts).

const SPINNER_FRAMES = ['●', '◉', '◎', '◌', '○', '◌', '◎', '◉'];
const SPINNER_TICK_MS = 60;

/**
 * Elapsed suffix for human-blocked states ("等待批准 · 4m"), shown only after a
 * minute: below that a clock reads as noise, while a long silent stall must be
 * visible — the previous behaviour showed nothing ever, which made a stalled
 * approval look like normal work. Units (m/h) are language-neutral symbols, so
 * the suffix is not routed through i18n.
 */
function waitingStallSuffix(since: number | null | undefined): string {
  if (since === null || since === undefined) return '';
  const seconds = Math.floor((Date.now() - since) / 1000);
  if (seconds < 60) return '';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ` · ${String(minutes)}m`;
  return ` · ${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}

function buildStatusLine(
  streamingPhase: AppState['streamingPhase'],
  streamingStartTime: number,
  statusFlags: {
    readonly isCompacting: boolean;
    readonly pendingUserAction: AppState['pendingUserAction'];
    readonly pendingUserActionSince?: AppState['pendingUserActionSince'];
    readonly reconnectAttempt: number;
    readonly reconnectMaxAttempts: number | undefined;
  },
): string {
  // States where nothing is actually progressing on the model side. They
  // outrank the phase table below because the phase alone cannot express them:
  // a compaction runs as `waiting`, a retry keeps the last phase of the failed
  // attempt, and an approval/question panel blocks the turn without any event.
  // The phase timer is wrong for all of them; a panel that has waited long
  // enough gets its own "how long" suffix instead (waitingStallSuffix).
  if (statusFlags.pendingUserAction === 'approval') {
    return t('status.awaiting_approval') + waitingStallSuffix(statusFlags.pendingUserActionSince);
  }
  if (statusFlags.pendingUserAction === 'question') {
    return t('status.awaiting_answer') + waitingStallSuffix(statusFlags.pendingUserActionSince);
  }
  if (statusFlags.isCompacting) return t('status.compacting');
  if (streamingPhase === 'idle') {
    return t('status.idle');
  }
  if (statusFlags.reconnectAttempt > 0) {
    return t('status.reconnecting_short', {
      attempt: String(statusFlags.reconnectAttempt),
      max: String(statusFlags.reconnectMaxAttempts ?? 0),
    });
  }

  // Retry detail ("reconnecting N/M · reason · retry in Xs") is rendered in
  // the status bar above the editor, not in the footer.

  let label: string;
  if (streamingPhase === 'tool') {
    label = t('status.tool');
  } else if (streamingPhase === 'tool-args') {
    label = t('status.calling_tool');
  } else if (streamingPhase === 'waiting') {
    label = t('status.waiting');
  } else if (streamingPhase === 'thinking') {
    label = t('status.thinking');
  } else if (streamingPhase === 'composing') {
    label = t('status.composing');
  } else {
    label = '';
  }

  const elapsed = Date.now() - streamingStartTime;
  const totalSeconds = Math.floor(elapsed / 1000);
  const elapsedStr = totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;

  const now = Date.now();
  const tick = Math.floor(now / SPINNER_TICK_MS);
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  const gradientColor = lerpGradient((now % GRADIENT_CYCLE_MS) / GRADIENT_CYCLE_MS);

  // Only the spinner dot uses a brand gradient colour; the rest inherits
  // the line's outer colour so it stays consistent with the context text.
  return chalk.hex(gradientColor).bold(frame) + ' ' + label + ' ' + elapsedStr;
}

/**
 * Middle-truncate a (possibly ANSI-colored) string to `maxWidth` visible
 * columns, keeping a head and a tail fragment joined by `ellipsis`. The
 * remaining budget is split roughly in half so both the start and the end of
 * the original content stay visible - e.g. `GOAL 3m · 7 turns` becomes
 * `GOAL… turns` (head `GOAL`, tail `turns`). ANSI styling is preserved via
 * sliceByColumn, which carries the active SGR state into the tail; a reset is
 * emitted around the ellipsis so a colour opened in the head never bleeds
 * across it. Exported for unit testing.
 */
export function truncateMiddle(line: string, maxWidth: number, ellipsis: string): string {
  if (maxWidth <= 0) return '';
  const textWidth = visibleWidth(line);
  if (textWidth <= maxWidth) return line;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) {
    // Ellipsis alone fills the budget: fall back to a head-only truncation.
    return truncateToWidth(line, maxWidth, ellipsis);
  }
  const keepWidth = maxWidth - ellipsisWidth;
  const headWidth = Math.max(0, Math.ceil(keepWidth / 2));
  const tailWidth = keepWidth - headWidth;
  const head = headWidth > 0 ? sliceByColumn(line, 0, headWidth) : '';
  const tail = tailWidth > 0 ? sliceByColumn(line, textWidth - tailWidth, tailWidth) : '';
  // Reset around the ellipsis: the head may have opened a colour that is not
  // closed at the cut, and the tail re-applies its own SGR state via
  // sliceByColumn's pendingAnsi carry-over, so the resets isolate the ellipsis
  // without corrupting either side.
  const RESET = '\u001B[0m';
  return head + RESET + ellipsis + RESET + tail;
}

export class FooterComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private readonly ui: TUI;
  private transientHint: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  /** Line-1 git badge source (shares the sidebar's cache); null = not a repo.
   * Called from `render()`, so the provider must be a cached read, never a
   * process spawn. */
  private gitDiffProvider: (() => { added: number; deleted: number } | null) | null = null;
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
    this.#restartStatusTimer(state.streamingPhase, state.goalActive);
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
      this.#restartStatusTimer(state.streamingPhase, state.goalActive);
    }
  }

  /** Drive the shimmer for BALANCE_FLASH_MS, then let the badge settle. */
  private startBalanceFlash(): void {
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
   * Short-lived hint that replaces the rotating toolbar tips on line 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  /**
   * Sync both background-task badges with live counts. Each non-zero
   * count produces its own bracketed badge on line 1; zeros hide them
   * independently.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number; foregroundSubagents: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
    this.foregroundSubagentCount = Math.max(0, counts.foregroundSubagents);
  }

  /**
   * Wire the line-2 git badge to a diff-stats provider. The provider shares the
   * sidebar's git cache, so this costs no extra git spawns; `null` means "not a
   * repo" and hides the badge.
   */
  setGitDiffProvider(provider: (() => { added: number; deleted: number } | null) | null): void {
    this.gitDiffProvider = provider;
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

  invalidate(): void {}

  /** Stop the active-status timer. Idempotent and safe during disposal. */
  dispose(): void {
    this.#stopStatusTimer();
    if (this.balanceFlashTimer !== undefined) {
      clearTimeout(this.balanceFlashTimer);
      this.balanceFlashTimer = undefined;
    }
  }

  // ── Active status animation ─────────────────────────────────────────

  #restartStatusTimer(
    phase: AppState['streamingPhase'],
    goalActive: boolean,
  ): void {
    this.#stopStatusTimer();
    if (phase === 'idle' && !goalActive) return;
    // 30fps: the 30 cells/s shimmer band advances exactly one cell per frame
    // (the smoothest setting), and halves the render pressure vs 60fps so
    // streaming/tool work gets serviced faster — the glow keeps flowing even
    // while the event loop is busy with real work.
    const intervalMs = 1000 / 30;
    // setTimeout self-rescheduling chain (not setInterval): a busy event loop
    // delays the next tick instead of stacking queued requestRender() calls.
    this.#scheduleStatusTick(intervalMs, intervalMs);
  }

  #scheduleStatusTick(intervalMs: number, delayMs: number): void {
    const timer = setTimeout(() => {
      if (this.statusTimer !== timer) return;
      const startedAt = performance.now();
      this.ui.requestRender();
      const tickCostMs = performance.now() - startedAt;
      if (this.statusTimer !== timer) return;
      this.#scheduleStatusTick(intervalMs, Math.max(0, intervalMs - tickCostMs));
    }, delayMs);
    this.statusTimer = timer;
  }

  #stopStatusTimer(): void {
    if (!this.statusTimer) return;
    clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  render(width: number): string[] {
    const colors = this.colors;
    const state = this.state;

    // ── Line 1 left: model + balance + git summary ───────────────────────
    // The model name leads the row (`📟️` + name), the balance hugs it and the
    // git working-tree summary closes the run. Mode badges (wolfpack / rlm /
    // plan) open line 2 instead, so line 1 stays a quiet identity strip.
    // Permission mode is NOT rendered here — it lives in the editor's top
    // border (CustomEditor permissionMode badge), next to the input it
    // governs.
    const left: string[] = [];
    const model = shortenModel(modelDisplayName(state));
    if (model) {
      // The pager emoji marks the model segment; it is a 2-cell glyph, so the
      // width math below stays accurate (visibleWidth counts it as 2).
      if (state.streamingPhase === 'thinking' || state.streamingPhase === 'waiting' || state.streamingPhase === 'composing' || state.streamingPhase === 'tool-args') {
        // Reasoning/latency/call-authoring states keep the default green shimmer.
        left.push(`📟️ ${shimmerText(model, colors)}`);
      } else if (state.streamingPhase === 'tool') {
        // A tool is executing: switch the glow to cyan so the user can tell
        // "working on it" from "running a tool" at a glance. Same grey→tint
        // structure as the thinking glow — only the peak color changes.
        left.push(
          `📟️ ${shimmerTextWithPalette(model, {
            low: colors.textDim,
            mid: colors.textMuted,
            high: colors.planMode,
          })}`,
        );
      } else {
        left.push(`📟️ ${chalk.hex(colors.textDim)(model)}`);
      }
      // The balance hugs the model name — both describe the account the model
      // bills to, so they read as one block.
      const balance = state.providerBalance;
      if (balance !== null && balance !== undefined) {
        const text = `${currencySymbol(balance.currency)}${balance.totalBalance}`;
        if (Date.now() < this.balanceFlashUntil) {
          left.push(shimmerText(text, colors));
        } else {
          left.push(chalk.hex(colors.textDim)(text));
        }
      }
    }
    // The git working-tree summary closes line 1's run (`📁 工作区Git +N-M`).
    // It is independent of the model (it describes the working dir) and hidden
    // outside a repo, where there is nothing to report.
    const gitDiff = this.readGitDiff();
    if (gitDiff !== null) {
      left.push(
        `${chalk.hex(colors.textDim)(t('footer.git_label'))} ${chalk.hex(colors.success)(`+${gitDiff.added}`)}${chalk.hex(colors.error)(`-${gitDiff.deleted}`)}`,
      );
    }

    // ── Line 2 left: mode badges + goal + background tasks ───────────────
    // Run-state readouts start line 2 from the left edge and leave the right
    // half to the context readout. Mode badges open the row so line 1 stays a
    // quiet identity strip (model · balance · git).
    // ── Cache hit rate: fixed first item of line 2 ───────────────────────
    // Session token usage accumulated from turn.step.completed. Cache hit rate
    // = cache-read / (cache-read + cache-created + non-cached input) — the full
    // billed input, matching how providers count tokens. `--` until the session
    // has produced input tokens (a "0%" would be misleading). Colour only when
    // the rate is genuinely high (90%+), and only on the number.
    const sessionUsage = state.sessionUsage ?? {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    const totalInput =
      sessionUsage.inputCacheRead + sessionUsage.inputCacheCreation + sessionUsage.inputOther;
    const hitRatePct = totalInput > 0 ? (sessionUsage.inputCacheRead / totalInput) * 100 : undefined;
    const hitColor = hitRatePct !== undefined && hitRatePct >= 90 ? colors.success : colors.textDim;
    const segHit =
      chalk.hex(colors.textDim)(`↓ ${t('footer.hit')}:`) +
      ' ' +
      chalk.hex(hitColor)(hitRatePct === undefined ? '--' : `${hitRatePct.toFixed(2)}%`);

    // ── Line 2 left: hit rate, mode badges, goal, background tasks ───────
    // Run-state readouts start line 2 from the left edge and leave the right
    // half to the context readout. The hit rate is pinned first (it is always
    // present), then plan → rlm → wolfpack — the left-to-right reading order
    // the user expects for the mode strip.
    const leftSecond: string[] = [segHit];
    if (state.planMode !== 'off') {
      const isFusion = state.planMode === 'fusionplan';
      // Emoji marks: memo (plan), ringed planet (rlm), wolf (wolfpack). The
      // memo carries VS16 so it renders as a 2-cell emoji like the others.
      leftSecond.push(
        chalk
          .hex(isFusion ? colors.fusionPlanMode : colors.planMode)
          .bold(`🗒️ ${isFusion ? t('badge.fusion') : t('badge.plan')}`),
      );
    }
    if (state.rlmEnabled) leftSecond.push(chalk.hex(colors.rlmMode).bold(`🪐 ${t('badge.rlm')}`));
    if (state.wolfpackMode) leftSecond.push(chalk.hex(colors.wolfpackMode).bold(`🐺 ${t('badge.wolfpack')}`));
    if (state.goalActive && state.goal) {
      const goalLabel = formatGoalBadge(state.goal);
      leftSecond.push(chalk.hex(colors.primary).bold(goalLabel));
    }
    // `bash-*` tasks (shell processes) and `agent-*` tasks (background
    // subagents) get separate badges so the user can distinguish them at a
    // glance.
    if (this.backgroundBashTaskCount > 0) {
      leftSecond.push(
        chalk.hex(colors.primary)(`[${t('footer.tasks_running', { count: String(this.backgroundBashTaskCount) })}]`),
      );
    }
    if (this.backgroundAgentCount > 0) {
      leftSecond.push(
        chalk.hex(colors.primary)(`[${t('footer.agents_running', { count: String(this.backgroundAgentCount) })}]`),
      );
    }
    if (this.foregroundSubagentCount > 0) {
      leftSecond.push(
        chalk.hex(colors.primary)(`[${t('footer.subagents_working', { count: String(this.foregroundSubagentCount) })}]`),
      );
    }

    const leftLine = left.join('  ');
    const leftSecondLine = leftSecond.join('  ');

    // Git working-tree summary now closes line 1 (the sidebar Git panel keeps
    // the detailed file list).

    // ── Line 1 right side: transient hint (when active) or status info ─────
    let rightText: string;
    if (this.transientHint) {
      rightText = chalk.hex(colors.warning).bold(this.transientHint);
    } else {
      const statusLine = buildStatusLine(
        state.streamingPhase,
        state.streamingStartTime,
        {
          isCompacting: state.isCompacting === true,
          pendingUserAction: state.pendingUserAction ?? null,
          pendingUserActionSince: state.pendingUserActionSince ?? null,
          reconnectAttempt: state.reconnectAttempt ?? 0,
          reconnectMaxAttempts: state.reconnectMaxAttempts,
        },
      );
      const platform = state.linePlatform ?? null;
      const lineConnected = state.lineActive && platform !== null;
      // Only the dot carries the channel colour — blue for Lark, green for
      // WeChat, muted when not connected. The label stays muted so the status
      // segment never glows as a whole.
      const dotColor = !lineConnected
        ? colors.textDim
        : platform === 'lark'
          ? colors.lineLark
          : colors.success;
      const lineDot = chalk.hex(dotColor)('◆');
      // `Line：` + the channel brand while it runs, `未连接` otherwise — the
      // brand alone reads as a stray word without the label.
      const lineLabel = chalk.hex(colors.textDim)(
        t('footer.line_status', {
          status: lineConnected ? (platform === 'lark' ? 'Lark' : 'Wechat') : t('footer.line_disconnected'),
        }),
      );
      const statusPart = chalk.hex(colors.textDim)(statusLine);
      rightText = `${lineDot} ${lineLabel} ${statusPart}`;
    }

    const ellipsis = chalk.hex(colors.textDim)('…');

    // ── Line 2: run-state badges (left) + context usage (right) ──────────
    // The water-level bar collapses on narrow terminals (10 cells on wide,
    // 6 mid, 0 = plain token counts) so the readout itself never disappears:
    // the second row is rendered at every width.
    const contextBarWidth = width >= 68 ? CONTEXT_BAR_WIDTH : width >= 52 ? 6 : 0;
    // The trash mark lives in the label (`上下文🗑️：…`, i18n-side) so it reads
    // as part of the metric rather than trailing decoration.
    const contextLine = chalk.hex(pickContextColor(state.contextUsage, colors))(
      formatContextStatus(state.contextUsage, contextBarWidth),
    );

    return [
      truncateToWidth(this.composeLine(leftLine, rightText, width, ellipsis), width, '…'),
      truncateToWidth(
        this.composeLine(leftSecondLine, contextLine, width, ellipsis, 'right'),
        width,
        '…',
      ),
    ];
  }

  /**
   * Compose a single footer row from a LEFT block and a RIGHT block.
   *
   * Three-stage progressive truncation keeps the row on one terminal line:
   *   1. Shrink LEFT with a middle ellipsis (head + tail kept) until
   *      LEFT + gap + RIGHT fits, so RIGHT stays visible.
   *   2. If RIGHT still cannot fit after shrinking LEFT (its width plus the
   *      gap already exceeds the line), drop RIGHT and show LEFT alone,
   *      padded to the full width.
   *   3. If LEFT alone exceeds the width, truncate LEFT to the width.
   *
   * `priority: 'right'` (line 2) inverts stage 2: the context readout is the
   * row's reason to exist, so LEFT is clipped to whatever space remains and
   * the readout is only truncated once LEFT is gone.
   *
   * A row with no LEFT is right-aligned and never drops RIGHT, clipping the
   * RIGHT tail when the row is too short instead.
   */
  private composeLine(
    leftText: string,
    rightText: string,
    width: number,
    ellipsis: string,
    priority: 'left' | 'right' = 'left',
  ): string {
    const leftWidth = visibleWidth(leftText);
    const rightWidth = visibleWidth(rightText);
    const gap = 3;
    if (leftWidth === 0) return rightAligned(rightText, width, ellipsis);
    if (leftWidth + gap + rightWidth <= width) {
      const pad = width - leftWidth - rightWidth;
      return leftText + ' '.repeat(pad) + rightText;
    }
    const targetLeft = width - gap - rightWidth;
    if (priority === 'right') {
      if (targetLeft <= 0) return rightAligned(rightText, width, ellipsis);
      const shrunkLeft = truncateMiddle(leftText, targetLeft, ellipsis);
      const pad = Math.max(0, width - visibleWidth(shrunkLeft) - rightWidth);
      return shrunkLeft + ' '.repeat(pad) + rightText;
    }
    if (targetLeft > 0) {
      const shrunkLeft = truncateMiddle(leftText, targetLeft, ellipsis);
      const pad = width - visibleWidth(shrunkLeft) - rightWidth;
      return shrunkLeft + ' '.repeat(pad) + rightText;
    }
    if (leftWidth <= width) {
      return leftText + ' '.repeat(width - leftWidth);
    }
    return truncateMiddle(leftText, width, ellipsis);
  }
}

/** Pad a RIGHT-only row to the full width, trimming its tail when too long. */
function rightAligned(text: string, width: number, ellipsis: string): string {
  const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, ellipsis);
  return ' '.repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}
