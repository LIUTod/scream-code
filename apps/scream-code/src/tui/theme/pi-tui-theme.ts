/**
 * Pi-tui theme adapters — MarkdownTheme and EditorTheme from our ColorPalette.
 *
 * All chalk calls route through `ColorPalette` tokens so themes flip
 * cleanly. No raw `chalk.gray` / `chalk.dim` / `chalk.white` here.
 */

import type { MarkdownTheme, EditorTheme } from '@liutod-scream/pi-tui';
import { visibleWidth, truncateToWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { highlight, supportsLanguage, type Theme } from 'cli-highlight';

import type { ColorPalette } from './colors';

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
 * Markdown code-block highlight theme: green-dominant mapping (keyword,
 * function, built_in → primary; strings → success; numbers → warning;
 * comments → textDim). Kept distinct from the shared preview theme in
 * code-highlight-theme.ts on purpose — markdown code blocks use the green
 * primary hue, while file-preview panels use the classic blue/red/yellow
 * scheme mapped to the same palette. Both follow the active theme.
 */
function createMarkdownCodeHighlightTheme(colors: ColorPalette): Theme {
  const keyword = chalk.hex(colors.primary);
  const str = chalk.hex(colors.success);
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
    quote: chalk.hex(colors.mdQuote),
    addition: chalk.hex(colors.diffAdded),
    deletion: chalk.hex(colors.diffRemoved),
    default: text,
  };
}

export function createMarkdownTheme(colors: ColorPalette): MarkdownTheme {
  const stripHash = (text: string): string => text.replace(HEADING_HASH_PREFIX, '$1');
  const muted = chalk.hex(colors.textMuted);
  const border = chalk.hex(colors.border);
  const codeTheme = createMarkdownCodeHighlightTheme(colors);
  return {
    heading: (text) => chalk.bold.hex(colors.text)(stripHash(text)),
    link: (text) => chalk.hex(colors.mdLink)(text),
    linkUrl: (text) => muted(text),
    code: (text) => chalk.hex(colors.primary)(text),
    codeBlock: (text) => chalk.hex(colors.mdCodeBlock)(text),
    // Fenced code renders as a background panel: the decorative top and bottom
    // fence rows are dropped and every line is styled by `codeBlockLine`.
    codeBlockBorder: () => null,
    codeBlockIndent: ' ',
    codeBlockLine: (line, { index, lang, width }) => {
      const panel = chalk.bgHex(colors.mdCodeBlockBg);
      const labelPaint = chalk.bgHex(colors.mdCodeBlockBg).hex(colors.mdCodeBlock);
      // Clamp first: a line wider than the panel would be wrapped by the library,
      // and the wrapped remainder loses the panel gutter and background fill.
      const content =
        visibleWidth(line) > width - 1 ? truncateToWidth(line, Math.max(1, width - 1), '…') : line;
      const contentCells = visibleWidth(content);
      const rawLabel = index === 0 && lang !== undefined && lang.length > 0 ? ` ${lang}` : '';
      const labelCells = visibleWidth(rawLabel);
      // Only show the label when it leaves at least one cell of trailing padding,
      // otherwise the row would exceed the panel width and wrap.
      const showLabel = labelCells > 0 && 1 + contentCells + labelCells + 1 <= width;
      const filler = showLabel ? Math.max(0, width - contentCells - labelCells - 2) : 0;
      const padCells = showLabel ? 1 : Math.max(0, width - contentCells - 1);
      const label = showLabel ? chalk.italic(labelPaint(rawLabel)) : '';
      return `${panel(' ')}${panel(content)}${panel(' '.repeat(filler))}${label}${panel(' '.repeat(padCells))}`;
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
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code: string, lang?: string) => {
      const normalizedLang = lang?.trim().toLowerCase();
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

export function createEditorTheme(colors: ColorPalette): EditorTheme {
  const muted = chalk.hex(colors.textMuted);
  return {
    borderColor: (s) => chalk.hex(colors.border)(s),
    selectList: {
      selectedPrefix: (s) => chalk.hex(colors.primary)(s),
      selectedText: (s) => chalk.hex(colors.primary)(s),
      description: (s) => muted(s),
      scrollInfo: (s) => muted(s),
      noMatch: (s) => muted(s),
    },
  };
}
