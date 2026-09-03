/**
 * Pure helpers for the composer's @ file autocomplete.
 *
 * Behavior contract (mirrors the reference web client):
 * - @ triggers at line start or after whitespace (emails never trigger);
 * - entries are ranked with the scoreEntry ladder (exact / prefix / substring
 *   / path-substring / subsequence, directories +10);
 * - files complete to "@relative/path " (caret after the trailing space),
 *   directories complete to "@dir/" keeping the menu open for drill-down.
 */

export interface AtQueryMatch {
  /** Index of the "@" character in the text */
  start: number;
  /** Text typed after the "@" (quotes stripped); may be empty */
  query: string;
  /** True when the token uses the @"..." quoted form */
  quoted: boolean;
}

export interface FileEntryLite {
  /** Path relative to the working dir, "/"-separated, no trailing slash */
  path: string;
  isDir: boolean;
}

/**
 * Detect an @ file token immediately before the cursor. The @ must be at the
 * start of the text or preceded by whitespace, so emails like foo@bar never
 * trigger. Supports the in-progress quoted form @"my dir/fi so drill-down
 * into space-containing paths keeps working.
 */
export function extractAtQuery(textBeforeCursor: string): AtQueryMatch | null {
  const quoted = /(?:^|\s)@"([^"\n]*)$/.exec(textBeforeCursor);
  if (quoted) {
    return {
      start: textBeforeCursor.length - (quoted[1].length + 2),
      query: quoted[1],
      quoted: true,
    };
  }
  const plain = /(?:^|\s)@([^\s"]*)$/.exec(textBeforeCursor);
  if (plain) {
    return {
      start: textBeforeCursor.length - (plain[1].length + 1),
      query: plain[1],
      quoted: false,
    };
  }
  return null;
}

function pathDepth(p: string): number {
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '/') depth++;
  }
  return depth;
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Score ladder: exact 100 / prefix 80 / substring 50 / path substring 30,
 * directories +10, plus a low-weight subsequence fallback so genuinely fuzzy
 * queries still find deep files.
 *
 * Queries containing "/" are ranked against the full relative path instead of
 * the basename — this is what makes drill-down work: after inserting "@src/",
 * the query "src/" prefix-matches every entry inside src/.
 */
function scoreEntry(entry: FileEntryLite, lowerQuery: string): number {
  const lowerPath = entry.path.toLowerCase();
  let score = 0;
  if (lowerQuery.includes('/')) {
    if (lowerPath === lowerQuery) score = 100;
    else if (lowerPath.startsWith(lowerQuery)) score = 80;
    else if (lowerPath.includes(lowerQuery)) score = 50;
    else if (isSubsequence(lowerQuery, lowerPath)) score = 10;
  } else {
    const slash = lowerPath.lastIndexOf('/');
    const lowerName = slash === -1 ? lowerPath : lowerPath.slice(slash + 1);
    if (lowerName === lowerQuery) score = 100;
    else if (lowerName.startsWith(lowerQuery)) score = 80;
    else if (lowerName.includes(lowerQuery)) score = 50;
    else if (lowerPath.includes(lowerQuery)) score = 30;
    else if (isSubsequence(lowerQuery, lowerPath)) score = 10;
  }
  if (entry.isDir && score > 0) score += 10;
  return score;
}

export const AT_RESULT_LIMIT = 20;

export function filterFileEntries(
  entries: FileEntryLite[],
  query: string,
  limit: number = AT_RESULT_LIMIT,
): FileEntryLite[] {
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return entries.slice(0, limit);

  const scored: Array<{ entry: FileEntryLite; score: number }> = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, lowerQuery);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || pathDepth(a.entry.path) - pathDepth(b.entry.path)
    || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map((s) => s.entry);
}

export interface AtInsertion {
  /** Text that replaces the @token */
  text: string;
  /** Caret position relative to the start of `text` after insertion */
  cursorOffset: number;
}

/**
 * Replacement for the @token when a suggestion is confirmed:
 * - Files close the token: "@path " (quoted when the path contains spaces),
 *   caret after the trailing space.
 * - Directories keep the menu open for drill-down: "@dir/" with no trailing
 *   space. Quoted directories are inserted CLOSED (@"my dir/") with the caret
 *   placed before the closing quote, so both further typing and manual
 *   completion keep the token well-formed.
 */
export function buildAtInsertText(entryPath: string, isDir: boolean): AtInsertion {
  const p = isDir ? `${entryPath}/` : entryPath;
  const needsQuotes = p.includes(' ');
  if (isDir) {
    const text = needsQuotes ? `@"${p}"` : `@${p}`;
    return { text, cursorOffset: needsQuotes ? text.length - 1 : text.length };
  }
  const text = needsQuotes ? `@"${p}" ` : `@${p} `;
  return { text, cursorOffset: text.length };
}
