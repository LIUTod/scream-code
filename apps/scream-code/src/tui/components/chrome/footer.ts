/**
 * Footer — fixed two-line status block at the bottom of the TUI (distinct from
 * the single-line status bar above the editor).
 *
 * Layout:
 *   Line 1 (identity strip): `📟️ <model>` · `<balance>` · `📁 Git +N-M`
 *           … right-aligned context gauge `📨 Context  <bar> <percent>`
 *           (a transient hint takes that right side while active)
 *   Line 2 (run strip): `↓ 缓存命中: xx%` · `计划/融合` · `RLM` · `群狼`
 *           (each only while that mode is on, mode-coloured and bold)
 *           · `目标 …` (only while a goal is active)
 *           · `后台任务 xN · 后台Agent xN · 前台Agent xN`
 *           … right-aligned `◆ Line: <飞书|微信|未连接>` and the work status
 *
 * Both rows are always rendered, so the dock reserves two rows for the footer
 * (see LifecycleController.buildLayout) — a one-row slot would clip line 2.
 * Each row is fitted item by item (utils/fit-row): when the terminal is too
 * narrow an item first shrinks to a shorter variant and is then dropped whole,
 * lowest priority first. Nothing is ever cut in the middle.
 */

import type { Component, TUI } from '@liutod-scream/pi-tui';
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, GoalBadgeInfo } from '#/tui/types';
import { GRADIENT_CYCLE_MS, lerpGradient } from '#/tui/utils/gradient';
import { contextLevel } from '#/tui/utils/context-level';
import { type FitItem, fitRow } from '#/tui/utils/fit-row';
import { motionEnabled } from '#/tui/utils/motion';
import { shimmerText, shimmerTextWithPalette } from '#/tui/utils/shimmer';
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

function safeUsage(usage: number): number {
  return safeUsageRatio(usage);
}

const CONTEXT_BAR_WIDTH = 10;
// A thin gauge: heavy rule for the used share, light rule for the rest — one
// continuous line, lighter on the row than a chain of blocks (both 1 column).
const CONTEXT_BAR_FILLED = '━';
const CONTEXT_BAR_EMPTY = '─';
const BALANCE_FLASH_MS = 1500;

