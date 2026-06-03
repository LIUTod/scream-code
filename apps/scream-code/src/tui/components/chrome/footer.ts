/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1: [yolo] [plan] <model> <cwd>  <git-badge>  <shortcut hints>
 *   Line 2: context: XX.X% (tokens/max)
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, LivePaneMode } from '#/tui/types';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import { safeUsageRatio } from '#/utils/usage/usage-format';

const MAX_CWD_SEGMENTS = 3;

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " | ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
//
// This is deliberately code-level configuration: edit the interval and the
// TOOLBAR_TIPS array below to change what the footer advertises.
const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = ' | ';

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

const TOOLBAR_TIPS: readonly ToolbarTip[] = [
  { text: 'shift+tab: 计划模式' },
  { text: '/model: 切换模型' },
  { text: 'ctrl+s: 中途干预', priority: 2 },
  { text: '/compact: 压缩上下文', priority: 2 },
  { text: 'ctrl+o: 展开工具输出' },
  { text: '/tasks: 后台任务' },
  { text: 'shift+enter: 换行' },
  { text: '/init: 生成 AGENTS.md', priority: 2 },
  { text: '@: 提及文件' },
  { text: 'ctrl+c: 取消' },
  { text: '/theme: 切换主题' },
  { text: '/auto: 自动权限模式' },
  { text: '/yes: 自动批准' },
  { text: '/help: 显示命令' },
  { text: '/config: 选择并配置你常用的模型商', solo: true, priority: 3 },
  { text: '让 Scream 安排任务，例如 "八点提醒我上号打三角洲"', solo: true, priority: 3 },
];

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

const ROTATION: readonly ToolbarTip[] = buildWeightedTips(TOOLBAR_TIPS);

