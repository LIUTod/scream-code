/**
 * Mermaid diagram drawing for the transcript.
 *
 * A ```mermaid fence is drawn as box art in the terminal's own columns, so an
 * architecture or flow explanation reads as a picture instead of a block of
 * DSL. Drawing is a *presentation* of the block: whenever it cannot be done
 * faithfully the original fence is handed back untouched, and the reply reads
 * exactly as it did before this existed.
 *
 * Three decisions here are load-bearing and were settled by measurement rather
 * than by reading the drawing library's documentation:
 *
 * 1. Rows are quoted as inline-code spans so the parser keeps every leading
 *    space and box glyph. CommonMark strips **one** space from each end of a
 *    code span, but only when *both* ends are spaces — so a row that is
 *    indented left and padded right would lose one column and skew the whole
 *    frame. Trailing blanks are therefore dropped before quoting, which costs
 *    nothing: the renderer re-pads each row to frame width anyway. See
 *    `trimRowEnd` and `renderDiagramRow`.
 * 2. Only top-level code tokens are replaced. A fence indented inside a list or
 *    blockquote is left alone, because rewriting it would fight the container's
 *    own indentation. The document is rebuilt from token `raw` values, which is
 *    byte-exact for the shapes measured here but *not* for CRLF input — so the
 *    rebuild is checked against the input first and the whole transform is
 *    abandoned when it would not round-trip. Missing a diagram beats quietly
 *    rewriting a reply's line endings.
 * 3. A drawing wider than the space at hand is not shrunk or wrapped — wrapping
 *    folds the frame in half. It goes back to being a code block.
 */

import { t } from '@scream-code/config';
import { Marked, visibleWidth, type Token, type Tokens } from '@liutod-scream/pi-tui';
import { diagramKind, render, type Cls, type MermaidArt, type Span } from 'grok-mermaid';
import type { MarkdownTransformer } from './markdown-transform';
import { isMermaidDrawing, useMermaidAsciiFrames } from './ui-preferences';

/** Colour source for a drawing: semantic runs in, painted text out. */
export interface DiagramTheme {
  /** Paint one run of the drawing. Runs tile each row completely, so no column
   *  of a frame is left to inherit an unrelated colour. */
  style(cls: Cls, text: string): string;
  /** Paint the one-line note under a block that was not drawn, or was drawn
   *  with parts of the source left out. */
  note(text: string): string;
}

export interface MermaidTransformerOptions {
  getTheme: () => DiagramTheme;
  /** Defaults to the persisted `/mermaid` choice. */
  isEnabled?: () => boolean;
  /** Defaults to the persisted `/mermaid` choice as well. */
  getAsciiFrames?: () => boolean;
}

/**
 * How many rows a switch must save before it is worth taking. Rendering both
 * directions and picking the shorter one is nearly free (0.5 ms, cached by
 * source), but switching for a single row would widen a frame for no real gain —
 * this keeps the trade one-sided.
 */
const MIN_ROWS_SAVED_BY_SWITCH = 3;

/** Mermaid's four layout directions and their opposites. */
const OPPOSITE_DIRECTION: Readonly<Record<string, string>> = {
  LR: 'TD',
  RL: 'BT',
  TD: 'LR',
  BT: 'RL',
};

/**
 * The same graph laid out the other way, or `null` when the source names no
 * direction to flip. Mermaid's direction sits in the header line (`flowchart LR`,
 * `graph TD`, …), and only the first occurrence is rewritten — later ones could
 * be inside a label.
 */
function oppositeDirection(source: string): string | null {
  const match = /\b(LR|RL|TD|BT)\b/.exec(source);
  const token = match?.[0];
  const at = match?.index;
  if (token === undefined || at === undefined) return null;
  const flipped = OPPOSITE_DIRECTION[token];
  if (flipped === undefined) return null;
  return `${source.slice(0, at)}${flipped}${source.slice(at + token.length)}`;
}

