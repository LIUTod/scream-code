/**
 * Detect unresolved git merge conflict markers in read output.
 *
 * Scans for well-formed `<<<<<<<` / `=======` / `>>>>>>>` blocks at column 0
 * and, when found, appends a notice to the read result so the model does not
 * silently edit a file with unresolved conflicts.
 *
 * Marker shape is strict (ported from oh-my-pi `conflict-detect.ts:171-176`):
 * prefix alone, or prefix + single space + label. Lines that merely start
 * with `<` or `=` never match. Only fully-closed blocks (opener + separator
 * + closer all present in the scanned window) are reported — an open block
 * whose closer is past the read window is dropped so the agent can widen the
 * read instead of being told about a half-seen conflict.
 */

const OURS_PREFIX = '<<<<<<<';
const BASE_PREFIX = '|||||||';
const SEPARATOR = '=======';
const THEIRS_PREFIX = '>>>>>>>';

export interface ConflictBlock {
  /** 1-indexed line of the `<<<<<<<` marker. */
  readonly startLine: number;
  /** 1-indexed line of the `=======` separator. */
  readonly separatorLine: number;
  /** 1-indexed line of the `>>>>>>>` marker. */
  readonly endLine: number;
  /** 1-indexed line of the `|||||||` base marker (diff3 only). */
  readonly baseLine?: number;
}

/**
 * Return the label after a marker prefix when the line is a valid column-0
 * marker, or `null` when it isn't. Strict shape: prefix alone, or prefix +
 * single space + label.
 */
function matchMarker(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  if (line.length === prefix.length) return '';
  if (line.codePointAt(prefix.length) !== 32) return null;
  return line.slice(prefix.length + 1);
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Scan an already-collected array of file lines for completed conflict blocks.
 * `firstLineNumber` is the 1-indexed line number of `lines[0]`.
 */
export function scanConflictLines(
  lines: readonly string[],
  firstLineNumber: number = 1,
): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let phase: 'idle' | 'ours' | 'base' | 'theirs' = 'idle';
  let partial: {
    startLine: number;
    baseLine?: number;
    separatorLine?: number;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingCr(lines[i]!);
    const ln = firstLineNumber + i;

    if (matchMarker(line, OURS_PREFIX) !== null) {
      partial = { startLine: ln };
      phase = 'ours';
      continue;
    }

    if (phase === 'idle' || partial === null) continue;

    if (matchMarker(line, BASE_PREFIX) !== null) {
      if (phase !== 'ours') {
        partial = null;
        phase = 'idle';
        continue;
      }
      partial.baseLine = ln;
      phase = 'base';
      continue;
    }

    if (line === SEPARATOR) {
      if (phase === 'ours' || phase === 'base') {
        partial.separatorLine = ln;
        phase = 'theirs';
      } else {
        partial = null;
        phase = 'idle';
      }
      continue;
    }

    if (matchMarker(line, THEIRS_PREFIX) !== null) {
      if (phase === 'theirs' && partial.separatorLine !== undefined) {
        blocks.push({
          startLine: partial.startLine,
          separatorLine: partial.separatorLine,
          endLine: ln,
          baseLine: partial.baseLine,
        });
      }
      partial = null;
      phase = 'idle';
      continue;
    }
  }

  return blocks;
}

/**
 * Format the conflict notice appended to read output. Returns an empty
 * string when there are no blocks so callers can skip the append entirely.
 */
export function formatConflictNotice(blocks: readonly ConflictBlock[]): string {
  if (blocks.length === 0) return '';
  const list = blocks
    .map((b) => `lines ${String(b.startLine)}-${String(b.endLine)}`)
    .join(', ');
  return `⚠ ${String(blocks.length)} unresolved merge conflict(s) detected: ${list}`;
}
