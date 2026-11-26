/**
 * Rows a panel that replaces the editor may take.
 *
 * The panel sits in the dock, under the transcript and above the status row
 * and the footer; the dock clips from the bottom, so a panel taller than what
 * is left loses its last rows — the choices and the key hints. A panel asks
 * for its budget on every render and drops what it can do without.
 */

import type { Component } from '@liutod-scream/pi-tui';

import {
  DOCK_FOOTER_ROWS,
  DOCK_STATUS_ROWS,
  PANEL_MIN_TRANSCRIPT_ROWS,
  TODO_PANEL_MIN_WIDTH,
} from '#/tui/constant/rendering';

/** Fewest rows a panel is ever squeezed to: a frame, a title, a choice, a hint. */
const PANEL_MIN_ROWS = 6;

/**
 * The terminal's rows minus the dock below the panel and the transcript row
 * kept above it. Unknown height (tests, previews) means no limit.
 */
export function panelRowBudget(terminalRows: number | undefined): number {
  if (terminalRows === undefined || !Number.isFinite(terminalRows)) return Number.POSITIVE_INFINITY;
  return Math.max(PANEL_MIN_ROWS, terminalRows - DOCK_STATUS_ROWS - DOCK_FOOTER_ROWS - PANEL_MIN_TRANSCRIPT_ROWS);
}

/** What `panelViewportRows` reads of the TUI: the terminal and the dock rows above the editor. */
export interface PanelViewport {
  readonly terminal: { readonly rows: number; readonly columns: number };
  readonly todoPanelContainer: Component;
  readonly errorBannerContainer: Component;
  readonly planModeBannerContainer: Component;
}

/**
 * Terminal rows less the rows the dock keeps above the editor — the todo panel,
 * the error banner and the plan banner. The dock shares out an overflow among
 * everything in it by size, so a panel that counted the whole terminal as its
 * own would still lose its last rows (the choices, the key hints) whenever one
 * of those is on screen, and approvals are asked in the middle of work, when the
 * todo panel is.
 */
export function panelViewportRows(viewport: PanelViewport): number {
  const { rows, columns } = viewport.terminal;
  if (!Number.isFinite(rows)) return rows;
  let above = viewport.errorBannerContainer.render(columns).length + viewport.planModeBannerContainer.render(columns).length;
  if (columns >= TODO_PANEL_MIN_WIDTH) above += viewport.todoPanelContainer.render(columns).length;
  return Math.max(0, rows - above);
}
