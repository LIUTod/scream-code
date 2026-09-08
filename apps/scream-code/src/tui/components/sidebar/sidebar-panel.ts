import type { Component } from '@liutod-scream/pi-tui';

/**
 * Runtime data handed to a panel when it builds its content. Panels are
 * intentionally decoupled from the session/harness internals: whatever
 * they need is injected here, so a panel stays a pure view over a
 * snapshot and never reaches into controller state directly.
 */
export interface SidebarData {
  readonly mode?: string;
  readonly planMode?: string;
  readonly activeAgentCount?: number;
  readonly backgroundTasks?: ReadonlyArray<{ readonly id: string; readonly kind?: string; readonly label?: string }>;
}

export interface SidebarPanelContext {
  /** Request a re-render when a panel changes its own content/width. */
  readonly requestRender: () => void;
  /** Snapshot of runtime data a panel may render (mode/plan/agents/tasks). */
  readonly getData: () => SidebarData;
}

/**
 * A pluggable sidebar panel. Register one with {@link SidebarManager}; the
 * manager owns activation/toggle/width, the panel owns its rendered content.
 */
export interface SidebarPanel {
  /** Stable identifier used by commands and the keybindings. */
  readonly id: string;
  /** Human-readable title shown while the panel is active. */
  readonly title: string;
  /** Preferred width in terminal columns. */
  readonly width: number;
  /** Build the rendered content for the current context. */
  build(ctx: SidebarPanelContext): Component;
  /** Called when this panel becomes active (optional). */
  onOpen?(ctx: SidebarPanelContext): void;
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
 * Terminal width below which the sidebar is hidden entirely (mirrors the
 * existing `todoPanel`/`statusBar` width gates in buildLayout).
 */
export const SIDEBAR_MIN_VIEWPORT_WIDTH = 110;

export function clampSidebarWidth(cols: number): number {
  if (!Number.isFinite(cols)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(cols)));
}
