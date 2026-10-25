/**
 * Mention detection for the room composer.
 *
 * The composer is a plain textarea, so the active token is derived from the
 * text and the caret: an `@` that starts the text or follows whitespace, with
 * no whitespace between it and the caret. Anything else (an email address, a
 * finished mention) is not a token.
 */
export interface MentionToken {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

const WHITESPACE = /\s/;

export function mentionTokenAt(value: string, caret: number): MentionToken | null {
  const at = Math.min(Math.max(caret, 0), value.length);
  let index = at - 1;
  while (index >= 0) {
    const char = value[index] ?? "";
    if (char === "@") {
      const before = index === 0 ? "" : (value[index - 1] ?? "");
      if (index > 0 && !WHITESPACE.test(before)) return null;
      return { query: value.slice(index + 1, at), start: index, end: at };
    }
    if (WHITESPACE.test(char)) return null;
    index -= 1;
  }
  return null;
}

/** Replace the active token with `@Name ` and report where the caret lands. */
export function applyMention(
  value: string,
  token: MentionToken,
  name: string,
): { readonly value: string; readonly caret: number } {
  const before = value.slice(0, token.start);
  const after = value.slice(token.end).replace(/^\s+/, "");
  const insert = `@${name} `;
  return { value: `${before}${insert}${after}`, caret: before.length + insert.length };
}

/** Prefix matches first, then substring matches — both case-insensitive. */
export function filterMentions<T extends { readonly name: string }>(
  people: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...people];
  const starts: T[] = [];
  const contains: T[] = [];
  for (const person of people) {
    const name = person.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(person);
    else if (name.includes(needle)) contains.push(person);
  }
  return [...starts, ...contains];
}
