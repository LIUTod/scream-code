/**
 * Panel layout arithmetic for the three-column shell (pure functions, no
 * framework dependency, unit-tested in isolation).
 *
 * Column contract:
 *   left rail/panel 264–420 (default 288, collapsed track 56) | middle
 *   minmax(0,1fr) with a 400px floor | right dock 300–70vw (first open 45vw).
 *
 * Guarantees: the chat column keeps its minimum width (400px desktop /
 * 320px compact) no matter how the sidebar and the right dock are resized.
 */

export const MOBILE_MAX_WIDTH = 640;
/** At or below this viewport width the sidebar auto-collapses to the rail and
 *  only re-opens as an overlay above the chat column (matchMedia-driven). */
export const SIDEBAR_COMPACT_MAX_WIDTH = 1024;
/** Below this viewport width the right dock becomes a full-screen overlay
 *  instead of owning a grid track. */
export const SPLIT_PANEL_MIN_WIDTH = 768;

export const SIDEBAR_MIN_WIDTH = 264;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 288;
/** Collapsed rail width — mirrors --sidebar-width-collapsed in tokens.css. */
export const SIDEBAR_RAIL_WIDTH = 56;

export const RIGHT_PANEL_MIN_WIDTH = 300;
/** The dock never claims more than this share of the viewport. */
export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 0.7;

const COMPACT_CHAT_MIN_WIDTH = 320;
const DESKTOP_CHAT_MIN_WIDTH = 400;

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

/** First-open default: 45% of the viewport, floored at the dock minimum and
 *  capped at the 70vw ceiling. */
export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(
    viewportWidth * 0.45,
    RIGHT_PANEL_MIN_WIDTH,
    Math.round(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO),
  );
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;

  const compact = viewportWidth < SPLIT_PANEL_MIN_WIDTH;
  const chatWidth = compact ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH;
  const visibleRightPanelWidth = !compact && rightPanelOpen ? rightPanelWidth : 0;
  return Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - chatWidth - visibleRightPanelWidth);
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth } = options;
  const ratioCap = Math.round(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO);
  // Overlay mode: the dock is free up to its own 70vw ceiling.
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return ratioCap;

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  return Math.min(
    ratioCap,
    viewportWidth - DESKTOP_CHAT_MIN_WIDTH - visibleSidebarWidth,
  );
}
