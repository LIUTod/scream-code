import type { Component } from '@liutod-scream/pi-tui';
import { Text } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { wrapUrlsAsHyperlinks } from '#/utils/terminal-hyperlink';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

/**
 * Returns the tail of `text` whose UTF-8 byte length is at most `maxBytes`
 * (plus one byte when a torn sequence's introducer ESC sits immediately before
 * the cut and the sequence's remainder provably closes — keeping the ESC makes
 * the sequence whole and hides its fragment), with the head aligned to a
 * boundary no ANSI escape sequence spans.
 * Iterates by Unicode code points so multi-byte characters and surrogate
 * pairs are never split, then hands the cut to `safeTailStart`: success output
 * keeps its ANSI codes (only error output is stripped), and a raw byte cut
 * could land inside a sequence, leaving a fragment (`m`, `0m`, `[31`) that
 * `sanitizeShellOutput` cannot recognize because its ESC byte was cut away.
 */
function truncateTailBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const chars = Array.from(text);
  let bytes = 0;
  let units = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i];
    if (char === undefined) continue;
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    units += char.length;
  }
  return text.slice(safeTailStart(text, text.length - units));
}

const ESC = '\u001B';

/**
 * Largest share of a retained tail the boundary rules may discard.
 *
 * Both rules trade content for a head that is whole by construction: rule 1
 * restarts after the next `\n` and drops the torn line, and rule 2 skips the
 * remainder of a torn sequence. The trade only pays while the tail keeps a
 * (non-strict) majority — with one 5000-char line ahead, a 100-byte budget
 * would come back with the few bytes after it, and the reader asked for the
 * newest output, not for a tidy head. Past the bound the raw cut keeps the
 * content: a string payload stays visible, and a torn CSI or two-byte escape
 * run keeps the fragment it left in view, because skipping that remainder
 * would cost more than the fragment it hides — unless the introducer ESC sits
 * immediately before the head *and* the sequence provably closes, where one
 * unit of look-back keeps the sequence whole and the fragment never surfaces.
 * An unclosed run keeps the raw cut: with no terminator to hand the sanitizer,
 * backing onto its ESC would surface a bare ESC the sanitizer cannot strip.
 */
const MAX_TAIL_DROP_SHARE = 0.5;

/**
 * Move a tail cut point forward to a boundary no ANSI escape sequence spans.
 *
 * A raw `slice(-tail)` can land inside a sequence (`…\u001b[31|m…`), leaving a
 * fragment (`m`, `0m`, `[31`) whose ESC byte was cut away —
 * `sanitizeShellOutput` only recognizes complete sequences, so the fragment
 * renders as text. Two provable rules keep the head clean:
 *
 * 1. Line alignment: a CSI sequence cannot contain `\n` (LF is not a
 *    parameter, intermediate or final byte), so a cut that lands mid-line
 *    restarts after the next `\n`. The only loss is the torn partial line,
 *    whose head cannot be trusted; every escape after the newline is whole.
 *    Bounded by `MAX_TAIL_DROP_SHARE`, so one huge line cannot eat the budget.
 * 2. Torn-sequence skip: when the retained text is one line (no `\n` after
 *    the cut), or an OSC/DCS/PM/APC payload spans the newline the cut aligned
 *    to, the dropped prefix is inspected for a sequence still open at the cut
 *    — a run of CSI body bytes (0x20–0x3F) reaching back to `ESC [`, an `ESC`
 *    whose intermediate bytes were torn (`ESC ( B`), or a string-sequence
 *    opener the cut landed inside. The head then skips exactly the bytes a
 *    terminal would consume for that sequence, so no visible text is dropped —
 *    but only while that skip stays within `MAX_TAIL_DROP_SHARE` of the tail.
 *    A CSI body or escape-intermediate run can be arbitrarily long, so past
 *    the bound the head keeps the newest bytes and the fragment the raw cut
 *    left with them — or one unit earlier, onto an introducer ESC sitting
 *    immediately before the head, so the whole sequence survives and is
 *    stripped (`withinDropShare`) — but only when the skip proved the sequence
 *    closed: an unclosed run keeps the raw cut, because with no terminator to
 *    hand the sanitizer the ESC would surface bare and swallow what follows
 *    it. So does the head for a string that never ends or ended ahead of the
 *    cut. A sliver of the tail is worse than a fragment.
 *
 * `cut` is always a code-point boundary here (the byte loop above works in
 * code points), so unlike its manager-side twin there is no surrogate half to
 * drop, and `stringPayloadHead`'s clamp steps back onto a code point as well;
 * the one-unit look-back onto an introducer ESC (`withinDropShare`) — taken
 * only for a skip that proved its sequence closed — is a code point boundary
 * too. Mirrors `safeTailStart` in
 * `packages/agent-core/src/tools/background/manager.ts` — app code cannot
 * import agent-core directly, so the rule lives in both places.
 */
