/**
 * Ripgrep pattern sanitization and error detection.
 *
 * Users frequently search for code fragments that contain regex metacharacters
 * (e.g. `fetchFoo(`, `${platform}`, `a{3`). ripgrep uses the Rust `regex`
 * crate, which rejects unescaped `{`/`}` that do not form a valid repetition
 * quantifier (`{N}`, `{N,}`, `{N,M}`). This module pre-cleans such braces so
 * the common case "search for a literal-ish fragment" succeeds without a
 * syntax error.
 *
 * When sanitization is insufficient (e.g. unbalanced parentheses), the caller
 * can detect the regex error from ripgrep stderr and retry with
 * `--fixed-strings`, which treats the pattern as a literal string.
 */

/** Matches the inner content of a valid repetition quantifier: `N`, `N,`, `N,M`. */
const QUANTIFIER_INNER_RE = /^\d+(?:,\d*)?$/;

/**
 * Escape `{` and `}` that cannot form a valid repetition quantifier so they
 * are treated as literals by the regex engine.
 *
 * Already-escaped braces (`\{`, `\}`) are preserved. Valid quantifiers
 * (`{3}`, `{2,}`, `{1,5}`) are preserved. Everything else is escaped.
 *
 * Escaping braces inside character classes (e.g. `[{]`) is also safe:
 * `\{` inside `[...]` matches a literal `{` just like an unescaped `{` would.
 */
export function sanitizeRgPattern(pattern: string): string {
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    // Preserve escape sequences (e.g. `\{`, `\}`, `\d`).
    if (ch === '\\' && i + 1 < pattern.length) {
      result += pattern.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '{') {
      const closeIdx = pattern.indexOf('}', i + 1);
      if (closeIdx !== -1) {
        const inner = pattern.slice(i + 1, closeIdx);
        if (QUANTIFIER_INNER_RE.test(inner)) {
          // Valid quantifier — preserve verbatim.
          result += pattern.slice(i, closeIdx + 1);
          i = closeIdx + 1;
          continue;
        }
      }
      // Not a valid quantifier — escape the brace.
      result += '\\{';
      i++;
      continue;
    }
    if (ch === '}') {
      // A `}` that was part of a quantifier was consumed when the `{` was
      // processed. Reaching here means it is standalone — escape it.
      result += '\\}';
      i++;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/** Substrings that indicate ripgrep failed to parse the regex pattern. */
const REGEX_ERROR_MARKERS = [
  'regex parse error',
  'unrecognized escape',
  'unclosed group',
  'unbalanced',
  'unexpected repetition',
] as const;

/**
 * Detect whether ripgrep's stderr indicates a regex syntax error (as opposed
 * to a filesystem or runtime error). Used to decide whether a
 * `--fixed-strings` fallback retry is worthwhile.
 */
export function isRegexSyntaxError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return REGEX_ERROR_MARKERS.some((marker) => lower.includes(marker));
}
