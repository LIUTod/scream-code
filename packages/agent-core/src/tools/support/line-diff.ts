/**
 * LCS-based line diff used by stale-anchor recovery for line-range edits.
 *
 * Recovery diffs the snapshot content (what the model last saw) against the
 * current content (what is on disk now) and maps the model's 1-indexed line
 * window into current coordinates. The diff is a classic longest-common-
 * subsequence dynamic program over physical lines — no dependencies, and the
 * O(n·m) table is affordable for the file sizes this path serves (recovery
 * bails out for anything larger, see MAX_DP_CELLS).
 *
 * Runs are reported in document order with 1-indexed inclusive spans, so the
 * numbers can be shown to the model directly:
 * - `equal` spans both sides; snapshot line s maps to current line
 *   s + (curStart - snapStart) throughout the run.
 * - `delete` marks snapshot lines removed externally; its current span is
 *   empty (curStart = curEnd + 1) and its snapshot lines have no image.
 * - `insert` marks lines added externally; its snapshot span is empty
 *   (snapStart = snapEnd + 1) and its current lines belong to no snapshot
 *   line. An insert run "sits at" snapshot point snapStart: between snapshot
 *   lines snapStart - 1 and snapStart.
 */

export type LineDiffRunType = 'equal' | 'insert' | 'delete';

export interface LineDiffRun {
  readonly type: LineDiffRunType;
  /** 1-indexed inclusive span in the snapshot lines; empty for insert runs. */
  readonly snapStart: number;
  readonly snapEnd: number;
  /** 1-indexed inclusive span in the current lines; empty for delete runs. */
  readonly curStart: number;
  readonly curEnd: number;
}

/** Cap on DP table cells; past it the diff returns null instead of ballooning memory. */
const MAX_DP_CELLS = 8_388_608;

/**
 * Split model-view text into physical lines the way Read and Edit count
 * them: a trailing newline terminates the last line instead of opening an
 * empty one, and an empty file has zero lines.
 */
