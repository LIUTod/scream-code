/**
 * Line-diff statistics for the file-mutating tools.
 *
 * Edit and Write both hold the pre-write and post-write text of the file they
 * touch, so they can report exact `+added / -removed` line counts to the UI.
 * Deriving those counts from the tool arguments instead is systematically
 * wrong (a Write overwrite hides every removed line; an Edit with
 * `replace_all` sees only one occurrence), so the tools report them here.
 *
 * The display payload is persisted with the session (the recorded tool
 * result), so it carries counts plus only the text the call's own arguments
 * held — never the rest of the file (see `fileDiffDetails`).
 */

import { diffLines, type Change } from 'diff';

/**
 * Upper bound applied to either side of the diff. Beyond it the line diff is
 * skipped (returns `undefined`) so an oversized file cannot stall the calling
 * tool; the caller then omits the display and the UI falls back to its
 * argument-derived counts.
 */
const MAX_DIFF_CHARS = 1_000_000;

/**
 * Wall-clock budget for a single line diff. jsdiff's Myers implementation has
 * adversarial cases that stay quadratic-ish well inside {@link MAX_DIFF_CHARS}:
 * two ~400 KB blobs with no common lines measured minutes before aborting. Past
 * the budget jsdiff gives up and the result is treated exactly like the size
 * guard (no display, argument-derived fallback) — stalling the tool, and with it
 * the event loop, is never acceptable for a UI statistic.
 */
const DIFF_BUDGET_MS = 250;

/**
 * `diffLines` with the runtime `timeout` option. jsdiff honours `timeout`
 * (returning `undefined` when it gives up) but its published typings omit it.
 */
const diffLinesWithBudget = diffLines as unknown as (
  before: string,
  after: string,
  options: { timeout: number },
) => Change[] | undefined;

/**
 * Count the lines in a `diffLines` part value the way `git diff --numstat`
 * counts them: a trailing newline terminates the preceding line instead of
 * opening an empty one, and the empty string has no lines.
 */
export function countLines(value: string): number {
  if (value.length === 0) return 0;
  const lineBreaks = value.split('\n').length - 1;
  return value.endsWith('\n') ? lineBreaks : lineBreaks + 1;
}

/**
 * Exact line counts between `before` and `after`: every added / removed part
 * `diffLines` reports contributes its own line count, so a single replaced
 * line is one addition plus one removal. Whitespace is significant (jsdiff's
 * `ignoreWhitespace` is off by default) and `\r\n` endings are compared
 * literally.
 *
 * Returns `undefined` when either side exceeds {@link MAX_DIFF_CHARS} or the
 * diff does not finish within {@link DIFF_BUDGET_MS}.
 */
export function fileDiffSummary(
  before: string,
  after: string,
): { added: number; removed: number } | undefined {
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) return undefined;

  const parts = diffLinesWithBudget(before, after, { timeout: DIFF_BUDGET_MS });
  if (parts === undefined) return undefined;

  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lines = countLines(part.value);
    if (part.added) {
      added += lines;
    } else if (part.removed) {
      removed += lines;
    }
  }
  return { added, removed };
}

/**
 * One row of the UI's change preview.
 *
 * - `add` / `delete`: a changed line with its 1-based file line number (new
 *   numbering for additions, old numbering for deletions).
 * - `context`: an unchanged line next to a change (new numbering), shown only
 *   when the change is expanded.
 * - `gap`: `count` unchanged lines left out between two shown rows.
 */
export interface FileDiffPreviewRow {
  readonly kind: 'add' | 'delete' | 'context' | 'gap';
  readonly line?: number | undefined;
  /** The line's text; absent for a deletion whose text the call did not carry. */
  readonly text?: string | undefined;
  /** `gap` only: how many unchanged lines it stands for. */
  readonly count?: number | undefined;
}

/** Changed lines kept for the preview; the UI shows fewer and counts the rest. */
export const FILE_DIFF_PREVIEW_ROWS = 40;
/** Rows of every kind kept in all, so many scattered one-line changes stay bounded. */
export const FILE_DIFF_PREVIEW_MAX_ROWS = 80;
/** Unchanged lines kept on each side of a change. */
export const FILE_DIFF_CONTEXT_LINES = 3;
const FILE_DIFF_PREVIEW_CHARS = 200;

function splitPartLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines;
}

export interface FileDiffDetailsOptions {
  /** The call's own arguments held the replaced text (Edit's old_string). */
  readonly deletedText: boolean;
  /**
   * The text the call's arguments carried (new_string, content). An
   * unchanged line next to a change keeps its text only when it appears in
   * here; otherwise it is left out (counted in a `gap`), so nothing the call
   * did not carry enters the session log.
   */
  readonly carried?: string | undefined;
}

