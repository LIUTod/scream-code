/**
 * Shared cli-highlight theme for code previews (tool-call Write/Edit,
 * approval panels, diff previews), mapped onto the ColorPalette so previews
 * follow the active theme instead of cli-highlight's built-in 16-color ANSI
 * palette (whose appearance is owned by the terminal, not the app).
 *
 * Token → semantic-color mapping deliberately mirrors the classic ANSI 16
 * color scheme users are used to (blue keywords, red strings, green numbers,
 * yellow functions, cyan built-ins) but resolves each hue through the
 * ColorPalette: the light palette keeps that familiar look, the dark palette
 * gets the corresponding bright variant, and both flip with the theme.
 */

import type { Theme } from 'cli-highlight';
import chalk from 'chalk';

import type { ColorPalette } from './colors';

export function createCodeHighlightTheme(colors: ColorPalette): Theme {
  const keyword = chalk.hex(colors.mdCodeBlock); // blue (keywords/types/tags)
  const str = chalk.hex(colors.mdLink); // cyan (strings/regexps) — not red, which reads as an error
  const num = chalk.hex(colors.primary); // green (numbers/comments)
  const fn = chalk.hex(colors.warning); // yellow (functions/names/attrs)
  const builtin = chalk.hex(colors.planMode); // cyan (built-ins/literals)
  const cls = chalk.hex(colors.accent); // pink (classes when not blue-mapped)
  const text = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textMuted);
  return {
    keyword,
    built_in: builtin,
    type: keyword,
    literal: builtin,
    number: num,
    regexp: str,
    string: str,
    subst: str,
    symbol: num,
    class: cls,
    function: fn,
    title: fn,
    params: text,
    comment: num,
    doctag: num,
    meta: muted,
    'meta-keyword': keyword,
    'meta-string': str,
    section: keyword,
    tag: keyword,
    name: fn,
    'builtin-name': builtin,
    attr: fn,
    attribute: fn,
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
    // CSS/HTML selectors and template literals (used by the css/html/jsx
    // grammars) — otherwise these render unstyled.
    'selector-tag': keyword,
    'selector-id': cls,
    'selector-class': cls,
    'selector-attr': fn,
    'selector-pseudo': fn,
    'template-tag': str,
    'template-variable': fn,
    // NOTE: intentionally no `default` mapping. With a default color,
    // cli-highlight tints every non-token span (identifiers, operators,
    // punctuation, whitespace) with colors.text — which breaks the diff
    // layering contract in renderDiffCode (non-token spans must stay
    // green/red for added/deleted lines) and, in plain previews, would
    // color the entire body instead of only syntax tokens.
  };
}