function safeTailStart(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const tail = text.length - cut;
  let start = cut;
  if (text[start - 1] !== '\n') {
    const newline = text.indexOf('\n', start);
    // Bounded alignment: past `MAX_TAIL_DROP_SHARE` the torn line is worth
    // more than the clean head, and rule 2 still strips the fragment the raw
    // cut leaves behind.
    if (newline !== -1 && newline + 1 - cut <= tail * MAX_TAIL_DROP_SHARE) {
      start = newline + 1;
    }
  }
  return skipOpenEscape(text, start);
}

/** CSI parameter (0x30–0x3F) / intermediate (0x20–0x2F) bytes — everything before the final byte. */
function isCsiBody(code: number | undefined): boolean {
  return code !== undefined && code >= 0x20 && code <= 0x3f;
}

/** CSI final byte (0x40–0x7E) — the sequence ends here. */
function isCsiFinal(code: number | undefined): boolean {
  return code !== undefined && code >= 0x40 && code <= 0x7e;
}

/** OSC / DCS / PM / APC introducers — string sequences ended by BEL or ST. */
function isStringIntro(intro: string | undefined): boolean {
  return intro === ']' || intro === 'P' || intro === '^' || intro === '_';
}

/** ESC-intermediate byte (0x20–0x2F) of a two-byte escape sequence. */
function isEscapeIntermediate(code: number | undefined): boolean {
  return code !== undefined && code >= 0x20 && code <= 0x2f;
}

/** Final byte (0x30–0x7E) that closes a two-byte escape sequence. */
function isEscapeFinal(code: number | undefined): boolean {
  return code !== undefined && code >= 0x30 && code <= 0x7e;
}

/** True when every code point in the half-open range `[from, to)` is an ESC intermediate (0x20–0x2F). */
function allEscapeIntermediates(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (!isEscapeIntermediate(text.codePointAt(i))) return false;
  }
  return true;
}

/**
 * When the dropped prefix proves an escape sequence is still open at `cut`,
 * return the index after its remainder; otherwise return `cut` unchanged.
 */
function skipOpenEscape(text: string, cut: number): number {
  // `ESC [ body… | cut` — the body bytes run straight back to the opener.
  let run = cut;
  while (run > 0 && isCsiBody(text.codePointAt(run - 1))) run -= 1;
  if (run >= 2 && text[run - 1] === '[' && text[run - 2] === ESC) {
    const skip = skipCsiRest(text, cut);
    return withinDropShare(text, cut, skip.end, skip.closed);
  }
  // `ESC intermediates… | cut` — the introducer was cut away (`[31m`, `m`) or
  // the torn run is an escape's own intermediate bytes (`ESC ( B`).
  if (text[run - 1] === ESC && allEscapeIntermediates(text, run, cut)) {
    return skipEscapeRest(text, cut);
  }
  // `ESC ] P ^ _ … | cut` — a string sequence the cut landed inside; payloads
  // may contain `\n`, so it can span the newline the head aligned to.
  const open = text.lastIndexOf(ESC, cut - 1);
  if (open !== -1 && isStringIntro(text[open + 1])) {
    return stringSequenceHead(text, open, cut);
  }
  return cut;
}

/**
 * Keep a provable skip only while it stays within `MAX_TAIL_DROP_SHARE` of the
 * tail that starts at `from`: the skipped bytes are exactly what the reader
 * loses from the tail it asked for. A CSI body or escape-intermediate run can
 * be arbitrarily long, so past the bound the raw cut is worth more than the
 * clean head — except when the sequence's introducer ESC sits immediately
 * before the head (`…\u001b|[31m…`) *and* `closed` says the skip found the
 * sequence's terminator, where one unit of look-back keeps the sequence whole
 * instead: the sanitizer strips it and the visible text is the skip's, for
 * that one unit rather than a sliver of the tail. An unclosed run must keep
 * the raw cut even with that ESC one unit ahead: nothing terminates it, so
 * look-back would hand the reader a bare ESC whose sequence run a terminal
 * swallows along with the bytes behind it.
 */
function withinDropShare(text: string, from: number, target: number, closed: boolean): number {
  if (target - from <= (text.length - from) * MAX_TAIL_DROP_SHARE) return target;
  return closed && from > 0 && text[from - 1] === ESC ? from - 1 : from;
}

/** Where a torn sequence's remainder ends, and whether it provably closed. */
interface SequenceEnd {
  /** Index just past the sequence's remainder. */
  end: number;
  /** True when a terminator was found inside `text` — false when the run hit `text.length` or a byte that cannot end it. */
  closed: boolean;
}

