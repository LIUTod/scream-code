/**
 * The change an Edit / Write made, drawn the same way in both states of the
 * activity block: folded, the changed lines under the row; expanded (Ctrl+O),
 * the same lines plus the unchanged lines around them and the gaps between
 * them. One row is `number sign text`:
 *
 *    42 - const a = 1;        removed, on a red band
 *    42 + const a = 10;       added, on a green band
 *    43   const b = 2;        unchanged (expanded only), no band, dimmed
 *         … 5 unchanged lines …
 *
 * Code is syntax-highlighted. When a line was replaced by one other line, the
 * words that changed sit on a deeper band in bold. Below 256 colours there
 * are no bands: only the sign and the highlighting carry the change.
 *
 * Rows come from the tool's `file_diff` display (agent-core
 * `fileDiffDetails`), which a resumed session gets back with the tool result:
 * real file line numbers, and text only where the call's own arguments
 * carried it (a Write overwrite keeps its removed lines as "N lines removed").
 * A record from before that display existed falls back to the Edit's own
 * strings, without line numbers in either state; a Write without one shows
 * nothing rather than a guess.
 */

import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';
import { diffWords } from 'diff';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { computeDiffLines } from '#/tui/components/media/diff-preview';
import type { ColorPalette } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { replaceTabs, sanitizeShellOutput } from '#/tui/utils/sanitize';

export interface ChangeRow {
  /** `file`: the name of the file the rows after it belong to (a command that changed several). */
  readonly kind: 'add' | 'delete' | 'context' | 'gap' | 'file';
  /** File line number; absent for a record without the display. */
  readonly line?: number | undefined;
  /** Line text; absent for a deletion the call did not carry. */
  readonly text?: string | undefined;
  /** `gap` only: unchanged lines it stands for. */
  readonly count?: number | undefined;
}

export interface FileChange {
  readonly rows: readonly ChangeRow[];
  /** Changed lines in all; more than the changed rows when the list was capped. */
  readonly total: number;
  /** Highlighting language, from the file's extension. */
  readonly lang: string | undefined;
}

/** Folded: the changed lines only. Expanded: with the unchanged lines around them. */
export type ChangeView = 'folded' | 'expanded';

const CHANGE_TOOLS = new Set(['Edit', 'Write']);
/** Unchanged lines kept on each side of a change when the rows come from the call. */
const CONTEXT_LINES = 3;
/** A replaced line whose words changed past this share reads better unmarked. */
const WORD_MARK_MAX_SHARE = 0.6;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The change of a finished, successful Edit / Write — or of a shell command
 * that changed files the agent had read or edited — or undefined.
 */
export function fileChangeOf(
  toolCall: Readonly<ToolCallBlockData>,
  result: Readonly<ToolResultBlockData> | undefined,
): FileChange | undefined {
  if (result === undefined || result.is_error === true) return undefined;
  if (result.display?.kind === 'file_changes') return shellChangeOf(result.display.files);
  if (!CHANGE_TOOLS.has(toolCall.name)) return undefined;
  const lang = langFromPath(str(toolCall.args['file_path'] ?? toolCall.args['path']));
  const display = result.display;
  if (display?.kind === 'file_diff' && display.preview !== undefined) {
    if (!display.preview.some((row) => row.kind === 'add' || row.kind === 'delete')) return undefined;
    const changed = display.preview.filter((row) => row.kind === 'add' || row.kind === 'delete').length;
    return { rows: display.preview, total: display.previewTotal ?? changed, lang };
  }
  // A record from before the display: an Edit's own strings still say what
  // changed, only not where.
  if (toolCall.name !== 'Edit') return undefined;
  const rows = rowsFromStrings(str(toolCall.args['old_string']), str(toolCall.args['new_string']));
  const total = rows.filter((row) => row.kind === 'add' || row.kind === 'delete').length;
  return total === 0 ? undefined : { rows, total, lang };
}

type ShellChangedFile = Extract<NonNullable<ToolResultBlockData['display']>, { kind: 'file_changes' }>['files'][number];

/** Every file a command changed, each under a row naming it. */
function shellChangeOf(files: readonly ShellChangedFile[]): FileChange | undefined {
  const rows: ChangeRow[] = [];
  let total = 0;
  for (const file of files) {
    const preview = file.preview ?? [];
    if (!preview.some((row) => row.kind === 'add' || row.kind === 'delete')) continue;
    rows.push({ kind: 'file', text: file.path }, ...preview);
    total += file.previewTotal ?? preview.filter((row) => row.kind === 'add' || row.kind === 'delete').length;
  }
  return total === 0 ? undefined : { rows, total, lang: undefined };
}

