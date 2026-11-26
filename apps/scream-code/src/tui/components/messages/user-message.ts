/**
 * Renders a user message in the transcript.
 *
 * The mark and the text are in the user colour (yellow on dark themes,
 * orange-red on light ones), bold. With `/hl` on (the default) they sit on a
 * soft band — a light grey on a dark terminal, a soft dark grey on a light
 * one, derived from its own background (`userMessageBg`, see
 * `theme/code-surface.ts`) — only as tall as the text. Off (or below 256
 * colours, where a band cannot be drawn softly) there is no band.
 *
 * A very long message (a pasted log) shows its head and tail with the number
 * of lines in between, so it cannot fill the screen; the full text stays in
 * the session.
 */

import type { Component } from '@liutod-scream/pi-tui';
import { copyContentStart, copyHiddenRow, Spacer, Text, visibleWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import { isUserMessageHighlightEnabled } from '#/tui/utils/ui-preferences';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

/** A message longer than this many rendered rows shows only its head and tail. */
const MAX_ROWS = 30;
const HEAD_ROWS = 12;
const TAIL_ROWS = 4;

const SGR_RESET_RE = /\u001B\[0?m/g;

/**
 * OSC 133;A — "a prompt starts here" — at the head of a message's first row.
 * The terminal view finds these to jump to the previous or next prompt
 * (Ctrl+↑ / Ctrl+↓); it takes the marker out before anything is written, so
 * it never reaches the terminal and has no width.
 */
const PROMPT_START = '\u001B]133;A\u0007';

export class UserMessageComponent implements Component {
  private readonly isSystemReminder: boolean;
  private readonly textComponent: Text;
  private readonly textContent: string;
  /** The colour the text is styled with now (the palette can change under it). */
  private textStyle: string | undefined;
  private readonly spacerComponent: Spacer;
  private readonly imageThumbnails: ImageThumbnail[];
  private cachedKey: string | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    text: string,
    /** Read on every render: a theme change rewrites the palette in place. */
    private readonly colors: ColorPalette,
    images?: ImageAttachment[],
  ) {
    // System reminders are stored as role:'user' in the context but are NOT
    // real user messages — they never get the band.
    this.isSystemReminder = text.trimStart().startsWith('<system-reminder>');
    this.textContent = text;
    // Rows the wrapper breaks are tagged, so a copy joins them back into the line that was typed.
    this.textComponent = new Text('', 0, 0, undefined, { copyMarkers: true });
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img, colors)) ?? [];
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.cachedLines = undefined;
    this.textStyle = undefined;
    this.textComponent.invalidate();
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  render(width: number): string[] {
    const colors = this.colors;
    // /hl is read live (the preference read is cached by utils/ui-preferences,
    // no per-frame disk IO); the cache key carries it and the colours in use,
    // so a toggle or a theme change shows on the next frame.
    const banded = !this.isSystemReminder && isUserMessageHighlightEnabled() && chalk.level >= 2;
    const key = [width, banded, colors.roleUser, colors.userMessageBg, colors.textDim].join('|');
    if (this.cachedLines !== undefined && this.cachedKey === key) return this.cachedLines;

    this.styleText(colors.roleUser);
    const mark = chalk.hex(colors.roleUser).bold(USER_MESSAGE_BULLET);
    const markWidth = visibleWidth(mark);
    const contentWidth = Math.max(1, width - markWidth);
    const rows = this.foldLongMessage(this.textComponent.render(contentWidth), contentWidth);

    const lines: string[] = [...this.spacerComponent.render(width)];
    const bandOpen = banded ? openOf(chalk.bgHex(colors.userMessageBg)) : '';
    rows.forEach((row, index) => {
      const prefix = index === 0 ? mark : ' '.repeat(markWidth);
      // Only a real message is a prompt; a system reminder is not.
      const start = index === 0 && !this.isSystemReminder ? PROMPT_START : '';
      if (!banded) {
        lines.push(start + prefix + copyContentStart() + row);
        return;
      }
      // The band runs across the row: re-opened after any reset inside the
      // styled text, padded to the full width, and closed at the end.
      const body = `${prefix}${copyContentStart()}${row}`.replaceAll(SGR_RESET_RE, (reset) => reset + bandOpen);
      const pad = ' '.repeat(Math.max(0, width - visibleWidth(body)));
      lines.push(`${start}${bandOpen}${body}${pad}\u001B[49m`);
    });

    // Images — indented to align with the text, on the terminal's own ground.
    for (const thumbnail of this.imageThumbnails) {
      for (const line of thumbnail.render(contentWidth)) {
        lines.push(' '.repeat(markWidth) + line);
      }
    }

    this.cachedKey = key;
    this.cachedLines = lines;
    return lines;
  }

  /** Restyles the text only when its colour changed: rewrapping on every frame is not free. */
  private styleText(color: string): void {
    if (this.textStyle === color) return;
    this.textStyle = color;
    this.textComponent.setText(chalk.bold(chalk.hex(color)(this.textContent)));
    this.textComponent.invalidate();
  }

  /** Head and tail of a message past {@link MAX_ROWS} rows, with the rows between counted. */
  private foldLongMessage(rows: string[], contentWidth: number): string[] {
    if (rows.length <= MAX_ROWS) return rows;
    const hidden = rows.length - HEAD_ROWS - TAIL_ROWS;
    const marker = chalk.hex(this.colors.textDim)(t('usermessage.rows_hidden', { count: String(hidden) }));
    // The note is interface, not what was typed: a copy leaves it out.
    const markerRow = copyHiddenRow() + marker + ' '.repeat(Math.max(0, contentWidth - visibleWidth(marker)));
    // The row after the fold starts a new stretch; it must not be joined onto the row before the fold.
    const tail = rows.slice(-TAIL_ROWS).map((row, index) => (index === 0 ? row.replace(SOFT_WRAP_MARKER, '') : row));
    return [...rows.slice(0, HEAD_ROWS), markerRow, ...tail];
  }
}

/** The terminal view's "this row continues the one above" marker (see its row markers). */
const SOFT_WRAP_MARKER = /\u001B\]9912;\d+(?:\u0007|\u001B\\)/;

/** The opening SGR sequence a chalk style emits ('' when colour is off). */
function openOf(style: (text: string) => string): string {
  const styled = style('\u0000');
  const at = styled.indexOf('\u0000');
  return at > 0 ? styled.slice(0, at) : '';
}
