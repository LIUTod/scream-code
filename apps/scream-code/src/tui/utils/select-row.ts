/**
 * The one look of a selected row, shared by every list in the TUI: the `❯`
 * pointer in the primary colour, the label in bold primary, and a quiet bar
 * (`selectionBg`) across the whole row — so the eye finds the cursor by its
 * shape, not by hunting for a one-cell arrow. Rows that belong to the
 * selected item (its description lines) carry the same bar.
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

// SGR sequences that end a background: full reset and "default background".
const BG_RESET = /\u001B\[(?:0|49)?m/g;

/**
 * Paint `line` (already coloured) on the selection bar, padded to `width`.
 * Inner resets would end the bar early, so the bar is reopened after each.
 */
export function selectedRow(colors: ColorPalette, line: string, width: number): string {
  const fitted = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(fitted)));
  // The bar needs 256 colours or more: on a 16-colour terminal its quiet green
  // would round to a loud basic green, with the green label lost on it — there
  // the pointer and the bold label carry the selection alone.
  if (chalk.level < 2) return fitted + pad;
  const probe = chalk.bgHex(colors.selectionBg)('x');
  const open = probe.slice(0, probe.indexOf('x'));
  if (open === '') return fitted + pad;
  const close = probe.slice(probe.indexOf('x') + 1);
  const lifted = liftDimText(colors, fitted);
  return `${open}${lifted.replaceAll(BG_RESET, (reset) => `${reset}${open}`)}${pad}${close}`;
}

/** The SGR that opens `hex` as a foreground at the terminal's colour level. */
function fgOpen(hex: string): string {
  const probe = chalk.hex(hex)('x');
  return probe.slice(0, probe.indexOf('x'));
}

/**
 * Dim and muted greys are made for the bare background; on the bar they
 * would sink (about 2:1 in the dark theme), so they become `selectionMuted`.
 */
function liftDimText(colors: ColorPalette, line: string): string {
  const to = fgOpen(colors.selectionMuted);
  let out = line;
  for (const from of new Set([fgOpen(colors.textDim), fgOpen(colors.textMuted)])) {
    if (from !== '' && from !== to) out = out.replaceAll(from, to);
  }
  return out;
}

/** Paint the row on the bar when selected; otherwise return it unchanged. */
export function selectableRow(colors: ColorPalette, line: string, width: number, selected: boolean): string {
  return selected ? selectedRow(colors, line, width) : line;
}

/** ` ← 当前` after the label of the item in use (the same in every list). */
export function currentMark(colors: ColorPalette): string {
  return ' ' + chalk.hex(colors.success)(t('dialog.current'));
}
