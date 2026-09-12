import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';

/** Display-column width of a string, matching the terminal layout engine
 *  (ANSI sequences stripped, CJK/wide chars counted as 2 columns). */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}

/** Pad `label` to `target` display columns with spaces (CJK-aware). */
export function padLabel(label: string, target: number): string {
  return label + ' '.repeat(Math.max(0, target - displayWidth(label)));
}

/**
 * Shared sidebar grid.
 *
 * A per-panel metric table only makes a panel tidy *inside itself*: each one
 * derived its own label column from its own longest label, so the Session
 * panel's values ended on a different column than the Hub's. This grid is the
 * cross-panel contract — a reserved marker column, one shared label column,
 * values right-aligned to the panel's inner edge, and free text starting on the
 * value column. Panels keep ownership of colour; this owns geometry only.
 */

/** Columns reserved for a status glyph (`●` / `○` / `✓`); blank when unused. */
export const SIDEBAR_MARKER_COLS = 2;
/** Shared label column, sized by the widest label any panel needs in *either*
 *  language: English wins here (`total tokens` = 12; CJK labels top out at 8).
 *  Narrower panels squeeze this column instead of pushing values past the edge,
 *  and only then do labels truncate. */
export const SIDEBAR_LABEL_COLS = 12;
/** Never let two columns touch. */
export const SIDEBAR_MIN_GAP = 1;

export interface SidebarGridRow {
  /** Single glyph status marker; blank-padded so labels still line up. */
  readonly marker?: string;
  readonly label: string;
  /** Right-aligned reading. Values are never squeezed to make labels fit. */
  readonly value?: string;
  /** Free text (branch name, criterion): starts on the value column and stays
   *  left-aligned, truncated to the remaining width. */
  readonly note?: string;
}

export interface SidebarGridCells {
  /** Pre-padded marker column (never empty — always `SIDEBAR_MARKER_COLS`). */
  readonly marker: string;
  /** Label truncated to the shared column, not padded. */
  readonly label: string;
  /** Fill columns between the label and the reading. */
  readonly gap: number;
  readonly value?: string;
  readonly note?: string;
}

export function layoutSidebarGrid(
  rows: readonly SidebarGridRow[],
  width: number,
): SidebarGridCells[] {
  const valueCols = Math.max(0, ...rows.map((row) => displayWidth(row.value ?? '')));
  const labelBudget = Math.max(
    1,
    width - SIDEBAR_MARKER_COLS - Math.max(valueCols, SIDEBAR_MIN_GAP) - SIDEBAR_MIN_GAP,
  );
  const labelCols = Math.min(SIDEBAR_LABEL_COLS, labelBudget);
  const valueStart = Math.max(SIDEBAR_MARKER_COLS + labelCols + SIDEBAR_MIN_GAP, width - valueCols);

  return rows.map((row) => {
    // The marker is left-aligned inside its column: padding it on the left
    // would push the glyph into the label and break the shared label column.
    const marker = padLabel(row.marker ?? '', SIDEBAR_MARKER_COLS);
    const label = truncateToWidth(row.label, labelCols);
    const used = SIDEBAR_MARKER_COLS + displayWidth(label);
    if (row.value !== undefined) {
      const gap = Math.max(SIDEBAR_MIN_GAP, width - used - displayWidth(row.value));
      // Values normally never truncate — the label column gives way first. This
      // last resort only fires when even a one-column label cannot fit, so a
      // pathological width degrades instead of overflowing the panel.
      const room = Math.max(1, width - used - gap);
      return { marker, label, gap, value: truncateToWidth(row.value, room) };
    }
    if (row.note !== undefined) {
      // Free text prefers to start on the value column (so it reads as that
      // panel's "value"), but never at the cost of truncating prose early: pull
      // it left when the value column sits too far right for the text to fit.
      const noteCols = displayWidth(row.note);
      const aligned = Math.max(SIDEBAR_MIN_GAP, valueStart - used);
      const fits = Math.max(SIDEBAR_MIN_GAP, width - used - noteCols);
      const gap = Math.min(aligned, fits);
      return {
        marker,
        label,
        gap,
        note: truncateToWidth(row.note, Math.max(1, width - used - gap)),
      };
    }
    // A bare row (badge, branch name): text sits on the label column.
    return { marker, label, gap: SIDEBAR_MIN_GAP };
  });
}

/** Plain-text join of grid cells — panels that need colour compose the parts. */
export function renderSidebarGridRow(cells: SidebarGridCells): string {
  const { marker, label, gap, value, note } = cells;
  return `${marker}${label}${' '.repeat(gap)}${value ?? note ?? ''}`;
}