/**
 * The rest of a CSI sequence whose body was torn at `cut`, with the closure
 * its skip proved: `closed` holds only when a final byte (0x40–0x7E) was
 * actually found, so a parameter run that reaches the end of `text` — or stops
 * on a byte no CSI can end with — reports the sequence as open.
 */
function skipCsiRest(text: string, cut: number): SequenceEnd {
  let end = cut;
  while (end < text.length && isCsiBody(text.codePointAt(end))) end += 1;
  const closed = end < text.length && isCsiFinal(text.codePointAt(end));
  return { end: closed ? end + 1 : end, closed };
}

/** Index after the escape sequence whose introducer ESC sits at `cut - 1`. */
function skipEscapeRest(text: string, cut: number): number {
  const intro = text[cut];
  if (intro === '[') {
    const skip = skipCsiRest(text, cut + 1);
    return withinDropShare(text, cut, skip.end, skip.closed);
  }
  if (isStringIntro(intro)) return stringSequenceHead(text, cut - 1, cut + 1);
  // Two-byte escape: intermediates (0x20–0x2F), then one final byte (0x30–0x7E).
  let end = cut;
  while (end < text.length && isEscapeIntermediate(text.codePointAt(end))) end += 1;
  // Same closure test as the CSI skip: a torn intermediate run that never
  // reaches a final byte leaves the escape open.
  const closed = end < text.length && isEscapeFinal(text.codePointAt(end));
  return withinDropShare(text, cut, closed ? end + 1 : end, closed);
}

/**
 * Head index for a cut that lands inside the string sequence opened at `open`.
 *
 * `stringEnd` gives the byte a terminal stops at; skipping to it hides the
 * payload's remainder, which is what a terminal shows — but only while that
 * costs at most `MAX_TAIL_DROP_SHARE` of the tail. A long OSC 8 URL, or any
 * payload longer than the budget, would otherwise hand the reader a sliver of
 * the tail it asked for; a payload whose extent exceeds the budget stays
 * visible instead. A cut the string already ended ahead of needs no skip, and
 * an unterminated one must not swallow the tail (`stringPayloadHead`).
 */
function stringSequenceHead(text: string, open: number, cut: number): number {
  const drop = stringEnd(text, open + 2) - cut;
  if (drop >= 0 && drop <= (text.length - cut) * MAX_TAIL_DROP_SHARE) {
    return cut + drop;
  }
  return stringPayloadHead(text, open, cut);
}

/**
 * Head index that keeps a string sequence's payload visible, moving the cut
 * only past the opener's own bytes when the cut landed inside them.
 *
 * A terminal swallows an unterminated payload, but a viewer must never render
 * a blank body: a shell card whose output opens with an unterminated OSC — a
 * command killed mid-title, a truncated write — would otherwise show nothing
 * at all. The head stays at `cut` unless the cut landed inside the opener
 * (`\u001b]0;` would leave `0;` in front of the payload), and never reaches
 * `text.length` — the clamp to the last unit steps back onto the pair's first
 * half when that unit is a trailing surrogate pair's low half (defensive here:
 * `truncateTailBytes` cuts on a code point boundary, so the clamp cannot land
 * between a pair's halves in practice) — so this rule never empties the tail;
 * the tail comes back empty only when the byte budget fits none of the last
 * character.
 */
function stringPayloadHead(text: string, open: number, cut: number): number {
  const head = Math.min(Math.max(cut, stringPayloadStart(text, open)), text.length - 1);
  // `text.length - 1` can be the low half of a trailing surrogate pair; the
  // head must sit on a code point boundary, or it would surface a lone half.
  const code = text.codePointAt(head);
  return head > 0 && code !== undefined && code >= 0xdc00 && code <= 0xdfff ? head - 1 : head;
}

/**
 * Index after the byte that ends the string sequence whose payload starts at
 * `from` — its BEL or `ESC \` terminator, or a CAN (0x18) / SUB (0x1A), which
 * a terminal reads as "string over, resume normal parsing". `-1` when the
 * string never ends.
 */
function stringEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === 0x07) return i + 1;
    if (code === 0x1b && text[i + 1] === '\\') return i + 2;
    if (code === 0x18 || code === 0x1a) return i + 1;
  }
  return -1;
}

/**
 * Index where the payload of the string sequence opened at `open` starts: for
 * OSC after `ESC ] Ps ;`, for DCS/PM/APC after their parameter and
 * intermediate bytes and the final byte that opens the payload.
 */