export function physicalLinesOf(text: string): string[] {
  if (text.length === 0) return [];
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

/**
 * Diff two line arrays into runs, or null when the inputs are too large for
 * the DP table (recovery treats null as "cannot remap" and refuses).
 * Ties during backtracking prefer deletions, so the output is deterministic.
 */
export function diffLineRuns(
  snapshotLines: readonly string[],
  currentLines: readonly string[],
): LineDiffRun[] | null {
  const n = snapshotLines.length;
  const m = currentLines.length;
  if (n * m > MAX_DP_CELLS) return null;

  // Row-major LCS table: table[i * (m + 1) + j] = LCS length of the first i
  // snapshot lines and the first j current lines.
  const stride = m + 1;
  const table = new Uint32Array((n + 1) * stride);
  for (let i = 1; i <= n; i += 1) {
    const rowBase = i * stride;
    const prevBase = rowBase - stride;
    const snapshotLine = snapshotLines[i - 1];
    for (let j = 1; j <= m; j += 1) {
      // The `?? 0` keeps noUncheckedIndexedAccess quiet; every index here is
      // in bounds by construction, and out-of-range table reads would be 0
      // (the row-0/column-0 sentinel) anyway.
      table[rowBase + j] =
        snapshotLine === currentLines[j - 1]
          ? (table[prevBase + j - 1] ?? 0) + 1
          : Math.max(table[prevBase + j] ?? 0, table[rowBase + j - 1] ?? 0);
    }
  }

  // Backtrack from (n, m) into per-line steps, then reverse into document
  // order. Equal lines always take the diagonal (standard LCS property).
  interface DiffStep {
    readonly type: 'equal' | 'insert' | 'delete';
    readonly snapLine: number;
    readonly curLine: number;
  }
  const steps: DiffStep[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (snapshotLines[i - 1] === currentLines[j - 1]) {
      steps.push({ type: 'equal', snapLine: i, curLine: j });
      i -= 1;
      j -= 1;
      continue;
    }
    if (
      (table[(i - 1) * stride + j] ?? 0) >= (table[i * stride + (j - 1)] ?? 0)
    ) {
      steps.push({ type: 'delete', snapLine: i, curLine: 0 });
      i -= 1;
    } else {
      steps.push({ type: 'insert', snapLine: 0, curLine: j });
      j -= 1;
    }
  }
  while (i > 0) {
    steps.push({ type: 'delete', snapLine: i, curLine: 0 });
    i -= 1;
  }
  while (j > 0) {
    steps.push({ type: 'insert', snapLine: 0, curLine: j });
    j -= 1;
  }
  steps.reverse();

  // Compress the step list into runs, tracking the next unconsumed line on
  // each side so empty spans get their document-order position.
  const runs: LineDiffRun[] = [];
  let snapPos = 1;
  let curPos = 1;
  for (const step of steps) {
    const last = runs.at(-1);
    if (last !== undefined && last.type === step.type) {
      runs[runs.length - 1] = {
        type: last.type,
        snapStart: last.snapStart,
        snapEnd: step.type === 'insert' ? last.snapEnd : step.snapLine,
        curStart: last.curStart,
        curEnd: step.type === 'delete' ? last.curEnd : step.curLine,
      };
    } else {
      runs.push({
        type: step.type,
        snapStart: step.type === 'insert' ? snapPos : step.snapLine,
        snapEnd: step.type === 'insert' ? snapPos - 1 : step.snapLine,
        curStart: step.type === 'delete' ? curPos : step.curLine,
        curEnd: step.type === 'delete' ? curPos - 1 : step.curLine,
      });
    }
    if (step.type !== 'insert') snapPos = step.snapLine + 1;
    if (step.type !== 'delete') curPos = step.curLine + 1;
  }
  return runs;
}

/**
 * Query layer over diff runs for recovery decisions: where a snapshot line
 * lives now, and whether a model's window stays clear of the external
 * changes.
 */
export interface LineRangeMapping {
  readonly runs: readonly LineDiffRun[];
  readonly snapshotTotal: number;
  readonly currentTotal: number;
  /**
   * Current line carrying a snapshot line's content, or undefined when the
   * external change removed that snapshot line (it sits in a delete run).
   */
  mapSnapshotLine(snapLine: number): number | undefined;
  /**
   * First non-equal run touching the model's window: a delete run overlapping
   * the snapshot window, or an insert run whose current lines fall inside the
   * mapped window. Undefined when the window is clear of every external
   * change (endpoints may sit at the edges — inserts immediately before or
   * after the window are outside the mapped span and do not conflict).
   */
  firstConflictingRun(
    snapStart: number,
    snapEnd: number,
    mappedStart: number,
    mappedEnd: number,
  ): LineDiffRun | undefined;
}

export function buildLineMapping(
  runs: readonly LineDiffRun[],
  snapshotTotal: number,
  currentTotal: number,
): LineRangeMapping {
  return {
    runs,
    snapshotTotal,
    currentTotal,
    mapSnapshotLine(snapLine: number): number | undefined {
      for (const run of runs) {
        if (run.type !== 'equal') continue;
        if (snapLine < run.snapStart || snapLine > run.snapEnd) continue;
        return snapLine + (run.curStart - run.snapStart);
      }
      return undefined;
    },
    firstConflictingRun(
      snapStart: number,
      snapEnd: number,
      mappedStart: number,
      mappedEnd: number,
    ): LineDiffRun | undefined {
      for (const run of runs) {
        if (run.type === 'equal') continue;
        if (run.type === 'delete') {
          // Overlaps the window in snapshot coordinates.
          if (run.snapStart <= snapEnd && run.snapEnd >= snapStart) return run;
          continue;
        }
        // Insert run: its lines land inside the mapped window.
        if (run.curStart <= mappedEnd && run.curEnd >= mappedStart) return run;
      }
      return undefined;
    },
  };
}
