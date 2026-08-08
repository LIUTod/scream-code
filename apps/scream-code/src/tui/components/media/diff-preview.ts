/**
 * Diff preview rendering as plain ANSI strings.
 *
 * Reuses the diff algorithm from approval/DiffPreview.tsx, but outputs
 * formatted text lines instead of React elements.
 */

import chalk from 'chalk';
import { diffWords } from 'diff';

import type { ColorPalette } from '#/tui/theme/colors';
import { highlightLines, langFromPath } from './code-highlight';

export type DiffLineKind = 'context' | 'add' | 'delete';

interface DiffStyles {
  add: (s: string) => string;
  del: (s: string) => string;
  addBold: (s: string) => string;
  delBold: (s: string) => string;
  gutter: (s: string) => string;
  meta: (s: string) => string;
}

function makeDiffStyles(colors: ColorPalette): DiffStyles {
  return {
    add: (s) => chalk.hex(colors.diffAdded)(s),
    del: (s) => chalk.hex(colors.diffRemoved)(s),
    addBold: (s) => chalk.bold.hex(colors.diffAddedStrong)(s),
    delBold: (s) => chalk.bold.hex(colors.diffRemovedStrong)(s),
    gutter: (s) => chalk.hex(colors.diffGutter)(s),
    meta: (s) => chalk.hex(colors.diffMeta)(s),
  };
}

const ANSI_RE = /\u001B\[[0-9;]*m/;
const ANSI_RESET_RE = /\u001B\[(?:0|39)m/g;

/**
 * Extract the leading ANSI SGR prefix a chalk-style color function applies,
 * e.g. `\x1b[38;2;121;235;0m` for a truecolor hex. Returns `''` when the
 * function emits no color (chalk level 0 / non-color environment).
 */
function extractAnsiPrefix(fn: (s: string) => string): string {
  const sentinel = '\u0000';
  const styled = fn(sentinel);
  const idx = styled.indexOf(sentinel);
  return idx >= 0 ? styled.slice(0, idx) : '';
}

/** Visualize leading whitespace: tabs as `->`, leading spaces as `·`. */
function visualizeIndent(line: string): { text: string; indentEnd: number } {
  let i = 0;
  let visual = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\t') {
      visual += '->';
      i++;
      continue;
    }
    if (ch === ' ') {
      visual += '·';
      i++;
      continue;
    }
    break;
  }
  return { text: visual + line.slice(i), indentEnd: visual.length };
}

/**
 * Render a diff line's code with leading-whitespace visualization (tabs as
 * `->`, spaces as `·`, dimmed) and optional syntax highlighting. Indent
 * visualization runs on the raw code FIRST, then highlighting runs on the
 * stripped remainder: once the text is ANSI-tinted (the theme's `default`
 * color wraps whitespace too), a leading tab is no longer the first raw
 * character and would be missed. The dimmed indent itself carries no token
 * color.
 *
 * When highlighting is on and produced token colors, the diff line color is
 * layered as the base foreground: syntax tokens override it, but every ANSI
 * reset re-injects the diff color so non-token spans (punctuation, operators,
 * whitespace) stay green/red instead of falling back to the terminal default.
 * When highlighting is off (streaming) or produced no token colors, the code
 * part is colored with the diff line color instead.
 */
