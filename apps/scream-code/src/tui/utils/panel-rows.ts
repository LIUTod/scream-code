/**
 * Rows a panel that replaces the editor may take.
 *
 * The panel sits in the dock, under the transcript and above the status row
 * and the footer; the dock clips from the bottom, so a panel taller than what
 * is left loses its last rows — the choices and the key hints. A panel asks
 * for its budget on every render and drops what it can do without.
 */

import {
  DOCK_FOOTER_ROWS,
  DOCK_STATUS_ROWS,
  PANEL_MIN_TRANSCRIPT_ROWS,
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
