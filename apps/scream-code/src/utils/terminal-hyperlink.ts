/**
 * Terminal hyperlink helpers (OSC 8).
 *
 * Terminals that implement OSC 8 — iTerm2, Ghostty, kitty, VS Code, recent
 * Terminal.app — mark the wrapped text as a link; the TUI opens it through the
 * alt-screen `openUrl` callback. That gesture is a **single click**: the SGR
 * mouse protocol carries no Cmd/Super modifier, so the application can never
 * require one. The escapes are zero-width and pi-tui's `wrapTextWithAnsi`
 * re-opens the active link on every soft-wrapped continuation line, so wrapping
 * never changes the visible layout.
 *
 * `toTerminalHyperlink` wraps a known text/URL pair (file links in plan boxes
 * and session commands); `wrapUrlsAsHyperlinks` finds bare URLs inside prose,
 * which is how tool output (WebSearch, PaperSearch, FetchURL) delivers links.
 */

/**
 * Bare http(s) URLs. The stop set is deliberately wide:
 *
 * - control characters and whitespace, because `\S` alone would swallow a
 *   following ANSI reset (or an adjacent OSC sequence) into the link target;
 * - CJK / full-width / general punctuation, because CJK prose has no spaces —
 *   `详见 https://x/docs。谢谢` must link `…/docs` and leave `。谢谢` outside.
 *
 * Ideographs stay allowed so IRI paths (`https://例え.jp/パス`) keep working.
 */
const HTTP_URL_PATTERN = /https?:\/\/[^\s\u0000-\u001F\u007F\u2000-\u206F\u3000-\u303F\uFF00-\uFFEF]+/g;

/** An already emitted OSC 8 link marker — open or close, BEL or ST terminated. */
const EXISTING_OSC8 = /\u001B\]8;;[^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

/**
 * Punctuation that belongs to the prose rather than to the link: ASCII,
 * full-width and CJK forms, plus the markdown markers (`*`, `>`, `_`) that
 * reach the plain-text renderers verbatim. Closing brackets are handled
 * separately because a balanced one (`…/Memory_(disambiguation)`) is part of
 * the URL.
 */
const TRAILING_PUNCTUATION = /[.,;:!?"'*>_。，、；：！？…·]+$/;

const BRACKET_PAIRS = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['（', '）'],
  ['【', '】'],
  ['《', '》'],
  ['「', '」'],
  ['『', '』'],
] as const;

function countChar(text: string, char: string): number {
  let count = 0;
  for (const current of text) {
    if (current === char) count += 1;
  }
  return count;
}

/** Drop trailing closing brackets that have no opening counterpart inside the URL. */
function trimBrackets(url: string): string {
  let result = url;
  for (const [open, close] of BRACKET_PAIRS) {
    while (result.endsWith(close) && countChar(result, close) > countChar(result, open)) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

/**
 * Drop sentence punctuation from the end of a matched URL, alternating with
 * bracket trimming until nothing changes: `…/a.)` has to lose the bracket and
 * then the full stop, while `…/Memory_(disambiguation)` keeps both.
 */
export function trimUrlTail(candidate: string): string {
  let url = candidate;
  for (;;) {
    const trimmed = trimBrackets(url.replace(TRAILING_PUNCTUATION, ''));
    if (trimmed === url) return url;
    url = trimmed;
  }
}

export function toTerminalHyperlink(text: string, url: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

/** True when `text` contains an http(s) URL. */
export function hasHttpUrl(text: string): boolean {
  HTTP_URL_PATTERN.lastIndex = 0;
  return HTTP_URL_PATTERN.test(text);
}

/**
 * Wrap every bare http(s) URL in `text` as an OSC 8 hyperlink. `style` styles
 * the visible URL text (defaults to plain), and punctuation that trails the URL
 * is emitted outside the link so it keeps the surrounding tone.
 *
 * Links the text already carries are dropped first: re-wrapping them would nest
 * OSC sequences and mangle the escape stream, and the visible text is identical
 * either way.
 */
export function wrapUrlsAsHyperlinks(text: string, style?: (url: string) => string): string {
  if (!text.includes('://')) return text;
  return text.replaceAll(EXISTING_OSC8, '').replace(HTTP_URL_PATTERN, (match) => {
    const url = trimUrlTail(match);
    if (url.length === 0) return match;
    const trailing = match.slice(url.length);
    return `${toTerminalHyperlink(style ? style(url) : url, url)}${trailing}`;
  });
}