/** Opening fence of a code block, spelled the way the block grammar spells it. */
/** A block is a diagram when the info string merely *starts* with the language
 *  name, so `mermaid` and `mermaid title` qualify while an unrelated tag does
 *  not. */
const DIAGRAM_LANG = /^mer(?:maid\b)/i;
/** Cheap pre-filter: never lex a reply that cannot hold a diagram. Both fence
 *  spellings count, because the parser accepts `~~~mermaid` too and the check
 *  below runs on the whole reply, not per token. */
const MAYBE_DIAGRAM = /^``` *mer|~~~ *mer|(?:^|\n) *(?:```|~~~) *mer/im;
/** A row of pure whitespace still has to occupy a line, and an empty code span
 *  is dropped by the parser — a no-break space is blank on screen but is not
 *  whitespace the parser has licence to strip. */
const BLANK_ROW = '\u00A0';

/** Box-drawing glyphs with an unambiguous ASCII twin. Anything outside this
 *  table passes through: a missing mapping must never invent a character. */
const ASCII_GLYPHS: Readonly<Record<string, string>> = {
  '┌': '+', '┐': '+', '└': '+', '┘': '+',
  '├': '+', '┤': '+', '┬': '+', '┴': '+', '┼': '+',
  '╭': '+', '╮': '+', '╰': '+', '╯': '+',
  '─': '-', '╌': '-',
  '│': '|',
  '▼': 'v', '▽': 'v', '△': '^', '▲': '^',
  '◄': '<', '►': '>',
  '●': 'o', '○': 'o',
};
const ASCII_PATTERN = /[┌┐└┘├┤┬┴┼╭╮╰╯─╌│▼▽△▲◄►●○]/g;

function toAscii(text: string): string {
  return text.replace(ASCII_PATTERN, (glyph) => ASCII_GLYPHS[glyph] ?? glyph);
}

/** Longest backtick run decides how wide a fence is needed to quote a row
 *  without the row ending the span early. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.match(/`+/g) ?? []) longest = Math.max(longest, match.length);
  return longest;
}

/**
 * Quote one drawn row as an inline code span, ended by Markdown's hard break so
 * the parser cannot fold two rows onto one line. The two spaces sit outside the
 * span, where no styling can absorb them.
 */
function renderDiagramRow(row: string): string {
  const content = row.trimEnd() || BLANK_ROW;
  const fence = '`'.repeat(longestBacktickRun(content) + 1);
  // A span whose content itself begins or ends with a backtick needs a space on
  // both sides to stay open; the parser strips exactly that pair back off.
  const padded = content.startsWith('`') || content.endsWith('`') ? ` ${content} ` : content;
  return `${fence}${padded}${fence}  \n`;
}

/** Drop a row's trailing blank filler runs — see note 1 in the file header. */
function trimRowEnd(spans: readonly Span[]): Span[] {
  const kept = [...spans];
  while (kept.length > 0 && (kept.at(-1)?.text.trimEnd() ?? '') === '') kept.pop();
  const last = kept.at(-1);
  if (last) kept[kept.length - 1] = { text: last.text.trimEnd(), cls: last.cls };
  return kept;
}

function diagramRows(art: MermaidArt, theme: DiagramTheme, asciiFrames: boolean): string {
  return art.styled
    .map((spans) =>
      trimRowEnd(spans)
        .map((span) => theme.style(span.cls, asciiFrames ? toAscii(span.text) : span.text))
        .join(''),
    )
    .map(renderDiagramRow)
    .join('');
}

/** Widest row of a drawing, counted in the columns our renderer will use. The
 *  library reports `width` in its own model; measuring every row with the
 *  renderer's own function is what keeps a disagreement from wrapping a frame. */
function diagramColumns(art: MermaidArt): number {
  let columns = art.width;
  for (const row of art.plain) columns = Math.max(columns, visibleWidth(row));
  return columns;
}

/**
 * Why a block stayed a block, using the kind probe to tell "this shape is not
 * drawn here" apart from "this text did not parse".
 *
 * Resolved at render time through `t()` like any other transcript text: the
 * note is shown to the reader, so it follows their language. The one exception
 * is the library's own incompleteness warning below — that string is the
 * drawing library's diagnosis and has no translation to offer.
 */
