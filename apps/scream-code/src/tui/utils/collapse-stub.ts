/**
 * The transcript bounds its memory in two places, and both stand in for the
 * rows they fold away with the same summary line: the shadow entry array
 * (`transcript-controller`) folds its oldest entries into one stub entry, and
 * the committed render tree (`committed-transcript`) folds its oldest child
 * components into one stub row. One definition of the wording keeps the two
 * folds reading alike — and lets the array fold read its own count back when
 * it folds again.
 */

/** Matches {@link formatCollapsedEntries} output, capturing the count. */
const COLLAPSE_STUB_PATTERN = /^…\((\d+) earlier entries collapsed\)$/;

/** Summary line that stands in for `count` folded-away entries. */
export function formatCollapsedEntries(count: number): string {
  return `…(${String(count)} earlier entries collapsed)`;
}

/** How many entries a summary line stands in for; 0 when `text` is not one. */
export function parseCollapsedEntries(text: string): number {
  const digits = COLLAPSE_STUB_PATTERN.exec(text)?.[1];
  return digits === undefined ? 0 : Number(digits);
}