/** Changed lines of two strings plus the unchanged ones around them, unnumbered. */
function rowsFromStrings(oldText: string, newText: string): ChangeRow[] {
  if (oldText.length === 0 && newText.length === 0) return [];
  const lines = computeDiffLines(oldText, newText);
  const near = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let at = index - CONTEXT_LINES; at <= index + CONTEXT_LINES; at += 1) near.add(at);
  });
  const rows: ChangeRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (line.kind === 'context' && !near.has(index)) {
      skipped += 1;
      return;
    }
    if (skipped > 0 && rows.length > 0) rows.push({ kind: 'gap', count: skipped });
    skipped = 0;
    rows.push({ kind: line.kind, text: line.code });
  });
  return rows;
}

/** One drawn row: a line, a run of removed lines whose text is unknown, a gap or the count. */
interface DrawRow {
  readonly kind: 'add' | 'delete' | 'context' | 'gap' | 'more' | 'file';
  /** Highlighting language of the row's file. */
  readonly lang?: string | undefined;
  readonly line: number | undefined;
  readonly text: string | undefined;
  /** Removed lines folded into this row (text-less runs), gap size, or lines left out. */
  readonly count: number;
  /** Changed words of a one-line replacement (plain-text ranges of the cleaned line). */
  readonly marks?: readonly (readonly [number, number])[] | undefined;
}

/**
 * Word marks of every one-line replacement, by row index. Paired on the full
 * list (context included), so the folded view, which hides the context,
 * marks exactly the words the expanded view marks.
 */
function replacementMarks(rows: readonly ChangeRow[]): Map<number, readonly (readonly [number, number])[]> {
  const marks = new Map<number, readonly (readonly [number, number])[]>();
  rows.forEach((row, at) => {
    const next = rows[at + 1];
    if (row.kind !== 'delete' || next?.kind !== 'add') return;
    if (row.text === undefined || next.text === undefined) return;
    // Only an isolated pair: inside a longer run, lines do not pair up one to one.
    if (rows[at - 1]?.kind === 'delete' || rows[at + 2]?.kind === 'add') return;
    const words = changedWords(clean(row.text), clean(next.text));
    if (words === undefined) return;
    marks.set(at, words.removed);
    marks.set(at + 1, words.added);
  });
  return marks;
}

function drawRows(change: FileChange, view: ChangeView): DrawRow[] {
  const out: DrawRow[] = [];
  const marks = replacementMarks(change.rows);
  let lang = change.lang;
  for (const [index, row] of change.rows.entries()) {
    if (row.kind === 'file') {
      lang = langFromPath(row.text ?? '');
      out.push({ kind: 'file', line: undefined, text: row.text, count: 0, lang });
      continue;
    }
    if (view === 'folded' && (row.kind === 'context' || row.kind === 'gap')) continue;
    if (row.kind === 'gap') {
      // Folded rows skip context, so two gaps can meet in the expanded list
      // only when the display itself was odd; merge them anyway.
      const last = out.at(-1);
      if (last?.kind === 'gap') out[out.length - 1] = { ...last, count: last.count + (row.count ?? 0) };
      else out.push({ kind: 'gap', line: undefined, text: undefined, count: row.count ?? 0 });
      continue;
    }
    const last = out.at(-1);
    if (row.kind === 'delete' && row.text === undefined && last?.kind === 'delete' && last.text === undefined) {
      out[out.length - 1] = { ...last, count: last.count + 1 };
      continue;
    }
    out.push({ kind: row.kind, line: row.line, text: row.text, count: 1, marks: marks.get(index), lang });
  }
  return out;
}

function changedIn(rows: readonly DrawRow[]): number {
  return rows.reduce((sum, row) => sum + (row.kind === 'add' || row.kind === 'delete' ? row.count : 0), 0);
}

