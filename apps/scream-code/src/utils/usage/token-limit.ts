/**
 * Parsing and formatting for the session token limit (`/budget`,
 * `loop_control.max_session_tokens`).
 *
 * Pure and ANSI-free so the user-facing rules are trivial to unit-test: what a
 * person may type, and how a limit is shown back to them.
 */

export type TokenLimitParse =
  | { readonly kind: 'limit'; readonly tokens: number }
  | { readonly kind: 'off' }
  | { readonly kind: 'invalid' };

/** Words that mean "no limit", in both languages the product ships. */
const OFF_WORDS = new Set(['0', 'off', 'none', 'no', 'unlimited', 'disable', 'disabled', '关闭', '关', '不限', '无']);

/** `万` / `亿` are how Chinese-speaking users write large counts (500万 = 5M). */
const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  万: 10_000,
  亿: 100_000_000,
};

/**
 * An integer part, optionally grouped in threes by `,` `_` or a space
 * (`50,000,000`, `50_000_000`, `1 000 000`); an optional decimal part; an
 * optional unit; an optional trailing `token(s)`. Grouping is strict on purpose
 * — see `parseTokenLimit`.
 */
const NUMBER_WITH_UNIT = /^(\d{1,3}(?:[ ,_]\d{3})+|\d+)(\.\d+)?\s*([kmb万亿])?\s*(?:tokens?)?$/;

/**
 * Read what the user typed as a token limit.
 *
 * Accepts a plain integer (`50000000`) or one grouped in threes (`50_000_000`,
 * `50,000,000`), a number with a unit (`500k`, `20m`, `1.5b`, `500万`, `1亿`), an
 * optional trailing `token(s)`, and any case. Zero and the words in `OFF_WORDS`
 * mean "off". A decimal is only meaningful with a unit (`1.5m`); `1.5` alone is
 * rejected rather than silently rounded to a limit nobody asked for.
 *
 * Separators are only ever thousands grouping. `1,5m` is NOT 15m: a European
 * decimal comma would otherwise turn a 1.5M limit into 15M without a word, and a
 * limit that is ten times too high is the one mistake this setting exists to
 * prevent. Anything ambiguous is refused so the user is asked again.
 */
export function parseTokenLimit(input: string): TokenLimitParse {
  const text = input.trim().toLowerCase();
  if (text === '') return { kind: 'invalid' };
  if (OFF_WORDS.has(text.replaceAll(/\s+/g, ''))) return { kind: 'off' };

  const match = NUMBER_WITH_UNIT.exec(text);
  if (match === null) return { kind: 'invalid' };
  const [, integer, fraction, unit] = match;
  if (integer === undefined) return { kind: 'invalid' };
  if (unit === undefined && fraction !== undefined) return { kind: 'invalid' };

  const digits = integer.replaceAll(/[ ,_]/g, '') + (fraction ?? '');
  const tokens = Math.round(Number(digits) * (unit === undefined ? 1 : (MULTIPLIERS[unit] ?? 1)));
  if (!Number.isSafeInteger(tokens)) return { kind: 'invalid' };
  return tokens === 0 ? { kind: 'off' } : { kind: 'limit', tokens };
}

/**
 * A limit as shown to the user: `100000000` → `100M`, `1250000` → `1.25M`.
 * Trailing zeros are dropped (unlike `/usage`'s one-decimal counts) because a
 * limit is a number the user typed, and `100.0M` reads like a different number.
 */
export function formatTokenLimit(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  const units = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'k'],
  ] as const;
  for (const [index, [size, unit]] of units.entries()) {
    if (tokens < size) continue;
    const scaled = Number((tokens / size).toFixed(2));
    // Two decimals can round up to 1000 of this unit (999_999 → "1000k"): that
    // is one of the next unit up.
    const larger = units[index - 1];
    if (scaled >= 1000 && larger !== undefined) {
      return `${String(Number((tokens / larger[0]).toFixed(2)))}${larger[1]}`;
    }
    return `${String(scaled)}${unit}`;
  }
  return String(Math.round(tokens));
}
