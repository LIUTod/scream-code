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

/** Pad `value` on the LEFT to `target` display columns (CJK-aware), which is
 *  what right-aligning a numeric column means in terminal space. */
export function padValue(value: string, target: number): string {
  return ' '.repeat(Math.max(0, target - displayWidth(value))) + value;
}

export interface AlignedMetricRows {
  /** Display columns occupied by the label column (widest label). */
  readonly labelCols: number;
  /** Display columns occupied by the value column (widest value). */
  readonly valueCols: number;
  /** `[paddedLabel, paddedValue]` pairs, in input order. The label half
   * already carries the trailing gap, so callers only concatenate colors. */
  readonly rows: ReadonlyArray<readonly [label: string, value: string]>;
}

/**
 * The two-column metric layout shared by the sidebar panels: every label is
 * padded to the widest label, every value to the widest value and right
 * aligned, with a fixed gap in between. Both halves are returned pre-padded
 * (never colored) so each panel keeps control of its own palette.
 */
export const METRIC_LABEL_GAP = 2;

export interface MetricGridOptions {
  /** Columns between the label and the value column. */
  readonly gap?: number;
  /** Labels that render outside the grid but must still share its column
   * width (a free-text row under a numeric table, e.g. the goal criterion). */
  readonly extraLabels?: readonly string[];
  /** Columns available for the value column. Wider values are truncated to
   * this budget, which guarantees the label column always survives. */
  readonly maxValueCols?: number;
}

export function alignMetricRows(
  rows: ReadonlyArray<readonly [label: string, value: string]>,
  opts: MetricGridOptions = {},
): AlignedMetricRows {
  const gap = opts.gap ?? METRIC_LABEL_GAP;
  const labels = [...rows.map(([label]) => label), ...(opts.extraLabels ?? [])];
  const labelCols = labels.length === 0 ? 0 : Math.max(...labels.map((label) => displayWidth(label)));
  const measured = rows.length === 0 ? 0 : Math.max(...rows.map(([, value]) => displayWidth(value)));
  const valueCols =
    opts.maxValueCols === undefined ? measured : Math.min(measured, Math.max(0, opts.maxValueCols));
  const separator = ' '.repeat(Math.max(0, gap));
  return {
    labelCols,
    valueCols,
    rows: rows.map(
      ([label, value]) =>
        [
          padLabel(label, labelCols) + separator,
          padValue(truncateToWidth(value, valueCols), valueCols),
        ] as const,
    ),
  };
}