/** At most `limit` rows, plus one counting what was left out. */
function layout(change: FileChange, view: ChangeView, limit: number): DrawRow[] {
  if (limit <= 0) return [];
  const all = drawRows(change, view);
  const allChanged = changedIn(all);
  const fits = all.length <= limit && change.total <= allChanged;
  if (fits) return all;
  const shown = all.slice(0, limit);
  // A cut never ends on an unchanged line: the count row says what follows.
  while (
    shown.length > 1 &&
    (shown.at(-1)?.kind === 'gap' || shown.at(-1)?.kind === 'context' || shown.at(-1)?.kind === 'file')
  ) {
    shown.pop();
  }
  const remaining = Math.max(0, change.total - changedIn(shown));
  return remaining > 0 ? [...shown, { kind: 'more', line: undefined, text: undefined, count: remaining }] : shown;
}

/** Rows `renderFileChange` draws for this change at `limit` (count row included). */
export function changeRowCount(change: FileChange, view: ChangeView, limit: number): number {
  return layout(change, view, limit).length;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

const SGR_RE = /\u001B\[([0-9;]*)m/y;

/** The opening SGR sequence a chalk style emits ('' when colour is off). */
function openOf(style: (text: string) => string): string {
  const styled = style('\u0000');
  const at = styled.indexOf('\u0000');
  return at > 0 ? styled.slice(0, at) : '';
}

/**
 * What an SGR sequence turns off: the background (a full reset or 49) and
 * bold (a full reset or 22). Extended colours (`38;2;r;g;b`, `48;5;n`) are
 * skipped whole, so a `0` inside an RGB value is not read as a reset.
 */
function sgrResets(params: string): { readonly background: boolean; readonly bold: boolean } {
  if (params === '') return { background: true, bold: true };
  const list = params.split(';');
  let background = false;
  let bold = false;
  for (let index = 0; index < list.length; index += 1) {
    const param = list[index];
    if (param === '38' || param === '48' || param === '58') {
      index += list[index + 1] === '5' ? 2 : 4;
      continue;
    }
    if (param === '0' || param === '') {
      background = true;
      bold = true;
    } else if (param === '49') background = true;
    else if (param === '22') bold = true;
  }
  return { background, bold };
}

/**
 * Puts `text` (already coloured) on a background band: the band is opened at
 * the start and re-opened after anything that resets it, and the `marks`
 * (plain-text ranges) sit on `markOpen` in bold instead.
 */
function onBand(text: string, bandOpen: string, marks: readonly (readonly [number, number])[], markOpen: string): string {
  if (bandOpen === '' && marks.length === 0) return text;
  const boldOpen = '\u001B[1m';
  const boldClose = '\u001B[22m';
  let out = bandOpen;
  let plain = 0;
  let inMark = false;
  const markAt = (at: number): boolean => marks.some(([start, end]) => at >= start && at < end);
  const current = (): string => (inMark ? markOpen + boldOpen : bandOpen);
  let index = 0;
  while (index < text.length) {
    SGR_RE.lastIndex = index;
    const sgr = SGR_RE.exec(text);
    if (sgr !== null) {
      out += sgr[0];
      const resets = sgrResets(sgr[1] ?? '');
      if (resets.background) out += current();
      else if (inMark && resets.bold) out += boldOpen;
      index = SGR_RE.lastIndex;
      continue;
    }
    const wanted = markAt(plain);
    if (wanted !== inMark) {
      inMark = wanted;
      out += inMark ? markOpen + boldOpen : boldClose + bandOpen;
    }
    const size = (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    out += text.slice(index, index + size);
    index += size;
    plain += size;
  }
  if (inMark) out += boldClose + bandOpen;
  return out;
}

/** One line of code, cleaned for the terminal. */
function clean(text: string): string {
  return sanitizeShellOutput(replaceTabs(text)).replaceAll(/[\r\n]+/g, ' ');
}

const highlightCache = new WeakMap<ColorPalette, Map<string, string>>();
const HIGHLIGHT_CACHE_SIZE = 1000;

/** `text` highlighted as `lang`, cached: a block repaints its rows on every throttled tick. */
function highlight(text: string, lang: string | undefined, colors: ColorPalette): string {
  if (lang === undefined || text.trim().length === 0) return text;
  let cache = highlightCache.get(colors);
  if (cache === undefined) {
    cache = new Map();
    highlightCache.set(colors, cache);
  }
  const key = `${lang}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.size >= HIGHLIGHT_CACHE_SIZE) cache.clear();
  const painted = highlightLines(text, lang, colors)[0] ?? text;
  cache.set(key, painted);
  return painted;
}

/**
 * Word ranges a one-line replacement changed, for the removed and the added
 * line. Undefined when most of the line changed: marking it all says nothing.
 */
function changedWords(
  removed: string,
  added: string,
): { removed: [number, number][]; added: [number, number][] } | undefined {
  const parts = diffWords(removed, added);
  const marks = { removed: [] as [number, number][], added: [] as [number, number][] };
  let removedAt = 0;
  let addedAt = 0;
  for (const part of parts) {
    const value = part.value;
    // Leading whitespace of a changed run is indentation, not a change.
    const lead = /^\s*/.exec(value)?.[0].length ?? 0;
    if (part.removed) {
      if (value.length > lead) marks.removed.push([removedAt + lead, removedAt + value.length]);
      removedAt += value.length;
    } else if (part.added) {
      if (value.length > lead) marks.added.push([addedAt + lead, addedAt + value.length]);
      addedAt += value.length;
    } else {
      removedAt += value.length;
      addedAt += value.length;
    }
  }
  const share = (ranges: [number, number][], length: number): number =>
    length === 0 ? 1 : ranges.reduce((sum, [start, end]) => sum + end - start, 0) / length;
  if (share(marks.removed, removed.length) > WORD_MARK_MAX_SHARE || share(marks.added, added.length) > WORD_MARK_MAX_SHARE) {
    return undefined;
  }
  return marks;
}

/**
 * The change as rows of exactly `width` columns, without the tree prefix (the
 * caller adds it). At most `limit` rows plus one counting what was left out;
 * `limit` ≤ 0 → no rows.
 */
export function renderFileChange(
  change: FileChange,
  view: ChangeView,
  limit: number,
  width: number,
  colors: ColorPalette,
): string[] {
  const rows = layout(change, view, limit);
  if (rows.length === 0) return [];
  const numbered = rows.some((row) => row.line !== undefined);
  const numberWidth = numbered ? Math.max(3, ...rows.map((row) => String(row.line ?? '').length)) : 0;
  const lead = numbered ? ' '.repeat(numberWidth + 1) : '';
  const bands = chalk.level >= 2;
  const rowWidth = Math.max(1, width);
  const dim = chalk.hex(colors.textDim);

  return rows.map((row) => {
    if (row.kind === 'more') {
      return truncateToWidth(dim(` ${lead}${t('activitygroup.edit_more', { count: String(row.count) })}`), rowWidth, '…');
    }
    if (row.kind === 'gap') {
      return truncateToWidth(dim(` ${lead}${t('activitygroup.edit_gap', { count: String(row.count) })}`), rowWidth, '…');
    }
    if (row.kind === 'file') {
      return truncateToWidth(chalk.hex(colors.textDim).bold(` ${row.text ?? ''}`), rowWidth, '…');
    }
    const number = numbered ? `${String(row.line ?? '').padStart(numberWidth)} ` : '';
    const gutter = chalk.hex(colors.diffGutter)(` ${number}`);
    if (row.kind === 'context') {
      const body = row.text === undefined ? '' : chalk.dim(chalk.hex(colors.text)(highlight(clean(row.text), row.lang, colors)));
      return truncateToWidth(`${gutter}  ${body}`, rowWidth, '…');
    }

    const add = row.kind === 'add';
    const sign = chalk.hex(add ? colors.diffAdded : colors.diffRemoved).bold(add ? '+ ' : '- ');
    const body =
      row.text === undefined
        ? dim(t('activitygroup.edit_removed', { count: String(row.count) }))
        : chalk.hex(colors.text)(highlight(clean(row.text), row.lang, colors));
    const marks = row.marks ?? [];
    const head = `${gutter}${sign}`;
    const headWidth = visibleWidth(head);
    const bandOpen = bands ? openOf(chalk.bgHex(add ? colors.diffAddedBg : colors.diffRemovedBg)) : '';
    const markOpen = bands ? openOf(chalk.bgHex(add ? colors.diffAddedWordBg : colors.diffRemovedWordBg)) : '';
    const painted = onBand(body, bandOpen, marks, markOpen);
    const clipped = truncateToWidth(painted, Math.max(1, rowWidth - headWidth), '…');
    const pad = ' '.repeat(Math.max(0, rowWidth - headWidth - visibleWidth(clipped)));
    if (!bands) return `${head}${clipped}${pad}`;
    // The head carries only foreground and bold codes, so the band runs
    // through it; the padding re-opens it in case the clip reset it.
    return `${bandOpen}${head}${clipped}${bandOpen}${pad}\u001B[49m`;
  });
}
