import type { Component } from '@liutod-scream/pi-tui';

import type { ColorPalette } from '#/tui/theme/colors';
import type { GoalJudgeState, GoalStatus } from '#/tui/types';
import type { SubagentSlot } from '#/tui/utils/subagent-slots';

/** Summary working-tree snapshot for the sidebar Git panel (摘要式):
 * workdir name + added/deleted line counts + changed-file count. */
export interface SidebarGitData {
  readonly workDir: string;
  readonly diffAdded: number;
  readonly diffDeleted: number;
  readonly filesCount: number;
}

/** Aggregated counters for the current session (computed from the transcript
 * and app state; time-based values derive from `startedAt` in render). */
export interface SidebarSessionStats {
  readonly turns: number;
  readonly toolCalls: number;
  readonly messages: number;
  readonly compactions: number;
  /** Cumulative token usage (all buckets summed) for this session. */
  readonly tokensTotal: number;
  /** Input tokens that were cache hits (cheap bucket). */
  readonly tokensInputCacheHit: number;
  /** Input tokens that were NOT cached (expensive bucket). */
  readonly tokensInputCacheMiss: number;
  /** Sum of output tokens for this session (main agent + all subagents). */
  readonly tokensOutput: number;
  /** Epoch ms when the current session started (reset on session switch). */
  readonly startedAt: number;
}

export interface SidebarGoalData {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  /** Wall-clock ms at the last snapshot (`wallClockBaseAt`); render adds the
   * elapsed since then so the timer ticks between sparse goal.updated events. */
  readonly wallClockMs: number;
  readonly wallClockBaseAt: number;
  readonly continuationCount: number;
  /** Completion criterion (判据) from the goal snapshot, or null. */
  readonly completionCriterion: string | null;
  /** Cumulative tokens spent on the goal (snapshot tokensUsed). */
  readonly tokensUsed: number;
  /** Input tokens (incl. cache) since the goal started; null = legacy record. */
  readonly inputTokens: number | null;
  /** Output tokens since the goal started; null = legacy record. */
  readonly outputTokens: number | null;
  /** Adjudication state for the 裁判 row (awaiting/judging/adjudicated). */
  readonly judge: GoalJudgeState;
}

/**
 * Runtime data handed to a panel when it builds its content. Panels are
 * intentionally decoupled from the session/harness internals: whatever
 * they need is injected here, so a panel stays a pure view over a
 * snapshot and never reaches into controller state directly.
 */
export interface SidebarData {
  readonly git?: SidebarGitData;
  readonly sessionStats?: SidebarSessionStats;
  readonly agents?: readonly SubagentSlot[];
  readonly goal?: SidebarGoalData;
}

export interface SidebarPanelContext {
  /** Request a re-render when a panel changes its own content/width. */
  readonly requestRender: () => void;
  /** Snapshot of runtime data a panel may render (git/session/goal). */
  readonly getData: () => SidebarData;
  /** Theme palette for content styling (labels/status letters). */
  readonly colors: ColorPalette;
}

/**
 * A pluggable sidebar panel. Register one with {@link SidebarManager}; in
 * stacked mode all visible panels render top-to-bottom inside the sidebar.
 */
export interface SidebarPanel {
  /** Stable identifier used by commands and the keybindings. */
  readonly id: string;
  /** Human-readable title shown while the panel is active. */
  readonly title: string;
  /** Preferred width in terminal columns. Note: the stacked sidebar renders
   * every panel at the manager's current width, so this field is currently
   * informational (reserved for a future single-panel/default-width mode). */
  readonly width: number;
  /** Build the rendered content for the current context. */
  build(ctx: SidebarPanelContext): Component;
  /** Return false to hide the panel from the stacked sidebar. Defaults to
   * always visible. Currently no panel is conditional (the Goal panel renders
   * a resting placeholder when no goal exists); reserved for future panels. */
  visible?(data: SidebarData): boolean;
  /** Called when this panel becomes active (optional). */
  onOpen?(): void;
  /** Called when this panel is deactivated/closed (optional). */
  onClose?(): void;
}

/**
 * Width bounds for the sidebar. Mirrors a web-sidebar min/max clamp and
 * the plan's `SIDEBAR_MIN_WIDTH` gate: below `SIDEBAR_MIN_VIEWPORT_WIDTH`
 * terminal columns the whole sidebar is hidden (see buildLayout's `visible`).
 */
export const SIDEBAR_MIN_WIDTH = 24;
export const SIDEBAR_MAX_WIDTH = 60;
export const SIDEBAR_DEFAULT_WIDTH = 30;

/**
 * Terminal width below which the sidebar is hidden entirely (matches the
 * existing `todoPanel` gate of ≥90 columns; at 90+ the sidebar leaves the
 * transcript ~60+ columns, which stays usable).
 */
export const SIDEBAR_MIN_VIEWPORT_WIDTH = 90;

export function clampSidebarWidth(cols: number): number {
  if (!Number.isFinite(cols)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(cols)));
}
