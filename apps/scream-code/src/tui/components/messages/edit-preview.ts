/**
 * Inline edit preview: the changed lines of an Edit / Write shown right under
 * its row in a folded activity block, so a turn's changes read without
 * expanding it (Ctrl+O still shows the full diff with context).
 *
 * Rows come from the tool's `file_diff` display — real file line numbers,
 * deleted text only where the call itself carried it (see agent-core
 * `fileDiffDetails`). A replayed session has no display: an Edit then falls
 * back to diffing its own old_string / new_string, without line numbers; a
 * Write shows no preview rather than a guess.
 *
 * Each row is painted on a red (removed) or green (added) background across
 * the block's width; below 256 colours only the sign and text are coloured.
 */
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import { computeDiffLines } from '#/tui/components/media/diff-preview';
import type { ColorPalette } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { replaceTabs, sanitizeShellOutput } from '#/tui/utils/sanitize';

export interface EditPreviewRow {
  readonly kind: 'add' | 'delete';
  /** File line number; absent for a replayed edit. */
  readonly line?: number | undefined;
  /** Line text; absent for a deletion the call did not carry. */
  readonly text?: string | undefined;
}

export interface EditPreview {
  readonly rows: readonly EditPreviewRow[];
  /** Changed lines in all; more than `rows` when the preview was capped. */
  readonly total: number;
}

const PREVIEW_TOOLS = new Set(['Edit', 'Write']);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The preview of a finished, successful Edit / Write, or undefined. */
export function editPreviewOf(
  toolCall: Readonly<ToolCallBlockData>,
  result: Readonly<ToolResultBlockData> | undefined,
): EditPreview | undefined {
  if (!PREVIEW_TOOLS.has(toolCall.name)) return undefined;
  if (result === undefined || result.is_error === true) return undefined;
  const display = result.display;
  if (display?.kind === 'file_diff' && display.preview !== undefined) {
    if (display.preview.length === 0) return undefined;
    return { rows: display.preview, total: display.previewTotal ?? display.preview.length };
  }
  // A replayed record carries no display: an Edit's own strings still say
  // what changed, only not where.
  if (toolCall.name !== 'Edit') return undefined;
  const oldStr = str(toolCall.args['old_string']);
  const newStr = str(toolCall.args['new_string']);
  if (oldStr.length === 0 && newStr.length === 0) return undefined;
  const rows: EditPreviewRow[] = [];
  for (const line of computeDiffLines(oldStr, newStr)) {
    if (line.kind === 'add') rows.push({ kind: 'add', text: line.code });
    else if (line.kind === 'delete') rows.push({ kind: 'delete', text: line.code });
  }
  return rows.length === 0 ? undefined : { rows, total: rows.length };
}

/** One display row: a single line, or a run of deletions whose text is unknown. */
interface DisplayRow {
  readonly kind: 'add' | 'delete';
  readonly line: number | undefined;
  readonly text: string | undefined;
  /** Deletions folded into this row (text-less runs only). */
  readonly count: number;
}

function displayRows(rows: readonly EditPreviewRow[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (row.kind === 'delete' && row.text === undefined && last?.kind === 'delete' && last.text === undefined) {
      out[out.length - 1] = { ...last, count: last.count + 1 };
      continue;
    }
    out.push({ kind: row.kind, line: row.line, text: row.text, count: 1 });
  }
  return out;
}

/** Rows `renderEditPreview` draws for this preview at `limit` (count row included). */
export function previewRowCount(preview: EditPreview, limit: number): number {
  if (limit <= 0) return 0;
  const all = displayRows(preview.rows);
  const shown = all.slice(0, limit);
  const shownLines = shown.reduce((sum, row) => sum + row.count, 0);
  return shown.length + (preview.total > shownLines ? 1 : 0);
}

/**
 * The preview painted as rows of exactly `width` columns, each starting with
 * `prefix` (the block's tree pipe or blank indent). At most `limit` changed
 * rows; a last row counts what was left out. `limit` ≤ 0 → no rows.
 */
export function renderEditPreview(
  preview: EditPreview,
  limit: number,
  width: number,
  colors: ColorPalette,
  prefix: string,
): string[] {
  if (limit <= 0) return [];
  const all = displayRows(preview.rows);
  const shown = all.slice(0, limit);
  const shownLines = shown.reduce((sum, row) => sum + row.count, 0);
  const remaining = Math.max(0, preview.total - shownLines);
  const numbered = shown.some((row) => row.line !== undefined);
  const numberWidth = numbered
    ? Math.max(3, ...shown.map((row) => String(row.line ?? '').length))
    : 0;
  const rowWidth = Math.max(1, width - visibleWidth(prefix));
  const bars = chalk.level >= 2;

  const lines = shown.map((row) => {
    const add = row.kind === 'add';
    const number = numbered ? `${String(row.line ?? '').padStart(numberWidth)} ` : '';
    const sign = add ? '+' : '-';
    const body =
      row.text === undefined
        ? t('activitygroup.edit_removed', { count: String(row.count) })
        : sanitizeShellOutput(replaceTabs(row.text)).replaceAll(/[\r\n]+/g, ' ');
    const fg = add ? colors.diffAdded : colors.diffRemoved;
    const head = ` ${number}${sign} `;
    const text = truncateToWidth(body, Math.max(1, rowWidth - visibleWidth(head)), '…');
    const pad = ' '.repeat(Math.max(0, rowWidth - visibleWidth(head) - visibleWidth(text)));
    const textStyle = row.text === undefined ? chalk.hex(colors.textDim) : chalk.hex(colors.text);
    if (!bars) {
      return prefix + chalk.hex(colors.textDim)(` ${number}`) + chalk.hex(fg).bold(`${sign} `) + textStyle(text) + pad;
    }
    const bg = chalk.bgHex(add ? colors.diffAddedBg : colors.diffRemovedBg);
    return (
      prefix +
      bg(chalk.hex(colors.textDim)(` ${number}`) + chalk.hex(fg).bold(`${sign} `) + textStyle(text) + pad)
    );
  });
  if (remaining > 0) {
    const more = chalk.hex(colors.textDim)(` ${' '.repeat(numbered ? numberWidth + 1 : 0)}${t('activitygroup.edit_more', { count: String(remaining) })}`);
    lines.push(prefix + truncateToWidth(more, rowWidth, '…'));
  }
  return lines;
}
