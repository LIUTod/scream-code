// Simple LCS-based line diff for tool edit previews.
// O(m*n) - fine for typical edits (< 500 lines). Falls back to naive
// old=del/new=add for very large inputs.

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_LCS_LINES = 500;

function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function backtrack(
  dp: number[][],
  a: readonly string[],
  b: readonly string[],
  i: number,
  j: number,
): DiffLine[] {
  const result: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'context', text: a[i - 1]!, oldNo: i, newNo: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j]!)) {
      result.unshift({ type: 'add', text: b[j - 1]!, newNo: j });
      j--;
    } else {
      result.unshift({ type: 'del', text: a[i - 1]!, oldNo: i });
      i--;
    }
  }
  return result;
}

/** Parse a unified git patch (`@@ -a,b +c,d @@ ...`) into DiffLine[]. */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      const text = line.startsWith('@@')
        ? line.slice(line.indexOf('@@') + 2, line.lastIndexOf('@@') || line.length)
        : '';
      out.push({ type: 'context', text: text.trim() ? `@@ hunk ${oldNo},${newNo} @@` : line, oldNo, newNo });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      // File headers keep as context (line numbers unchanged).
      out.push({ type: 'context', text: line, oldNo, newNo });
      continue;
    }
    if (line.startsWith('+')) {
      newNo += 1;
      out.push({ type: 'add', text: line.slice(1), newNo });
    } else if (line.startsWith('-')) {
      oldNo += 1;
      out.push({ type: 'del', text: line.slice(1), oldNo });
    } else {
      oldNo += 1;
      newNo += 1;
      out.push({ type: 'context', text: line, oldNo, newNo });
    }
  }
  return out;
}

/** Compute a line-by-line diff between two strings. */
export function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // For very large inputs, skip LCS and just show old=del / new=add.
  if (oldLines.length + newLines.length > MAX_LCS_LINES) {
    const result: DiffLine[] = [];
    oldLines.forEach((line, i) => result.push({ type: 'del', text: line, oldNo: i + 1 }));
    newLines.forEach((line, i) => result.push({ type: 'add', text: line, newNo: i + 1 }));
    return result;
  }

  const dp = lcsTable(oldLines, newLines);
  return backtrack(dp, oldLines, newLines, oldLines.length, newLines.length);
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'del') removed++;
  }
  return { added, removed };
}

// ── Tool arg extraction ──────────────────────────────────────────────────

const OLD_FIELDS = ['old_string', 'oldString', 'old_str', 'old_text', 'oldText', 'old', 'search'];
const NEW_FIELDS = ['new_string', 'newString', 'new_str', 'new_text', 'newText', 'new', 'replace', 'content'];
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'file', 'filename'];

function extractField(args: Record<string, unknown>, fields: string[]): string | undefined {
  for (const f of fields) {
    const v = args[f];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export interface EditDiffResult {
  path: string | undefined;
  diff: DiffLine[];
  stats: DiffStats;
}

/** Try to build a diff from tool arguments (edit/write/replace tools). */
export function buildEditDiff(args: unknown): EditDiffResult | null {
  if (!args || typeof args !== 'object') return null;
  const obj = args as Record<string, unknown>;

  const path = extractField(obj, PATH_FIELDS);
  const oldStr = extractField(obj, OLD_FIELDS);
  const newStr = extractField(obj, NEW_FIELDS);

  // Need at least new content to show anything.
  if (!newStr && !oldStr) return null;

  const diff = computeDiff(oldStr ?? '', newStr ?? '');
  const stats = diffStats(diff);

  return { path, diff, stats };
}