/**
 * `fileDiffSummary` plus the first changed lines with their real line numbers
 * and the unchanged lines around them, in one diff.
 *
 * Text privacy: added lines come from the call's own arguments (new_string /
 * content). Deleted text is carried only when `deletedText` says the call's
 * arguments held it (Edit's old_string); otherwise a deletion keeps its line
 * number alone, so an overwrite never copies the replaced file into the log.
 * Unchanged lines keep their text only when it appears in `carried`.
 */
export function fileDiffDetails(
  before: string,
  after: string,
  options: FileDiffDetailsOptions,
):
  | {
      added: number;
      removed: number;
      preview: FileDiffPreviewRow[];
      previewTotal: number;
    }
  | undefined {
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) return undefined;
  const parts = diffLinesWithBudget(before, after, { timeout: DIFF_BUDGET_MS });
  if (parts === undefined) return undefined;

  let added = 0;
  let removed = 0;
  let oldLine = 1;
  let newLine = 1;
  const preview: FileDiffPreviewRow[] = [];
  let changedShown = 0;
  /** Unchanged lines passed since the last row, shown as a `gap` before the next one. */
  let skipped = 0;
  const clip = (text: string): string =>
    text.length > FILE_DIFF_PREVIEW_CHARS ? `${text.slice(0, FILE_DIFF_PREVIEW_CHARS)}…` : text;
  const full = (): boolean =>
    changedShown >= FILE_DIFF_PREVIEW_ROWS || preview.length >= FILE_DIFF_PREVIEW_MAX_ROWS;
  const push = (row: FileDiffPreviewRow): void => {
    // A gap only ever sits between two rows: the line numbers already say
    // where the first row starts.
    if (skipped > 0 && preview.length > 0) preview.push({ kind: 'gap', count: skipped });
    skipped = 0;
    preview.push(row);
  };
  const context = (text: string, line: number): void => {
    if (full()) return;
    if (options.carried !== undefined && options.carried.includes(text.replace(/\r$/, ''))) push({ kind: 'context', line, text: clip(text) });
    else skipped += 1;
  };

  for (const [index, part] of parts.entries()) {
    const lines = splitPartLines(part.value);
    if (part.added) {
      for (const text of lines) {
        if (!full()) {
          push({ kind: 'add', line: newLine, text: clip(text) });
          changedShown += 1;
        }
        newLine += 1;
      }
      added += lines.length;
    } else if (part.removed) {
      for (const text of lines) {
        if (!full()) {
          push({ kind: 'delete', line: oldLine, text: options.deletedText ? clip(text) : undefined });
          changedShown += 1;
        }
        oldLine += 1;
      }
      removed += lines.length;
    } else {
      // Unchanged: the lines after the previous change and before the next
      // one are context, the rest of the run is one gap.
      const afterPrevious = index === 0 ? 0 : Math.min(FILE_DIFF_CONTEXT_LINES, lines.length);
      const beforeNext =
        index === parts.length - 1 ? 0 : Math.min(FILE_DIFF_CONTEXT_LINES, lines.length - afterPrevious);
      for (let at = 0; at < lines.length; at += 1) {
        if (at < afterPrevious || at >= lines.length - beforeNext) context(lines[at] as string, newLine + at);
        else skipped += 1;
      }
      oldLine += lines.length;
      newLine += lines.length;
    }
  }
  return { added, removed, preview: dropLoneContext(preview), previewTotal: added + removed };
}

/**
 * Context only reads as context next to a change: a run of unchanged lines
 * cut off from every change by a gap (an empty line the call happened to
 * carry, say) is folded into the gaps around it, and no gap is left at
 * either end.
 */
function dropLoneContext(rows: readonly FileDiffPreviewRow[]): FileDiffPreviewRow[] {
  const out: FileDiffPreviewRow[] = [];
  let pendingGap = 0;
  let run: FileDiffPreviewRow[] = [];
  const flush = (): void => {
    if (run.some((row) => row.kind === 'add' || row.kind === 'delete')) {
      if (pendingGap > 0 && out.length > 0) out.push({ kind: 'gap', count: pendingGap });
      out.push(...run);
      pendingGap = 0;
    } else {
      pendingGap += run.length;
    }
    run = [];
  };
  for (const row of rows) {
    if (row.kind === 'gap') {
      flush();
      pendingGap += row.count ?? 0;
    } else {
      run.push(row);
    }
  }
  flush();
  return out;
}
