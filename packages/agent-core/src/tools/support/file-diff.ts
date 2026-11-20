/**
 * Line-diff statistics for the file-mutating tools.
 *
 * Edit and Write both hold the pre-write and post-write text of the file they
 * touch, so they can report exact `+added / -removed` line counts to the UI.
 * Deriving those counts from the tool arguments instead is systematically
 * wrong (a Write overwrite hides every removed line; an Edit with
 * `replace_all` sees only one occurrence), so the tools report them here.
 *
 * Only counts leave this module: file contents must never be embedded in the
 * display payload, which is persisted with the session transcript.
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

/** One changed line for the UI's inline preview (a 1-based file line number). */
export interface FileDiffPreviewRow {
  readonly kind: 'add' | 'delete';
  readonly line: number;
  /** The line's text; absent for a deletion whose text the call did not carry. */
  readonly text?: string | undefined;
}

/** Changed lines kept for the preview; the UI shows fewer and counts the rest. */
export const FILE_DIFF_PREVIEW_ROWS = 12;
const FILE_DIFF_PREVIEW_CHARS = 200;

function splitPartLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * `fileDiffSummary` plus the first changed lines with their real line numbers
 * (old numbering for deletions, new numbering for additions), in one diff.
 *
 * Text privacy: added lines come from the call's own arguments (new_string /
 * content), so carrying them puts nothing new in the session log. Deleted
 * text is carried only when `deletedText` says the call's arguments held it
 * (Edit's old_string); otherwise a deletion keeps its line number alone, so an
 * overwrite never copies the replaced file into the log.
 */
export function fileDiffDetails(
  before: string,
  after: string,
  options: { readonly deletedText: boolean },
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
  const clip = (text: string): string =>
    text.length > FILE_DIFF_PREVIEW_CHARS ? `${text.slice(0, FILE_DIFF_PREVIEW_CHARS)}…` : text;
  for (const part of parts) {
    const lines = splitPartLines(part.value);
    if (part.added) {
      for (const text of lines) {
        if (preview.length < FILE_DIFF_PREVIEW_ROWS) preview.push({ kind: 'add', line: newLine, text: clip(text) });
        newLine += 1;
      }
      added += lines.length;
    } else if (part.removed) {
      for (const text of lines) {
        if (preview.length < FILE_DIFF_PREVIEW_ROWS) {
          preview.push({ kind: 'delete', line: oldLine, text: options.deletedText ? clip(text) : undefined });
        }
        oldLine += 1;
      }
      removed += lines.length;
    } else {
      oldLine += lines.length;
      newLine += lines.length;
    }
  }
  return { added, removed, preview, previewTotal: added + removed };
}
