/**
 * The one look of a selected row, shared by every list in the TUI: the `❯`
 * pointer and a bold label on a solid primary-green bar (`selectionBg`)
 * across the whole row, its text inverted (`selectionFg`) — so the eye finds
 * the cursor by its shape, not by hunting for a one-cell arrow. Rows that
 * belong to the selected item (its description lines) carry the same bar.
 *
 * Unselected rows keep the pointer cell blank so labels never shift.
 */
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

/** `❯ ` for the selected row, two blanks otherwise (always two cells). */
export function pointerCell(colors: ColorPalette, selected: boolean): string {
  return selected ? chalk.hex(colors.primary)(`${SELECT_POINTER} `) : '  ';
}

/** Label style for an item row: bold primary when selected, plain text otherwise. */
export function rowLabel(colors: ColorPalette, selected: boolean): (text: string) => string {
  return selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
}

const SGR = /\u001B\[([0-9;]*)m/g;

/** The parameters chalk opens a style with at the current colour level ("38;2;…"), or "". */
function openParams(probe: string): string {
  const match = /^\u001B\[([0-9;]*)m/.exec(probe);
  return match?.[1] ?? '';
}

/**
 * Paint `line` (already coloured) on the selection bar, padded to `width`.
 *
 * The bar is the primary green, solid, so the row's own colours cannot stay:
 * a green label or `← 当前` would vanish on it and light grey would sink.
 * Every foreground in the row is repainted — dim and muted greys to
 * `selectionMuted`, everything else to `selectionFg` — and every reset or
 * background inside the row reopens the bar. Other attributes (bold, the
 * reverse-video input cursor) are kept.
 */
export function selectedRow(colors: ColorPalette, line: string, width: number): string {
  const fitted = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(fitted)));
  // The bar needs 256 colours or more: on a 16-colour terminal the green
  // rounds to a loud basic green — there the pointer and the bold label carry
  // the selection alone.
  if (chalk.level < 2) return fitted + pad;
  const bg = openParams(chalk.bgHex(colors.selectionBg)('x'));
  const fg = openParams(chalk.hex(colors.selectionFg)('x'));
  const muted = openParams(chalk.hex(colors.selectionMuted)('x'));
  if (bg === '' || fg === '') return fitted + pad;
  const quiet = new Set([openParams(chalk.hex(colors.textDim)('x')), openParams(chalk.hex(colors.textMuted)('x'))]);
  const body = fitted.replaceAll(SGR, (_sgr, params: string) => `\u001B[${onBar(params, bg, fg, muted, quiet)}m`);
  return `\u001B[${bg};${fg}m${body}${pad}\u001B[39;49m`;
}

/** One SGR's parameters rewritten for the bar (see `selectedRow`). */
function onBar(params: string, bg: string, fg: string, muted: string, quiet: ReadonlySet<string>): string {
  const parts = params === '' ? ['0'] : params.split(';');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '38' || part === '48') {
      const span = parts[i + 1] === '5' ? 3 : parts[i + 1] === '2' ? 5 : 1;
      const colour = parts.slice(i, i + span).join(';');
      i += span - 1;
      out.push(part === '48' ? bg : quiet.has(colour) ? muted : fg);
      continue;
    }
    const code = Number(part);
    if (code === 0) out.push('0', bg, fg);
    else if (code === 39 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) out.push(fg);
    else if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) out.push(bg);
    else out.push(part);
  }
  return out.join(';');
}

/** Paint the row on the bar when selected; otherwise return it unchanged. */
export function selectableRow(colors: ColorPalette, line: string, width: number, selected: boolean): string {
  return selected ? selectedRow(colors, line, width) : line;
}

/** ` ← 当前` after the label of the item in use (the same in every list). */
export function currentMark(colors: ColorPalette): string {
  return ' ' + chalk.hex(colors.success)(t('dialog.current'));
}