function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `; // unknown currency: show the code as its own label
}

/**
 * Context gauge: `📨 Context  ━━━─────── 28%`.
 *
 * The label is dim; the used share and the percentage carry the usage colour
 * (plain text while usage is low, then warning, then error), and the unused
 * share is a dim track — so the reading, not the label, is what stands out.
 * The fill is floored so the gauge never overstates usage, but any non-zero
 * usage keeps one cell lit (an empty gauge next to "<1%" reads as a bug);
 * the percentage is floored too, `<1%` below one percent. `barWidth` 0 drops
 * the gauge on narrow rows and keeps label and percentage.
 */
function formatContextStatus(
  usage: number,
  barWidth: number,
  colors: ColorPalette,
  usageColor: string,
): string {
  const clamped = Math.min(1, Math.max(0, safeUsageRatio(usage)));
  const percent = clamped > 0 && clamped < 0.01 ? '<1%' : `${String(Math.floor(clamped * 100))}%`;
  const label = chalk.hex(colors.textDim)(t('footer.context_label'));
  const reading = chalk.hex(usageColor)(percent);
  if (barWidth <= 0) return `${label}  ${reading}`;
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
  const level = contextLevel(safeUsage(usage), maxTokens);
  if (level === 'error') return colors.error;
  if (level === 'warning') return colors.warning;
  // Plain text, not dim: the used share must stand out from the dim track.
  return colors.text;
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

/**
 * Work-status readout, longest first. Only the running states have a second,
 * shorter variant (without the elapsed clock); everything else is one fixed
 * string.
 */
function buildStatusLine(
  streamingPhase: AppState['streamingPhase'],
  streamingStartTime: number,
  statusFlags: {
    readonly isCompacting: boolean;
    readonly pendingUserAction: AppState['pendingUserAction'];
    readonly pendingUserActionSince?: AppState['pendingUserActionSince'];
    readonly reconnectAttempt: number;
    readonly reconnectMaxAttempts: number | undefined;
    readonly reconnectUntil?: number | undefined;
  },
): string[] {
  // States where nothing is actually progressing on the model side. They
  // outrank the phase table below because the phase alone cannot express them:
  // a compaction runs as `waiting`, a retry keeps the last phase of the failed
  // attempt, and an approval/question panel blocks the turn without any event.
  // The phase timer is wrong for all of them; a panel that has waited long
  // enough gets its own "how long" suffix instead (waitingStallSuffix).
  if (statusFlags.pendingUserAction === 'approval') {
    return [t('status.awaiting_approval') + waitingStallSuffix(statusFlags.pendingUserActionSince)];
  }
  if (statusFlags.pendingUserAction === 'question') {
    return [t('status.awaiting_answer') + waitingStallSuffix(statusFlags.pendingUserActionSince)];
  }
  if (statusFlags.isCompacting) return [t('status.compacting')];
  if (streamingPhase === 'idle') {
    return [t('status.idle')];
  }
  if (statusFlags.reconnectAttempt > 0 && statusFlags.reconnectUntil !== undefined) {
    return [t('status.outage_short')];
  }
  if (statusFlags.reconnectAttempt > 0) {
    return [
      t('status.reconnecting_short', {
        attempt: String(statusFlags.reconnectAttempt),
        max: String(statusFlags.reconnectMaxAttempts ?? 0),
      }),
    ];
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
  // Motion off: a steady dot in the gradient's first colour instead of a spinner
  // (the line is only repainted once a second then, which would read as flicker).
  const animated = motionEnabled();
  const tick = animated ? Math.floor(now / SPINNER_TICK_MS) : 0;
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  const gradientColor = lerpGradient(animated ? (now % GRADIENT_CYCLE_MS) / GRADIENT_CYCLE_MS : 0);

  // Only the spinner dot uses a brand gradient colour; the rest inherits
  // the line's outer colour so it stays consistent with the context text.
  const head = chalk.hex(gradientColor).bold(frame) + ' ' + label;
  return [head + ' ' + elapsedStr, head];
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

/**
 * The `📟️ <model>` segment in every width it may take. The glow follows the
 * phase: green while the model works, cyan while a tool executes, plain gray
 * when idle.
 */
function modelVariants(
  model: string,
  state: AppState,
  colors: ColorPalette,
): { variants: string[]; rank: number[] } {
  const phase = state.streamingPhase;
  const animated = motionEnabled();
  const style = (name: string): string => {
    if (phase === 'thinking' || phase === 'waiting' || phase === 'composing' || phase === 'tool-args') {
      // Reasoning/latency/call-authoring states keep the default green shimmer
      // (a steady green with motion off).
      return animated ? shimmerText(name, colors) : chalk.hex(colors.primary)(name);
    }
    if (phase === 'tool') {
      if (!animated) return chalk.hex(colors.planMode)(name);
      // A tool is executing: switch the glow to cyan so the user can tell
      // "working on it" from "running a tool" at a glance. Same grey→tint
      // structure as the thinking glow — only the peak color changes.
      return shimmerTextWithPalette(name, {
        low: colors.textDim,
        mid: colors.textMuted,
        high: colors.planMode,
      });
    }
    return chalk.hex(colors.textDim)(name);
  };
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
  // The pager emoji marks the model segment; it is a 2-cell glyph, so the
  // width math stays accurate (visibleWidth counts it as 2).
  return { variants: names.map((name) => `📟️ ${style(name)}`), rank };
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
   * Short-lived hint that replaces the rotating toolbar tips on line 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  /**
   * Sync the running-work counters with live counts. Each non-zero count
   * appears in the line-2 counter run (`后台任务 xN · 后台Agent xN · 前台Agent
   * xN`); zeros leave their part out, and with all three at zero the run is
   * not shown at all.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number; foregroundSubagents: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
    this.foregroundSubagentCount = Math.max(0, counts.foregroundSubagents);
  }

  /**
   * Wire the line-1 git badge to a diff-stats provider. The provider shares the
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
    // while the event loop is busy with real work. With motion off nothing glows
    // or spins, but the elapsed and goal clocks are information, not decoration:
    // they still need a repaint, once a second.
    const intervalMs = motionEnabled() ? 1000 / 30 : 1000;
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
    const dim = chalk.hex(colors.textDim);

    // ── Line 1: identity strip (model · balance · git) … context gauge ───
    // The balance hugs the model name — both describe the account the model
    // bills to, so they read as one block. The git working-tree summary is
    // independent of the model (it describes the working dir) and hidden
    // outside a repo. Permission mode is NOT rendered here — it lives in the
    // editor's top border (CustomEditor permissionMode badge), next to the
    // input it governs. Under pressure the git summary goes first, then the
    // balance, then the gauge shrinks, and the model name is cut last.
    // An empty hint counts as no hint, for the model and the gauge alike.
    const hint = this.transientHint === null || this.transientHint === '' ? null : this.transientHint;
    const identity: FitItem[] = [];
    const model = shortenModel(modelDisplayName(state));
    if (model) {
      const shown = modelVariants(model, state, colors);
      // The model name is never dropped — except while the exit hint is up, which
      // must stay readable even on a terminal too narrow for both.
      identity.push({ id: 'model', rank: shown.rank, keep: hint === null, variants: shown.variants });
      const balance = state.providerBalance;
      if (balance !== null && balance !== undefined) {
        const text = `${currencySymbol(balance.currency)}${balance.totalBalance}`;
        identity.push({
          id: 'balance',
          rank: 9,
          variants: [Date.now() < this.balanceFlashUntil ? shimmerText(text, colors) : dim(text)],
        });
      }
    }
    const gitDiff = this.readGitDiff();
    if (gitDiff !== null) {
      identity.push({
        id: 'git',
        rank: 10,
        variants: [
          `${dim(t('footer.git_label'))} ${chalk.hex(colors.success)(`+${gitDiff.added}`)}${chalk.hex(colors.error)(`-${gitDiff.deleted}`)}`,
        ],
      });
    }

    // Context gauge: `📨 Context  ━━━─────── 28%` (see formatContextStatus).
    // The bar shrinks 10 → 6 → none cells before the gauge itself is dropped;
    // a transient hint (Ctrl+C confirmation) takes its place while active.
    // Both are the last droppable thing on the row.
    const gauge: FitItem = hint !== null
      ? {
          id: 'hint',
          rank: 0.2,
          keep: true,
          variants: [chalk.hex(colors.warning).bold(hint)],
        }
      : {
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
        };

    // ── Line 2: run strip … channel · work status ────────────────────────
    // Cache hit rate = cache-read / (cache-read + cache-created + non-cached
    // input) — the full billed input, matching how providers count tokens.
    // `--` until the session has produced input tokens (a "0%" would be
    // misleading). Colour only when the rate is genuinely high (90%+), and
    // only on the number. The label shortens first (`缓存命中:` → `缓存` →
    // arrow only) and the readout is among the last to be dropped.
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
    const hitNumber = chalk.hex(hitColor)(hitRatePct === undefined ? '--' : `${hitRatePct.toFixed(2)}%`);
    const runStrip: FitItem[] = [
      {
        id: 'cache',
        rank: [10, 7],
        dropRank: 2,
        variants: [
          `${dim(`↓ ${t('footer.hit')}:`)} ${hitNumber}`,
          `${dim(`↓ ${t('footer.hit_short')}`)} ${hitNumber}`,
          `${dim('↓')} ${hitNumber}`,
        ],
      },
    ];

    // Mode badges appear only while their mode is on (an always-visible row
    // of muted labels was in the way), in the fixed order plan → rlm →
    // wolfpack, in the mode colour and bold. No marker glyph — the colour
    // alone carries it.
    const isFusion = state.planMode === 'fusionplan';
    // The plan badge has two labels (plan / fusion); its slot is as wide as the
    // wider one so switching between them does not move what follows.
    const planSlot = Math.max(visibleWidth(t('badge.plan')), visibleWidth(t('badge.fusion')));
    const modeBadge = (id: string, label: string, color: string, slot = 0): FitItem => {
      const pad = ' '.repeat(Math.max(0, slot - visibleWidth(label)));
      return { id, rank: 3, variants: [chalk.hex(color).bold(label) + pad] };
    };
    if (state.planMode !== 'off') {
      runStrip.push(
        modeBadge(
          'plan',
          isFusion ? t('badge.fusion') : t('badge.plan'),
          isFusion ? colors.fusionPlanMode : colors.planMode,
          planSlot,
        ),
      );
    }
    if (state.rlmEnabled) runStrip.push(modeBadge('rlm', t('badge.rlm'), colors.rlmMode));
    if (state.wolfpackMode) runStrip.push(modeBadge('wolfpack', t('badge.wolfpack'), colors.wolfpackMode));

    // The goal is rarely on, so unlike the switches it only appears while a
    // goal is active; it shortens before it is dropped.
    if (state.goalActive && state.goal) {
      const goalStyle = chalk.hex(colors.primary).bold;
      runStrip.push({
        id: 'goal',
        rank: 6,
        dropRank: 3.5,
        variants: goalVariants(state.goal).map((text) => goalStyle(text)),
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
      runStrip.push({
        id: 'running',
        rank: 9.5,
        dropRank: 4,
        variants: [running(counters.join(' · ')), running(t('footer.running_total', { count: String(total) }))],
      });
    }

    // Channel: always shown. Only the dot carries the channel colour — blue
    // for Lark, green for WeChat, muted when not connected; the label stays
    // muted. It shortens to `Line` before it is dropped, and is the last
    // droppable item on the row after the cache hit.
    const platform = state.linePlatform ?? null;
    const lineConnected = state.lineActive && platform !== null;
    const dotColor = !lineConnected
      ? colors.textDim
      : platform === 'lark'
        ? colors.lineLark
        : colors.success;
    const lineDot = chalk.hex(dotColor)('◆');
    const platformName = platform === 'lark' ? t('footer.line_lark') : t('footer.line_wechat');
    const channel: FitItem = {
      id: 'channel',
      rank: 5,
      dropRank: 1.5,
      variants: [
        `${lineDot} ${dim(t('footer.line_status', { status: lineConnected ? platformName : t('footer.line_disconnected') }))}`,
        `${lineDot} ${dim(t('footer.line_short'))}`,
      ],
    };

    // Jobs: only what needs the person now — something waiting, or jobs that
    // nothing runs. A healthy background stays out of the footer (the
    // sidebar's Jobs panel has the details). Next to the channel, in the same
    // dot + label form, in the warning colour.
    const jobsOn = state.jobsEnabled ?? 0;
    const jobsWaiting = state.jobsWaiting ?? 0;
    const jobsStopped = jobsOn > 0 && state.jobsHostRunning === false;
    const attention: FitItem[] = [];
    if (jobsWaiting > 0 || jobsStopped) {
      const warn = chalk.hex(colors.warning);
      const label =
        jobsWaiting > 0 ? t('footer.jobs_waiting', { count: String(jobsWaiting) }) : t('footer.jobs_stopped');
      attention.push({
        id: 'jobs',
        rank: 5.5,
        dropRank: 1.6,
        variants: [`${warn('◆')} ${warn(label)}`],
      });
    }

    // Work status stays put on the right of line 2; only its elapsed clock
    // can be shed.
    const status: FitItem = {
      id: 'status',
      rank: 0.5,
      keep: true,
      variants: buildStatusLine(state.streamingPhase, state.streamingStartTime, {
        isCompacting: state.isCompacting === true,
        pendingUserAction: state.pendingUserAction ?? null,
        pendingUserActionSince: state.pendingUserActionSince ?? null,
        reconnectAttempt: state.reconnectAttempt ?? 0,
        reconnectMaxAttempts: state.reconnectMaxAttempts,
        reconnectUntil: state.reconnectUntil,
      }).map((text) => dim(text)),
    };

    return [fitRow(identity, [gauge], width), fitRow(runStrip, [...attention, channel, status], width)];
  }
}