function currentTipIndex(): number {
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
function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const n = ROTATION.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = ROTATION[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = ROTATION[(offset + 1) % n]!;
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

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env['HOME'] ?? '';
  let work = path;
  if (home && path === home) {
    return '~';
  }
  if (home && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function safeUsage(usage: number): number {
  return safeUsageRatio(usage);
}

function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  const pct = `${(safeUsage(usage) * 100).toFixed(1)}%`;
  if (maxTokens && maxTokens > 0 && tokens !== undefined) {
    return `上下文：${pct} (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `上下文：${pct}`;
}

// ── Gradient status line for footer line 2 ───────────────────────────

const BRAND_COLORS = ['#72A4E9', '#A78BFA', '#34D399'];
const GRADIENT_CYCLE_MS = 4000;
const SPINNER_FRAMES = ['●', '◉', '◎', '◌', '○', '◌', '◎', '◉'];
const SPINNER_TICK_MS = 120;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function lerpGradient(t: number): string {
  const count = BRAND_COLORS.length;
  const segment = Math.min(t * count, count - 1);
  const idx = Math.floor(segment);
  const localT = segment - idx;
  const nextIdx = (idx + 1) % count;
  const [r0, g0, b0] = hexToRgb(BRAND_COLORS[idx]!);
  const [r1, g1, b1] = hexToRgb(BRAND_COLORS[nextIdx]!);
  const r = Math.round(r0 + (r1 - r0) * localT);
  const g = Math.round(g0 + (g1 - g0) * localT);
  const b = Math.round(b0 + (b1 - b0) * localT);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function buildStatusLine(
  streamingPhase: AppState['streamingPhase'],
  livePaneMode: LivePaneMode,
  streamingStartTime: number,
): string {
  if (streamingPhase === 'idle' && livePaneMode !== 'tool') {
    return '○ 空闲';
  }

  let label: string;
  if (livePaneMode === 'tool') {
    label = '执行中';
  } else if (streamingPhase === 'waiting') {
    label = '等待响应';
  } else if (streamingPhase === 'thinking') {
    label = '思考中';
  } else if (streamingPhase === 'composing') {
    label = '输出中';
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

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.status)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private readonly onGitStatusChange: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(state: AppState, colors: ColorPalette, onGitStatusChange: () => void = () => {}) {
    this.state = state;
    this.colors = colors;
    this.onGitStatusChange = onGitStatusChange;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onGitStatusChange });
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onGitStatusChange });
    }
    this.state = state;
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
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const colors = this.colors;
    const state = this.state;

    // ── Line 1: mode badges + model + [N task(s) running] + [N agent(s) running] + cwd + git + hints ──
    const left: string[] = [];
    if (state.permissionMode === 'auto') left.push(chalk.hex(colors.warning).bold('auto'));
    if (state.permissionMode === 'yolo') left.push(chalk.hex(colors.warning).bold('YES'));
    if (state.planMode) left.push(chalk.hex(colors.primary).bold('plan'));
    if (state.parallelMode) left.push(chalk.hex('#72A4E9').bold('fanout'));
    if (state.goalActive && state.goal) {
      const goalText = state.goal.length > 20 ? state.goal.slice(0, 20) + '…' : state.goal;
      left.push(chalk.hex(colors.success).bold(`🎯 ${goalText}`));
    }

    const model = shortenModel(modelDisplayName(state));
    if (model) {
      const thinkingLabel = state.thinking ? ' 思考中' : '';
      left.push(chalk.hex(colors.text)(`${model}${thinkingLabel}`));
    }

    // Background-task badges sit immediately before cwd. `bash-*` tasks
    // (shell processes) and `agent-*` tasks (background subagents) get
    // separate badges so the user can distinguish them at a glance.
    if (this.backgroundBashTaskCount > 0) {
      const noun = this.backgroundBashTaskCount === 1 ? '个任务' : '个任务';
      left.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundBashTaskCount)}${noun} 运行中]`),
      );
    }
    if (this.backgroundAgentCount > 0) {
      const noun = this.backgroundAgentCount === 1 ? '个代理' : '个代理';
      left.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundAgentCount)}${noun} 运行中]`),
      );
    }

    const cwd = shortenCwd(state.workDir);
    if (cwd) left.push(chalk.hex(colors.status)(cwd));

    const git = this.gitCache.getStatus();
    if (git !== null) {
      left.push(formatFooterGitBadge(git, colors));
    }

    const leftLine = left.join('  ');
    const leftWidth = visibleWidth(leftLine);

    // Rotating hint tips, fill remaining space on line 1.
    const { primary, pair } = tipsForIndex(currentTipIndex());
    const gap = 2;
    const remaining = Math.max(0, width - leftWidth - gap);
    let tipText = '';
    if (pair && visibleWidth(pair) <= remaining) {
      tipText = pair;
    } else if (primary && visibleWidth(primary) <= remaining) {
      tipText = primary;
    }

    let line1: string;
    if (tipText) {
      const pad = width - leftWidth - visibleWidth(tipText);
      line1 = leftLine + ' '.repeat(Math.max(0, pad)) + chalk.hex(colors.textMuted)(tipText);
    } else if (leftWidth <= width) {
      line1 = leftLine;
    } else {
      line1 = truncateToWidth(leftLine, width, '…');
    }

    // ── Line 2: transient hint (left)  …  context + status (right) ─────
    const statusLine = buildStatusLine(
      state.streamingPhase,
      state.livePaneMode,
      state.streamingStartTime,
    );
    const ccDot = state.ccConnectActive
      ? chalk.hex(colors.success)('●')
      : chalk.hex(colors.textDim)('●');
    const rightText = ccDot + ' ' + formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    ) + '  ' + statusLine;
    const rightWidth = visibleWidth(rightText);
    let line2: string;
    if (this.transientHint) {
      const hintText = chalk.hex(colors.warning).bold(this.transientHint);
      const hintWidth = visibleWidth(hintText);
      const pad = Math.max(2, width - hintWidth - rightWidth);
      line2 = hintText + ' '.repeat(pad) + chalk.hex(colors.textDim)(rightText);
    } else {
      const lpad = Math.max(0, width - rightWidth);
      line2 = ' '.repeat(lpad) + chalk.hex(colors.textDim)(rightText);
    }

    return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
  }
}