function renderDiffCode(
  code: string,
  colorFn: (s: string) => string,
  highlight: boolean,
  lang: string | undefined,
  colors: ColorPalette,
): string {
  // Visualize leading tabs/spaces BEFORE syntax highlighting: once the text
  // is ANSI-tinted (the theme's `default` color wraps whitespace too), the
  // leading tab is no longer the first raw character and visualizeIndent
  // would miss it. Order matters here.
  const { text, indentEnd } = visualizeIndent(code);
  const indent = text.slice(0, indentEnd);
  const rest = text.slice(indentEnd);
  const dimIndent = indent.length > 0 ? chalk.dim(indent) : indent;
  const source = highlight ? (highlightLines(rest, lang, colors)[0] ?? rest) : rest;
  if (highlight && ANSI_RE.test(source)) {
    // Layer the diff color as the base foreground: syntax tokens override it,
    // but every ANSI reset re-injects the diff color so non-token spans
    // (punctuation, operators, whitespace) stay green/red instead of falling
    // back to the terminal default. Function-form replace avoids any risk of
    // `$` pattern interpretation in the prefix string.
    // Note: colorFn must be a foreground-only chalk function (e.g. chalk.hex).
    // Compound functions (chalk.bold.hex) would leave non-foreground attributes
    // un-reset by the trailing \x1b[39m.
    const prefix = extractAnsiPrefix(colorFn);
    if (prefix.length > 0) {
      return dimIndent + prefix + source.replace(ANSI_RESET_RE, (m) => m + prefix) + '\u001B[39m';
    }
    return dimIndent + source;
  }
  return dimIndent + colorFn(source);
}

/**
 * Compute word-level diff between two single lines and highlight the changed
 * words with `chalk.inverse()`. Only the first removed/added part has its
 * leading whitespace stripped, so indentation isn't highlighted.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/modes/components/diff.ts:55-95`.
 * Returns the two lines with inline inverse highlighting applied; caller wraps
 * them in the usual add/del gutter + line color.
 */
function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
): { removedLine: string; addedLine: string } {
  const wordDiff = diffWords(oldContent, newContent);

  let removedLine = '';
  let addedLine = '';
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] ?? '';
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) removedLine += chalk.inverse(value);
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] ?? '';
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) addedLine += chalk.inverse(value);
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }

  return { removedLine, addedLine };
}

/**
 * Check whether a delete line at index `i` and an add line at index `i+1`
 * form an isolated single-line replacement — the only case where intra-line
 * word diff is meaningful. We require both sides to be single-line blocks
 * (prev of delete is not delete; next of add is not add) so multi-line
 * delete/add blocks stay as whole-line coloring.
 */
function isIsolatedSingleLinePair(lines: DiffLine[], i: number): boolean {
  const curr = lines[i];
  const next = lines[i + 1];
  if (curr === undefined || next === undefined) return false;
  if (curr.kind !== 'delete' || next.kind !== 'add') return false;
  const prev = lines[i - 1];
  if (prev !== undefined && prev.kind === 'delete') return false;
  const after = lines[i + 2];
  if (after !== undefined && after.kind === 'add') return false;
  return true;
}

export interface DiffLine {
  kind: DiffLineKind;
  lineNum: number;
  code: string;
}

export function computeDiffLines(
  oldText: string,
  newText: string,
  oldStart: number = 1,
  newStart: number = 1,
  isIncomplete: boolean = false,
): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const reversed: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({ kind: 'context', lineNum: newStart + j - 1, code: newLines[j - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      reversed.push({ kind: 'add', lineNum: newStart + j - 1, code: newLines[j - 1]! });
      j--;
    } else {
      reversed.push({ kind: 'delete', lineNum: oldStart + i - 1, code: oldLines[i - 1]! });
      i--;
    }
  }

  const result: DiffLine[] = [];
  for (let k = reversed.length - 1; k >= 0; k--) {
    result.push(reversed[k]!);
  }

  // While the text is still streaming, suppress trailing delete lines.
  // They are likely artefacts of newText not having arrived yet rather
  // than genuine deletions.
  if (isIncomplete && result.length > 0) {
    let lastNonDelete = result.length - 1;
    while (lastNonDelete >= 0 && result[lastNonDelete]!.kind === 'delete') {
      lastNonDelete--;
    }
    if (lastNonDelete >= 0) {
      result.length = lastNonDelete + 1;
    } else {
      // Every line would be shown as deleted; suppress them all so the
      // UI doesn't flash a wall of red before newText starts arriving.
      result.length = 0;
    }
  }

  return result;
}

