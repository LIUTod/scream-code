/**
 * Pieces of a file shown back to the model in the same shape Read uses
 * (`N<TAB>text`, 1-indexed), so old_string can be copied straight out of
 * them: the lines around an edit (Edit's result), the lines that changed
 * while the model was not looking (the changed-file notice), and a file put
 * back after compaction.
 */

import { diffLines } from 'diff';

/** `N<TAB>text` for lines `from`..`to` (1-indexed, inclusive) of a model view. */
export function numberedLines(lines: readonly string[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let line = Math.max(1, from); line <= Math.min(lines.length, to); line += 1) {
    out.push(`${String(line)}\t${lines[line - 1] ?? ''}`);
  }
  return out;
}

/** Physical lines of a model view, the way Read counts them (a final newline opens no line). */
export function viewLines(view: string): string[] {
  if (view.length === 0) return [];
  const lines = view.split('\n');
  if (view.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * The lines `start`..`end` of `view` (just written) with one line of context
 * on each side, at most `max` rows: a long span keeps its head and tail with
 * an elision between them. Undefined for an empty span.
 */
export function editSnippet(view: string, start: number, end: number, max = 8): string | undefined {
  const lines = viewLines(view);
  if (lines.length === 0) return undefined;
  const from = Math.max(1, start - 1);
  const to = Math.min(lines.length, Math.max(start, end) + 1);
  if (to < from) return undefined;
  if (to - from + 1 <= max) return numberedLines(lines, from, to).join('\n');
  const half = Math.floor((max - 1) / 2);
  return [
    ...numberedLines(lines, from, from + half - 1),
    `… (${String(to - from + 1 - half * 2)} more lines)`,
    ...numberedLines(lines, to - half + 1, to),
  ].join('\n');
}

/**
 * What changed between two model views, as the new file's lines around each
 * change (numbered like Read), with removed runs noted where they were. At
 * most `max` rows; undefined when nothing changed or the diff is too large
 * to be worth showing (the caller then just says the file changed).
 */
export function changedLinesSnippet(before: string, after: string, max = 40): string | undefined {
  if (before === after) return undefined;
  if (before.length > 1_000_000 || after.length > 1_000_000) return undefined;
  const parts = diffLines(before, after);
  const afterLines = viewLines(after);
  const out: string[] = [];
  let line = 1;
  let lastShown = 0;
  const show = (from: number, to: number): void => {
    for (let at = Math.max(from, lastShown + 1); at <= to && at <= afterLines.length; at += 1) {
      if (lastShown > 0 && at > lastShown + 1) out.push('…');
      out.push(`${String(at)}\t${afterLines[at - 1] ?? ''}`);
      lastShown = at;
    }
  };
  for (const part of parts) {
    const count = viewLines(part.value).length;
    if (part.added) {
      show(line - 1, line + count);
      line += count;
    } else if (part.removed) {
      show(line - 1, line);
      out.push(`(${String(count)} line${count === 1 ? '' : 's'} removed before line ${String(line)})`);
    } else {
      line += count;
    }
    if (out.length > max) break;
  }
  if (out.length === 0) return undefined;
  if (out.length > max) return [...out.slice(0, max), '… (more changes; Read the file for the rest)'].join('\n');
  return out.join('\n');
}