function notDrawnReason(body: string): string {
  return diagramKind(body) === null ? t('mermaid.note.unsupported') : t('mermaid.note.unparsed');
}

export function createMermaidTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
  return (markdown, context) => {
    if (!(options.isEnabled?.() ?? isMermaidDrawing())) return markdown;
    if (context.messageKind === 'thinking') return markdown;
    // Drawing always waits for the reply to finish: a half-written frame is
    // redrawn into a different shape every few tokens, which reads as flicker.
    if (context.streaming) return markdown;
    if (!MAYBE_DIAGRAM.test(markdown)) return markdown;

    const theme = options.getTheme();
    const asciiFrames = options.getAsciiFrames?.() ?? useMermaidAsciiFrames();
    const { availableWidth } = context;

    const draw = (code: Tokens.Code): string | null => {
      const art = render(code.text);
      if (!art) {
        const reason = notDrawnReason(code.text);
        return `${code.raw}\n${theme.note(t('mermaid.note.not_rendered', { reason }))}  \n`;
      }

      // Both directions are cheap to measure (about 0.5 ms, and the result is
      // cached per source), so the choice is made on the numbers instead of on
      // the direction the model happened to write. Two reasons to switch:
      //
      // - the original does not fit and the other way does. A seven-block chain
      //   measured 148 columns left-to-right and 26 top-down.
      // - both fit, and the other way is materially shorter. Vertical space is
      //   what a terminal runs out of, so a 23-row frame that fits as 3 rows is
      //   a straight win.
      let chosen = art;
      let columns = diagramColumns(chosen);
      let switched = false;
      const reversed = oppositeDirection(code.text);
      const alternate = reversed ? render(reversed) : null;
      if (alternate) {
        const alternateColumns = diagramColumns(alternate);
        const alternateFits = alternateColumns <= availableWidth;
        const originalFits = columns <= availableWidth;
        const rowsSaved = chosen.plain.length - alternate.plain.length;
        if (alternateFits && (!originalFits || rowsSaved >= MIN_ROWS_SAVED_BY_SWITCH)) {
          chosen = alternate;
          columns = alternateColumns;
          switched = true;
        }
      }

      if (columns > availableWidth) {
        // Tell the reader what to do about it, not just that it failed: the fix
        // is on their side of the screen (widen it) or in the next reply (split).
        const reason = t('mermaid.note.wider', { width: columns, available: availableWidth });
        return `${code.raw}\n${theme.note(t('mermaid.note.not_rendered', { reason }))}  \n`;
      }

      const notes: string[] = [];
      if (switched) notes.push(t('mermaid.note.flipped'));
      // A drawing that dropped part of the source is still the best picture
      // available; say so rather than hiding it.
      if (chosen.warnings.length > 0) {
        notes.push(t('mermaid.note.incomplete', { reason: chosen.warnings[0] ?? '' }));
      }
      const drawn = diagramRows(chosen, theme, asciiFrames);
      return notes.length === 0
        ? drawn
        : `${drawn}${notes.map((note) => `${theme.note(note)}  \n`).join('')}`;
    };

    // Top level only, and `raw` for everything else: see note 2 in the header.
    const tokens = parser.lexer(markdown) as Token[];
    const untouched = tokens.map((token) => token.raw).join('');
    // Rebuilding the document from token `raw` is only safe while it reproduces
    // the input exactly. The lexer normalises line endings (CRLF arrives as LF),
    // and silently rewriting a reply's whitespace is a bigger change than missing
    // a diagram — so bail out and leave the text exactly as it came.
    if (untouched !== markdown) return markdown;

    return tokens
      .map((token) => {
        if (token.type !== 'code') return token.raw;
        const code = token as Tokens.Code;
        if (!DIAGRAM_LANG.test(code.lang ?? '')) return token.raw;
        return draw(code) ?? token.raw;
      })
      .join('');
  };
}

const parser = new Marked();