export function renderDiffLines(
  oldText: string,
  newText: string,
  path: string,
  colors: ColorPalette,
  isIncomplete: boolean = false,
  oldStart?: number,
  newStart?: number,
  maxLines?: number,
): string[] {
  const s = makeDiffStyles(colors);
  const lang = langFromPath(path);
  const doHighlight = !isIncomplete && lang !== undefined;
  const diffLines = computeDiffLines(oldText, newText, oldStart ?? 1, newStart ?? 1, isIncomplete);
  const changedLines = diffLines.filter((l) => l.kind !== 'context');
  const added = changedLines.filter((l) => l.kind === 'add').length;
  const removed = changedLines.filter((l) => l.kind === 'delete').length;

  const output: string[] = [];

  let header = '';
  if (added > 0) header += s.addBold(`+${String(added)} `);
  if (removed > 0) header += s.delBold(`-${String(removed)} `);
  header += path;
  output.push(header);

  const shown =
    maxLines !== undefined && maxLines >= 0 && changedLines.length > maxLines
      ? changedLines.slice(0, maxLines)
      : changedLines;

  let i = 0;
  while (i < shown.length) {
    if (isIsolatedSingleLinePair(shown, i)) {
      const line = shown[i]!;
      const next = shown[i + 1]!;
      const { removedLine, addedLine } = renderIntraLineDiff(line.code, next.code);
      output.push(s.gutter(String(line.lineNum).padStart(4) + ' ') + s.del('- ' + removedLine));
      output.push(s.gutter(String(next.lineNum).padStart(4) + ' ') + s.add('+ ' + addedLine));
      i += 2;
      continue;
    }
    const line = shown[i]!;
    const marker = line.kind === 'add' ? '+' : '-';
    const color = line.kind === 'add' ? s.add : s.del;
    output.push(
      s.gutter(String(line.lineNum).padStart(4) + ' ') +
        color(`${marker} `) +
        renderDiffCode(line.code, color, doHighlight, lang, colors),
    );
    i += 1;
  }

  const hidden = changedLines.length - shown.length;
  if (hidden > 0) {
    output.push(
      s.meta(
        `     … ${String(hidden)} more change${hidden > 1 ? 's' : ''} hidden (ctrl+o to expand)`,
      ),
    );
  }

  return output;
}

export interface ClusteredDiffOptions {
  readonly contextLines?: number;
  readonly maxLines?: number;
  readonly isIncomplete?: boolean;
  readonly expandKeyHint?: string;
}

interface Cluster {
  readonly start: number;
  readonly end: number;
}

function buildClusters(
  diffLines: DiffLine[],
  contextLines: number,
): { clusters: Cluster[]; changedCount: number; addedCount: number; removedCount: number } {
  const changeIndices: number[] = [];
  let added = 0;
  let removed = 0;
  for (const [i, line] of diffLines.entries()) {
    if (line.kind === 'add') {
      added++;
      changeIndices.push(i);
    } else if (line.kind === 'delete') {
      removed++;
      changeIndices.push(i);
    }
  }

  const clusters: Cluster[] = [];
  if (changeIndices.length === 0) {
    return { clusters, changedCount: 0, addedCount: added, removedCount: removed };
  }

  const mergeGap = 2 * contextLines;
  let groupStart = changeIndices[0]!;
  let groupEnd = changeIndices[0]!;
  for (let i = 1; i < changeIndices.length; i++) {
    const idx = changeIndices[i]!;
    if (idx - groupEnd <= mergeGap) {
      groupEnd = idx;
    } else {
      clusters.push({
        start: Math.max(0, groupStart - contextLines),
        end: Math.min(diffLines.length - 1, groupEnd + contextLines),
      });
      groupStart = idx;
      groupEnd = idx;
    }
  }
  clusters.push({
    start: Math.max(0, groupStart - contextLines),
    end: Math.min(diffLines.length - 1, groupEnd + contextLines),
  });

  return {
    clusters,
    changedCount: changeIndices.length,
    addedCount: added,
    removedCount: removed,
  };
}

