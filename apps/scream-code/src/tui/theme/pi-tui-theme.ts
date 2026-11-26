/**
 * Pi-tui theme adapters — MarkdownTheme and EditorTheme from our ColorPalette.
 *
 * All chalk calls route through `ColorPalette` tokens so themes flip
 * cleanly. No raw `chalk.gray` / `chalk.dim` / `chalk.white` here.
 */

import type { MarkdownTheme, EditorTheme } from '@liutod-scream/pi-tui';
import {
  copyContentStart,
  copyHiddenRow,
  copySoftWrap,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { highlight, supportsLanguage, type Theme } from 'cli-highlight';

import type { ColorPalette } from './colors';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { selectedRow } from '#/tui/utils/select-row';
import { isCodeBlockPanelEnabled } from '#/tui/utils/ui-preferences';
import type { DiagramTheme } from '#/tui/utils/mermaid-diagram';

// pi-tui's renderer emits literal "### " / "#### " / ... markers for h3-h6
// headings (h1/h2 are rendered without the `#` prefix). The prefix arrives
// here already wrapped in bold SGR codes, so we strip it — after any leading
// ANSI sequences — before re-styling. Without this, h3+ renders as raw
// "### Title" and reads like unparsed markdown.
// eslint-disable-next-line no-control-regex -- intentionally matches the ESC byte that opens ANSI SGR sequences.
const HEADING_HASH_PREFIX = /^((?:\u001B\[[0-9;]*m)*)#{1,6}[ \t]+/;

/**
 * Map cli-highlight syntax tokens onto the ColorPalette so code blocks follow
 * the active theme instead of cli-highlight's built-in colors. cli-highlight
 * takes one formatter function per token; tokens not listed here fall back to
 * its DEFAULT_THEME.
 */
/**
 * Markdown code-block highlight theme: the fluorescent brand green is the
 * only green (keyword, function, built_in, diff additions); strings take the
 * heading amber; numbers → warning; comments → textDim. Kept distinct from
 * the shared preview theme in code-highlight-theme.ts on purpose.
 * primary hue, while file-preview panels use the classic blue/red/yellow
 * scheme mapped to the same palette. Both follow the active theme.
 */
function createMarkdownCodeHighlightTheme(colors: ColorPalette): Theme {
  const keyword = chalk.hex(colors.primary);
  // Strings share the heading amber so the brand green stays the only green.
  const str = chalk.hex(colors.mdHeading);
  const comment = chalk.hex(colors.textDim);
  const num = chalk.hex(colors.warning);
  const fn = chalk.hex(colors.primary);
  const cls = chalk.hex(colors.accent);
  const text = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textMuted);
  return {
    keyword,
    built_in: fn,
    type: cls,
    literal: num,
    number: num,
    regexp: str,
    string: str,
    subst: str,
    symbol: num,
    class: cls,
    function: fn,
    title: fn,
    params: text,
    comment,
    doctag: comment,
    meta: muted,
    'meta-keyword': keyword,
    'meta-string': str,
    section: keyword,
    tag: cls,
    name: fn,
    'builtin-name': fn,
    attr: num,
    attribute: num,
    variable: text,
    bullet: num,
    code: str,
    emphasis: (s) => chalk.italic(s),
    strong: (s) => chalk.bold(s),
    formula: text,
    link: chalk.hex(colors.mdLink),
    // Syntax `quote` token inside a fence — neutral, like the file-preview
    // theme. `mdQuote` belongs to markdown block quotes only.
    quote: muted,
    addition: keyword,
    deletion: chalk.hex(colors.diffRemoved),
    default: text,
  };
}

/**
 * The language name from a fence info string.
 *
 * `marked` hands over the raw info string (`ts title="x"`), not the language,
 * so both the caption and the highlighter take the first word — otherwise they
 * disagree with each other and with what the author meant.
 */
function firstInfoWord(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const info = text.startsWith('```') ? text.slice(3) : text;
  const [word] = info.trim().split(/[ \t]/, 1);
  return word === undefined || word.length === 0 ? undefined : word;
}

/**
 * Split one code line into width-sized fragments.
 *
 * `wrapTextWithAnsi` is a *word* wrapper: it trims the space at every break, so
 * a wrapped command copies back as `-gscream-code`. Code must keep every cell,
 * so this slices by visible columns instead — concatenating the rows reproduces
 * the source exactly. `sliceWithWidth` re-opens the SGR codes at the slice
 * start, so a highlighted line keeps its colour on continuation rows. `strict`
 * keeps a wide character from overflowing the row (it moves to the next one).
 */
function sliceCodeRows(line: string, width: number): string[] {
  const rows: string[] = [];
  const total = visibleWidth(line);
  let offset = 0;
  for (;;) {
    const text = sliceByColumn(line, offset, width, true);
    const taken = visibleWidth(text);
    if (taken > 0) {
      rows.push(text);
      if (offset + taken >= total) break;
      offset += taken;
      continue;
    }
    // A grapheme wider than the whole window: take it anyway (non-strict) so
    // the rest of the line is not silently dropped.
    const forced = sliceByColumn(line, offset, width + 2, false);
    const forcedWidth = visibleWidth(forced);
    rows.push(forced);
    if (forcedWidth <= 0) break;
    if (offset + forcedWidth >= total) break;
    offset += forcedWidth;
  }
  return rows;
}

/** Spaces at the end of a plain-text row. */
function trailingSpaces(text: string): number {
  return text.length - text.trimEnd().length;
}

export function createMarkdownTheme(colors: ColorPalette): MarkdownTheme {
  const stripHash = (text: string): string => text.replace(HEADING_HASH_PREFIX, '$1');
  // pi-tui renders a heading as `heading(bold(text))`. Since `bold` now carries
  // the emphasis colour, the inner span would repaint the whole heading — every
  // heading in a reply would come out violet instead of amber. The heading owns
  // its hue, so whatever styling it is handed is dropped first. (Inline code
  // inside a heading loses its green for the same reason; a heading reads as one
  // unit and the structure matters more than the nested accent.)
  const stripSgr = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
  const muted = chalk.hex(colors.textMuted);
  const border = chalk.hex(colors.border);
  const codeTheme = createMarkdownCodeHighlightTheme(colors);
  return {
    // Signature heading color — gives long replies a visible structure.
    heading: (text) => chalk.bold.hex(colors.mdHeading)(stripSgr(stripHash(text))),
    link: (text) => chalk.hex(colors.mdLink)(text),
    linkUrl: (text) => muted(text),
    // Inline code is the brand accent itself; the palette keeps it the only green.
    code: (text) => chalk.hex(colors.primary)(text),
    codeBlock: (text) => chalk.hex(colors.mdCodeBlock)(text),
    // Fenced code renders as a background panel. The opening fence carries the
    // language, and it becomes a caption row instead of a right-aligned tag
    // inside the first code row: a tag in the row is copied along with the code
    // and steals columns from the line, so a wrapped command reads as if the
    // tag interrupted it. The closing fence row is dropped.
    codeBlockBorder: (text) => {
      // The info string is not the language: a fence may carry attributes
      // (`ts title="x"`), and printing them just moves the junk from the code
      // row into the caption. Only the first word is a language name.
      const lang = firstInfoWord(text);
      if (lang === undefined) return null;
      // The library wraps whatever the hook returns, so an over-wide caption
      // would become a second, unstyled row instead of a caption. Clip by
      // columns (not code units — 16 CJK characters are 32 cells).
      // The caption is interface, not code: a copy leaves the row out.
      return `${copyHiddenRow()} ${chalk.hex(colors.mdCodeBlockBorder).italic(truncateToWidth(lang, 16))}`;
    },
    codeBlockIndent: ' ',
    codeBlockLine: (line, { width }) => {
      // The library wraps whatever this hook returns, and a continuation row
      // would lose the gutter/background — so the panel must stay one visual
      // row per returned line. Overlong source lines are wrapped HERE into
      // full panel rows joined by "\n": the outer wrap pass splits on the
      // newline and each row already fits, so nothing is truncated and every
      // folded row keeps the panel chrome.
      const gutter = 1;
      // Full width minus the gutter. No label reserves columns any more, so the
      // wrap point depends only on the terminal width and every row lines up.
      // The floor of 4 keeps a 3-cell tab (or a wide emoji) from being wider
      // than an entire row, which `strict` slicing cannot represent.
      const contentMax = Math.max(4, width - gutter);
      const rows = sliceCodeRows(line, contentMax);
      // `/codebg` off drops the fill but keeps the row layout.
      const panelled = isCodeBlockPanelEnabled();
      const paint = panelled ? chalk.bgHex(colors.mdCodeBlockBg) : (text: string): string => text;
      return rows
        .map((row, index) => {
          const padCells = Math.max(0, width - visibleWidth(row) - gutter);
          // A copy skips the gutter, and a row cut from a long source line is
          // joined back to the one above — with the spaces the cut fell after,
          // which the panel's own padding makes impossible to tell apart.
          const joined =
            index === 0 ? '' : copySoftWrap(trailingSpaces(stripTerminalSequences(rows[index - 1] ?? '')));
          return `${joined}${paint(' ')}${copyContentStart()}${paint(row)}${paint(' '.repeat(padCells))}`;
        })
        .join('\n');
    },
    quote: (text) => chalk.hex(colors.mdQuote)(text),
    quoteBorder: (text) => chalk.hex(colors.mdQuote)(text),
    hr: (text) => border(text),
    // Table headers keep the same color as body text (bold only); the
    // centered alignment already distinguishes the header row, so no
    // extra tint is needed.
    tableHeader: (text) => chalk.bold(text),
    // Match the assistant-message bullet so list markers read like a reply
    // prefix. Ordered lists arrive as `"1. "` / `"2. "` and are left
    // untouched by the leading-dash anchor.
    listBullet: (text) => chalk.hex(colors.roleAssistant)(text.replace(/^-/, '•')),
    // Emphasis carries a colour: bold-only was the one markdown mark that read
    // as plain body text, which left replies looking monochrome. `mdBold` is
    // the heaviest markdown token in every palette — keep it that way.
    bold: (text) => chalk.bold.hex(colors.mdBold)(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code: string, lang?: string) => {
      // Same first-word rule as the caption, so an attribute fence highlights
      // instead of falling back to plain text.
      const normalizedLang = firstInfoWord(lang)?.toLowerCase();
      const language =
        normalizedLang !== undefined && supportsLanguage(normalizedLang) ? normalizedLang : 'text';
      try {
        const highlighted = highlight(code, { language, ignoreIllegals: true, theme: codeTheme });
        return highlighted.split('\n');
      } catch {
        return code.split('\n');
      }
    },
  };
}

/**
 * Colour for a drawn diagram. The renderer emits semantic runs and no colour at
 * all, so the frame is what keeps the picture readable at a glance: outlines and
 * connectors stay quiet so the structure recedes, while node names take the
 * heading colour — the words inside boxes are the content of a diagram, and
 * they should read as prominently as a heading does.
 *
 * `none` is blank filler and is left unpainted — it carries no glyph, and
 * trailing filler has already been dropped before a row is quoted.
 */
export function createDiagramTheme(colors: ColorPalette): DiagramTheme {
  // Resolved on first use, not at construction: a diagram is rare, and every
  // assistant message would otherwise build painters it never calls.
  type Painter = (text: string) => string;
  let painters:
    | { frame: Painter; label: Painter; title: Painter; edgeLabel: Painter; note: Painter }
    | undefined;
  const paint = () => {
    painters ??= {
      frame: chalk.hex(colors.border),
      label: chalk.hex(colors.mdHeading),
      title: chalk.hex(colors.mdHeading).bold,
      edgeLabel: chalk.hex(colors.textDim),
      note: chalk.hex(colors.textMuted),
    };
    return painters;
  };
  return {
    style: (cls, text) => {
      const p = paint();
      switch (cls) {
        case 'border':
        case 'edge':
          return p.frame(text);
        case 'text':
          return p.label(text);
        case 'title':
          return p.title(text);
        case 'edgeLabel':
          return p.edgeLabel(text);
        case 'none':
          return text;
      }
    },
    note: (text) => paint().note(text),
  };
}

export function createEditorTheme(colors: ColorPalette): EditorTheme {
  const muted = chalk.hex(colors.textMuted);
  return {
    borderColor: (s) => chalk.hex(colors.border)(s),
    // pointer / selectedLine: the shared selected-row look (utils/select-row).
    selectList: {
      pointer: SELECT_POINTER,
      selectedLine: (line: string, width: number) => selectedRow(colors, line, width),
      selectedPrefix: (s) => chalk.hex(colors.primary)(s),
      selectedText: (s) => chalk.hex(colors.primary).bold(s),
      description: (s) => muted(s),
      scrollInfo: (s) => muted(s),
      noMatch: (s) => muted(s),
    },
  };
}