function stringPayloadStart(text: string, open: number): number {
  let i = open + 2;
  if (text[open + 1] === ']') {
    while (i < text.length && isOscParam(text.codePointAt(i))) i += 1;
    if (text[i] === ';') i += 1;
    return i;
  }
  while (i < text.length && isCsiBody(text.codePointAt(i))) i += 1;
  const final = text.codePointAt(i);
  return i < text.length && isCsiFinal(final) ? i + 1 : i;
}

/** OSC numeric parameter byte (0x30–0x39) — the `Ps` before the `;` separator. */
function isOscParam(code: number | undefined): boolean {
  return code !== undefined && code >= 0x30 && code <= 0x39;
}

/**
 * Component that renders tool output with wrap-aware line truncation.
 * Uses pi-tui's Text component to compute actual visual wrapped lines, then
 * caps at `maxLines`. By default a collapsed body shows the TAIL (newest
 * output, where command errors land) with a hint above it, while an expanded
 * body shows everything. `capWhenExpanded` plus `keep` let glance-style bodies
 * (Read/Grep/Glob) cap in both states and pick which end survives. Handles long
 * single-line output (e.g. JSON blobs) that would otherwise wrap to dozens of
 * visual rows.
 */
export class TruncatedOutputComponent implements Component {
  private readonly textComponent: Text;
  private readonly expanded: boolean;
  private readonly capWhenExpanded: boolean;
  private readonly keep: 'head' | 'tail';
  private readonly maxLines: number;
  private readonly hintFormatter: ((remaining: number) => string) | undefined;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      colors: ColorPalette;
      maxLines?: number;
      maxBytes?: number;
      hintFormatter?: (remaining: number) => string;
      /** Cap the body even while expanded (glance-style bodies never grow). */
      capWhenExpanded?: boolean;
      /** Which end a capped preview keeps: the head for file-like bodies, the
       *  tail for command output where the errors land last. */
      keep?: 'head' | 'tail';
    },
  ) {
    this.expanded = options.expanded;
    this.capWhenExpanded = options.capWhenExpanded ?? false;
    this.keep = options.keep ?? 'tail';
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.hintFormatter = options.hintFormatter;
    const tint = options.isError ? chalk.hex(options.colors.error) : chalk.dim;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    // Error output may contain ANSI codes from the command (npm/npx color
    // output in PTY mode). \x1b[0m drops the error tint, background codes
    // render as solid color blocks. Strip them so the tint applies uniformly.
    const stripped = options.isError ? cleaned.replaceAll(/\u001B\[[0-9;]*m/g, '') : cleaned;
    const truncated =
      options.maxBytes === undefined
        ? stripped
        : truncateTailBytes(stripped, options.maxBytes);
    // Tint per-line so each line carries its own ANSI reset. Without this the
    // trailing padding Text.render appends inherits the fg color, and terminals
    // that paint colored spaces show a solid color block instead of text.
    // URLs are wrapped in OSC 8 first so tool output (PaperSearch, WebSearch,
    // FetchURL) exposes clickable links; the escapes are zero-width, so the
    // visible text, tint and wrapping are unchanged.
    const tinted = truncated
      .split('\n')
      .map((line) => tint(wrapUrlsAsHyperlinks(line)))
      .join('\n');
    this.textComponent = new Text(tinted, 2, 0);
  }

  invalidate(): void {
    this.textComponent.invalidate();
  }

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);

    // `expanded` normally means "the user asked for everything". Glance-style
    // bodies cap in both states instead: their raw output can reach hundreds of
    // rows, and a global expand toggle must not turn one file read into a
    // full-screen dump.
    const capped = !this.expanded || this.capWhenExpanded;
    if (!capped || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const remaining = contentLines.length - this.maxLines;
    const expandHint = this.hintFormatter
      ? this.hintFormatter(remaining)
      : t('shell.more_lines', { count: String(remaining) });
    // Render the hint through Text with the same 2-space padding as the
    // content lines above, so the hint aligns with the output instead of
    // sitting at column 0.
    const hintLines = new Text(chalk.dim(expandHint), 2, 0).render(width);

    if (this.keep === 'head') {
      // File-like bodies read top-down, so the hidden part is announced below.
      return [...contentLines.slice(0, Math.max(0, this.maxLines)), ...hintLines];
    }

    // Collapsed: show the TAIL (newest output, where errors land) and surface
    // an expand hint at the TOP so the preview reads top-down without the
    // hidden head pushing the useful lines out of view.
    // slice(-0) === slice(0) === whole array in JS; treat maxLines=0 as "no
    // content shown, hint only" so a zero preview hides all output lines.
    const tail = this.maxLines <= 0 ? [] : contentLines.slice(-this.maxLines);
    return [...hintLines, ...tail];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
      colors: ctx.colors,
    }),
  ];
};