function formatDiffRow(
  line: DiffLine,
  s: DiffStyles,
  doHighlight: boolean,
  lang: string | undefined,
  colors: ColorPalette,
): string {
  const gutter = s.gutter(String(line.lineNum).padStart(4) + ' ');
  if (line.kind === 'add') {
    return gutter + s.add('+ ') + renderDiffCode(line.code, s.add, doHighlight, lang, colors);
  }
  if (line.kind === 'delete') {
    return gutter + s.del('- ') + renderDiffCode(line.code, s.del, doHighlight, lang, colors);
  }
  return gutter + '  ' + renderDiffCode(line.code, (x) => x, doHighlight, lang, colors);
}

/**
 * Render a diff with surrounding context, eliding unchanged middle
 * regions between change clusters with a `… N unchanged lines …`
 * separator. When `maxLines` is set, the body is capped at a cluster
 * boundary and a `ctrl+o to expand` footer is appended.
 *
 * Used by Edit's call preview where we want to show *what changed*
 * with enough context to read the change, but not the whole file.
 */
export function renderDiffLinesClustered(
  oldText: string,
  newText: string,
  path: string,
  colors: ColorPalette,
  opts: ClusteredDiffOptions = {},
): string[] {
  const s = makeDiffStyles(colors);
  const lang = langFromPath(path);
  const doHighlight = !(opts.isIncomplete ?? false) && lang !== undefined;
  const contextLines = opts.contextLines ?? 3;
  const maxLines = opts.maxLines;
  const diffLines = computeDiffLines(oldText, newText, 1, 1, opts.isIncomplete ?? false);
  const { clusters, changedCount, addedCount, removedCount } = buildClusters(
    diffLines,
    contextLines,
  );

  const output: string[] = [];
  let header = '';
  if (addedCount > 0) header += s.addBold(`+${String(addedCount)} `);
  if (removedCount > 0) header += s.delBold(`-${String(removedCount)} `);
  header += path;
  output.push(header);

  if (clusters.length === 0) return output;

  const cap = maxLines !== undefined && maxLines >= 0 ? maxLines : Number.POSITIVE_INFINITY;
  let body = 0;
  let prevEnd = -1;
  let truncated = false;
  let shownChanges = 0;

  outer: for (const cluster of clusters) {
    if (body >= cap) {
      truncated = true;
      break;
    }
    if (prevEnd >= 0) {
      const gap = cluster.start - prevEnd - 1;
      if (gap > 0) {
        if (body + 1 > cap) {
          truncated = true;
          break;
        }
        output.push(s.meta(`     … ${String(gap)} unchanged line${gap > 1 ? 's' : ''} …`));
        body++;
      }
    }
    // Emit cluster rows one at a time; allow mid-cluster truncation so
    // a single huge cluster (e.g. the whole file replaced inline) still
    // shows the leading lines instead of degenerating to "N changes
    // hidden" with no body at all.
    let i = cluster.start;
    while (i <= cluster.end) {
      if (body >= cap) {
        truncated = true;
        break outer;
      }
      const line = diffLines[i]!;
      if (i + 1 <= cluster.end && isIsolatedSingleLinePair(diffLines, i)) {
        const next = diffLines[i + 1]!;
        const { removedLine, addedLine } = renderIntraLineDiff(line.code, next.code);
        output.push(s.gutter(String(line.lineNum).padStart(4) + ' ') + s.del('- ' + removedLine));
        body++;
        if (body >= cap) {
          truncated = true;
          prevEnd = i;
          break outer;
        }
        output.push(s.gutter(String(next.lineNum).padStart(4) + ' ') + s.add('+ ' + addedLine));
        body++;
        shownChanges += 2;
        prevEnd = i + 1;
        i += 2;
        continue;
      }
      output.push(formatDiffRow(line, s, doHighlight, lang, colors));
      body++;
      if (line.kind !== 'context') shownChanges++;
      prevEnd = i;
      i += 1;
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges;
    if (hidden > 0) {
      const hint = opts.expandKeyHint ?? 'ctrl+o';
      output.push(
        s.meta(
          `     … ${String(hidden)} more change${hidden > 1 ? 's' : ''} hidden (${hint} to expand)`,
        ),
      );
    }
  }

  return output;
}
