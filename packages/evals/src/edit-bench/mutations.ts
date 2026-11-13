/**
 * Mutation library for the edit benchmark.
 *
 * Each mutation class corrupts a fixture in one specific way (single-site
 * rename, indentation, comment text, ...) so a model can be asked to repair
 * it with a surgical Edit call. Classes are pure:
 *
 * - `canApply` never consumes randomness and has no side effects; calling it
 *   twice on the same content yields the same answer.
 * - `mutate` uses only the passed `rng`, so a (class, fixture, seed) triple
 *   always produces the same corruption.
 * - `fix` inverts the corruption by token / line-content search — the
 *   recorded line number is only a fast path — so it also works on content
 *   that was externally shifted after the mutation (see `external-shift`).
 *
 * `hunks` records the exact index-based replacements that produced the
 * corrupted content; `applyMutation` replays them. Composite classes
 * (`multi-hunk-double`, `external-shift`) fold sub-results via `parts`.
 */

export interface TextHunk {
  /** Inclusive start index in the content the hunk applies to. */
  readonly start: number;
  /** Exclusive end index. */
  readonly end: number;
  readonly replacement: string;
}

/** Neighbour lines of a mutated line, used for unambiguous relocation. */
export interface MutationContext {
  readonly before?: string;
  readonly after?: string;
}

export interface MutationResult {
  /** The untouched snippet the mutation replaced (token or full line). */
  readonly originalSnippet: string;
  /** The corrupted snippet now present in the mutated content. */
  readonly mutatedSnippet: string;
  /** 1-based line of the primary hunk in the content it was applied to. */
  readonly line?: number;
  /** Index-based replacements that produce the corrupted content. */
  readonly hunks?: readonly TextHunk[];
  /** Neighbour lines of the mutated line, for line-level relocations. */
  readonly context?: MutationContext;
  /** Sub-mutations of a compound class, applied in order. */
  readonly parts?: readonly MutationPart[];
  /** External shift the harness applies after the mutation (recovery). */
  readonly shift?: ExternalShift;
}

export interface MutationPart {
  /** Name of the MutationClass that owns `result`. */
  readonly className: string;
  readonly result: MutationResult;
}

export interface ExternalShift {
  /** 1-based line: blank lines are inserted before it, or deleted from it. */
  readonly atLine: number;
  readonly count: number;
  readonly mode: 'insert' | 'delete';
}

export interface MutationClass {
  readonly name: string;
  readonly category: string;
  readonly multiHunk?: boolean;
  canApply(content: string): boolean;
  mutate(content: string, rng: () => number): MutationResult | null;
  /** Repair instruction for the prompt. For `external-shift` the quoted line
   *  numbers are deliberately stale (pre-shift). */
  instruction(result: MutationResult, fixtureName: string): string;
  /** Inverse of `mutate`: turn corrupted content back into the correct state. */
  fix(content: string, result: MutationResult): string;
}

/**
 * Deterministic Lehmer (MINSTD) PRNG: same seed → same sequence, values in
 * [0,1). The state stays below 2^31 and the update below 2^47, so the
 * arithmetic is exact in double precision and needs no 32-bit wrapping ops.
 */
export function seededRng(seed: number): () => number {
  const MODULUS = 2147483647; // 2^31 - 1
  let state = Math.trunc(Math.abs(Math.trunc(seed))) % MODULUS;
  if (state === 0) state = 1;
  return () => {
    state = (state * 48271) % MODULUS;
    return (state - 1) / (MODULUS - 1);
  };
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

const WORD_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const IDENTIFIER_START_BOUNDARY = '(?<![A-Za-z0-9_$])';
const IDENTIFIER_END_BOUNDARY = '(?![A-Za-z0-9_$])';
const RENAMABLE_MIN_LENGTH = 3;
const LONG_LINE_MIN_CHARS = 300;
const COMMENT_MIN_CHARS = 12;
const DUPLICABLE_MIN_CHARS = 8;

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'bigint', 'boolean', 'break', 'case',
  'catch', 'class', 'constructor', 'const', 'continue', 'declare', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer',
  'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace', 'new', 'null',
  'number', 'object', 'of', 'private', 'protected', 'public', 'readonly',
  'return', 'satisfies', 'set', 'static', 'string', 'super', 'switch', 'symbol',
  'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown',
  'var', 'void', 'while', 'yield',
]);

interface WordOccurrence {
  readonly index: number;
  readonly line: number;
}

interface PlainLiteral {
  readonly index: number;
  readonly text: string;
}

interface Corrupted {
  readonly content: string;
  readonly result: MutationResult;
}

type Corruptor = (content: string, rng: () => number) => Corrupted | null;

function splitLines(content: string): string[] {
  return content.split('\n');
}

function lineCountOf(content: string): number {
  return splitLines(content).length;
}

function lineTextAt(content: string, line: number): string | undefined {
  return splitLines(content)[line - 1];
}

/** 1-based line number of a character index. */
function lineNumberOfIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.codePointAt(i) === 10) line += 1;
  }
  return line;
}

function isCommentOnlyLine(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
  );
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function isWholeWordAt(content: string, index: number, length: number): boolean {
  const before = index > 0 ? content[index - 1] : undefined;
  const after = content[index + length];
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

/** 1-based [start, end) span of a line inside the content. */
function lineSpan(content: string, line: number): { start: number; end: number } {
  let start = 0;
  for (let i = 1; i < line; i += 1) {
    const next = content.indexOf('\n', start);
    if (next === -1) break;
    start = next + 1;
  }
  let end = content.indexOf('\n', start);
  if (end === -1) end = content.length;
  return { start, end };
}

function contextAround(content: string, line: number): MutationContext {
  const lines = splitLines(content);
  return { before: lines[line - 2], after: lines[line] };
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word replacement of every `from` occurrence. */
function replaceWholeWordAll(content: string, from: string, to: string): string {
  if (from.length === 0) return content;
  const pattern = new RegExp(
    `${IDENTIFIER_START_BOUNDARY}${escapeRegExp(from)}${IDENTIFIER_END_BOUNDARY}`,
    'g',
  );
  return content.replace(pattern, () => to);
}

/** Whole-word code occurrences (comment-only lines excluded) of a word. */
function findWordOccurrences(content: string, word: string): WordOccurrence[] {
  const occurrences: WordOccurrence[] = [];
  const lines = splitLines(content);
  let from = 0;
  for (;;) {
    const index = content.indexOf(word, from);
    if (index === -1) break;
    from = index + word.length;
    if (!isWholeWordAt(content, index, word.length)) continue;
    const line = lineNumberOfIndex(content, index);
    const text = lines[line - 1];
    if (text === undefined || isCommentOnlyLine(text)) continue;
    occurrences.push({ index, line });
  }
  return occurrences;
}

/** All identifier-shaped whole words in code lines, with occurrence lists. */
function collectWordOccurrences(content: string): Map<string, WordOccurrence[]> {
  const occurrences = new Map<string, WordOccurrence[]>();
  const lines = splitLines(content);
  for (const match of content.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (word === undefined || match.index === undefined) continue;
    if (word.length < RENAMABLE_MIN_LENGTH) continue;
    if (!isWholeWordAt(content, match.index, word.length)) continue;
    const line = lineNumberOfIndex(content, match.index);
    const text = lines[line - 1];
    if (text === undefined || isCommentOnlyLine(text)) continue;
    const existing = occurrences.get(word) ?? [];
    existing.push({ index: match.index, line });
    occurrences.set(word, existing);
  }
  return occurrences;
}

/** Identifiers that occur at least `minCount` times in code lines. */
function listRenamableIdentifiers(content: string, minCount: number): string[] {
  const words: string[] = [];
  for (const [word, occurrences] of collectWordOccurrences(content)) {
    if (occurrences.length >= minCount && !RESERVED_WORDS.has(word)) {
      words.push(word);
    }
  }
  return words;
}

type MisspellStrategy = (word: string, rng: () => number) => string | null;

const SWAP_ADJACENT: MisspellStrategy = (word, rng) => {
  if (word.length < 4) return null;
  const i = 1 + Math.floor(rng() * (word.length - 2));
  return word.slice(0, i) + word.charAt(i + 1) + word.charAt(i) + word.slice(i + 2);
};

const DOUBLE_CHAR: MisspellStrategy = (word, rng) => {
  const i = Math.floor(rng() * word.length);
  return word.slice(0, i + 1) + word.charAt(i) + word.slice(i + 1);
};

const DROP_CHAR: MisspellStrategy = (word, rng) => {
  if (word.length < 4) return null;
  const i = 1 + Math.floor(rng() * (word.length - 2));
  return word.slice(0, i) + word.slice(i + 1);
};

const APPEND_CHAR: MisspellStrategy = (word, rng) => {
  return rng() < 0.5 ? `${word}x` : `${word}z`;
};

const MISSPELL_STRATEGIES: readonly MisspellStrategy[] = [
  SWAP_ADJACENT,
  DOUBLE_CHAR,
  DROP_CHAR,
  APPEND_CHAR,
];

/** Produces a misspelled variant that does not already occur in the content. */
function misspell(word: string, rng: () => number, content: string): string {
  const offset = Math.floor(rng() * MISSPELL_STRATEGIES.length);
  for (let step = 0; step < MISSPELL_STRATEGIES.length; step += 1) {
    const strategy = MISSPELL_STRATEGIES[(offset + step) % MISSPELL_STRATEGIES.length];
    const candidate = strategy?.(word, rng);
    if (candidate === null || candidate === undefined || candidate === word) continue;
    if (findWordOccurrences(content, candidate).length > 0) continue;
    return candidate;
  }
  for (const suffix of ['x', 'xx', 'zz']) {
    const candidate = word + suffix;
    if (findWordOccurrences(content, candidate).length === 0) return candidate;
  }
  return `${word}x`;
}

function leadingWhitespace(text: string): string {
  const match = /^[ \t]*/.exec(text);
  return match?.[0] ?? '';
}

/** First plain decimal literal that is not part of an identifier. */
function firstPlainNumberLiteral(text: string): PlainLiteral | null {
  const pattern = /(?<![A-Za-z0-9_$])\d+(?![A-Za-z0-9_$])/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    if (value === undefined || match.index === undefined) continue;
    return { index: match.index, text: value };
  }
  return null;
}

function shuffledIndices(count: number, rng: () => number): number[] {
  const indices = Array.from({ length: count }, (_, i) => i);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rng() * (count - i));
    const a = indices[i];
    const b = indices[j];
    if (a === undefined || b === undefined) continue;
    indices[i] = b;
    indices[j] = a;
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Corruptors: (content, rng) → corrupted content + result record
// ---------------------------------------------------------------------------

function corruptIdentifierSingle(content: string, rng: () => number): Corrupted | null {
  const words = listRenamableIdentifiers(content, 2);
  if (words.length === 0) return null;
  const word = words[Math.floor(rng() * words.length)];
  if (word === undefined) return null;
  const occurrences = findWordOccurrences(content, word);
  const occurrence = occurrences[Math.floor(rng() * occurrences.length)];
  if (occurrence === undefined) return null;
  const variant = misspell(word, rng, content);
  return {
    content:
      content.slice(0, occurrence.index) +
      variant +
      content.slice(occurrence.index + word.length),
    result: {
      originalSnippet: word,
      mutatedSnippet: variant,
      line: occurrence.line,
      hunks: [
        {
          start: occurrence.index,
          end: occurrence.index + word.length,
          replacement: variant,
        },
      ],
    },
  };
}

function corruptIdentifierMulti(content: string, rng: () => number): Corrupted | null {
  const words = listRenamableIdentifiers(content, 4);
  if (words.length === 0) return null;
  const word = words[Math.floor(rng() * words.length)];
  if (word === undefined) return null;
  const occurrences = findWordOccurrences(content, word);
  const pool = [...occurrences];
  const chosen: WordOccurrence[] = [];
  while (chosen.length < 3 && pool.length > 0) {
    const pick = Math.floor(rng() * pool.length);
    const occurrence = pool[pick];
    if (occurrence === undefined) break;
    pool.splice(pick, 1);
    chosen.push(occurrence);
  }
  if (chosen.length < 3) return null;
  const variant = misspell(word, rng, content);
  const ordered = chosen.toSorted((a, b) => a.index - b.index);
  let mutated = content;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const occurrence = ordered[i];
    if (occurrence === undefined) continue;
    mutated =
      mutated.slice(0, occurrence.index) +
      variant +
      mutated.slice(occurrence.index + word.length);
  }
  return {
    content: mutated,
    result: {
      originalSnippet: word,
      mutatedSnippet: variant,
      line: Math.min(...ordered.map((occurrence) => occurrence.line)),
      hunks: ordered.map((occurrence) => ({
        start: occurrence.index,
        end: occurrence.index + word.length,
        replacement: variant,
      })),
    },
  };
}

function listIndentableLines(content: string): number[] {
  const lines = splitLines(content);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text === undefined) continue;
    if (text.trim().length === 0 || isCommentOnlyLine(text)) continue;
    out.push(i + 1);
  }
  return out;
}

function corruptWhitespace(content: string, rng: () => number): Corrupted | null {
  const candidates = listIndentableLines(content);
  if (candidates.length === 0) return null;
  const line = candidates[Math.floor(rng() * candidates.length)];
  if (line === undefined) return null;
  const text = lineTextAt(content, line);
  if (text === undefined) return null;
  const indent = leadingWhitespace(text);
  const dedent = indent.length >= 2 && rng() < 0.5;
  const newIndent = dedent ? indent.slice(0, indent.length - 2) : `${indent}  `;
  const mutatedLine = newIndent + text.slice(indent.length);
  if (mutatedLine === text) return null;
  const { start, end } = lineSpan(content, line);
  return {
    content: content.slice(0, start) + mutatedLine + content.slice(end),
    result: {
      originalSnippet: text,
      mutatedSnippet: mutatedLine,
      line,
      hunks: [{ start, end, replacement: mutatedLine }],
      context: contextAround(content, line),
    },
  };
}

/**
 * Fixed wrong-comment texts comment-swap injects. Exported so tests can
 * build fixtures that collide with every possible corruption.
 */
export const WRONG_COMMENT_TEXTS: readonly string[] = [
  'NOTE: this branch is unreachable and exists only for the type checker.',
  'NOTE: kept for backwards compatibility; do not extend it.',
  'FIXME: temporary workaround, remove once the retry queue ships.',
  'TODO: replace this with the streaming implementation.',
  'NOTE: callers must hold the index lock before reaching this point.',
  'FIXME: this path drops the last element; pending an upstream fix.',
];

const COMMENT_DIRECTIVE_RE =
  /^\/\/\s*(?:eslint|biome|jshint|tslint|istanbul|c8|v8|oxlint|deno-lint|prettier-ignore|@ts-|@ts-check)/i;

function listCommentLines(content: string): number[] {
  const lines = splitLines(content);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text === undefined) continue;
    const match = /^(\s*)\/\/\s?(.+)$/.exec(text);
    if (match === null) continue;
    const body = match[2] ?? '';
    if (body.trim().length < COMMENT_MIN_CHARS) continue;
    if (COMMENT_DIRECTIVE_RE.test(body)) continue;
    out.push(i + 1);
  }
  return out;
}

function corruptComment(content: string, rng: () => number): Corrupted | null {
  const candidates = listCommentLines(content);
  if (candidates.length === 0) return null;
  const line = candidates[Math.floor(rng() * candidates.length)];
  if (line === undefined) return null;
  const text = lineTextAt(content, line);
  if (text === undefined) return null;
  const match = /^(\s*)\/\/\s?(.*)$/.exec(text);
  if (match === null) return null;
  const indent = match[1] ?? '';
  const wrongText = WRONG_COMMENT_TEXTS[Math.floor(rng() * WRONG_COMMENT_TEXTS.length)];
  if (wrongText === undefined) return null;
  const mutatedLine = `${indent}// ${wrongText}`;
  if (mutatedLine === text) return null;
  const { start, end } = lineSpan(content, line);
  return {
    content: content.slice(0, start) + mutatedLine + content.slice(end),
    result: {
      originalSnippet: text,
      mutatedSnippet: mutatedLine,
      line,
      hunks: [{ start, end, replacement: mutatedLine }],
      context: contextAround(content, line),
    },
  };
}

/** Read-window boundary segments the boundary-splice class targets. */
const READ_WINDOWS: readonly { readonly start: number; readonly end: number }[] = [
  { start: 380, end: 420 },
  { start: 980, end: 1020 },
];

function boundaryWindows(content: string): typeof READ_WINDOWS {
  const total = lineCountOf(content);
  return READ_WINDOWS.filter((window) => total >= window.end);
}

function listSpliceableLines(content: string): number[] {
  const windows = boundaryWindows(content);
  if (windows.length === 0) return [];
  const lines = splitLines(content);
  const out: number[] = [];
  for (const window of windows) {
    for (let line = window.start; line <= Math.min(window.end, lines.length); line += 1) {
      const text = lines[line - 1];
      if (text === undefined) continue;
      if (text.trim().length === 0 || isCommentOnlyLine(text)) continue;
      if (firstPlainNumberLiteral(text) === null) continue;
      out.push(line);
    }
  }
  return out;
}

function corruptBoundary(content: string, rng: () => number): Corrupted | null {
  const candidates = listSpliceableLines(content);
  if (candidates.length === 0) return null;
  const line = candidates[Math.floor(rng() * candidates.length)];
  if (line === undefined) return null;
  const text = lineTextAt(content, line);
  if (text === undefined) return null;
  const literal = firstPlainNumberLiteral(text);
  if (literal === null) return null;
  const value = Number.parseInt(literal.text, 10);
  if (Number.isNaN(value)) return null;
  const replacement = String(value + 7);
  const { start: lineStart } = lineSpan(content, line);
  const literalStart = lineStart + literal.index;
  const mutatedLine =
    text.slice(0, literal.index) +
    replacement +
    text.slice(literal.index + literal.text.length);
  return {
    content:
      content.slice(0, literalStart) +
      replacement +
      content.slice(literalStart + literal.text.length),
    result: {
      originalSnippet: text,
      mutatedSnippet: mutatedLine,
      line,
      hunks: [
        {
          start: literalStart,
          end: literalStart + literal.text.length,
          replacement,
        },
      ],
      context: contextAround(content, line),
    },
  };
}

function listDuplicableLines(content: string): number[] {
  const lines = splitLines(content);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text === undefined) continue;
    if (text.trim().length < DUPLICABLE_MIN_CHARS) continue;
    if (isCommentOnlyLine(text)) continue;
    out.push(i + 1);
  }
  return out;
}

/** A copy of the line that differs by exactly one token (number or word). */
function nearDuplicateLine(content: string, line: number, rng: () => number): string | null {
  const text = lineTextAt(content, line);
  if (text === undefined) return null;
  const literal = firstPlainNumberLiteral(text);
  if (literal !== null) {
    const value = Number.parseInt(literal.text, 10);
    if (!Number.isNaN(value)) {
      return (
        text.slice(0, literal.index) +
        String(value + 1) +
        text.slice(literal.index + literal.text.length)
      );
    }
  }
  const { start: lineStart } = lineSpan(content, line);
  const words: { word: string; index: number }[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (word === undefined || match.index === undefined) continue;
    if (word.length < RENAMABLE_MIN_LENGTH || RESERVED_WORDS.has(word)) continue;
    if (!isWholeWordAt(content, lineStart + match.index, word.length)) continue;
    words.push({ word, index: match.index });
  }
  if (words.length === 0) return null;
  const pick = words[Math.floor(rng() * words.length)];
  if (pick === undefined) return null;
  const variant = misspell(pick.word, rng, content);
  return text.slice(0, pick.index) + variant + text.slice(pick.index + pick.word.length);
}

function findAdjacentPair(content: string, first: string, second: string): number {
  const lines = splitLines(content);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (lines[i] === first && lines[i + 1] === second) return i;
  }
  return -1;
}

function corruptDuplicate(content: string, rng: () => number): Corrupted | null {
  const candidates = listDuplicableLines(content);
  if (candidates.length === 0) return null;
  const offset = Math.floor(rng() * candidates.length);
  for (let step = 0; step < candidates.length; step += 1) {
    const line = candidates[(offset + step) % candidates.length];
    if (line === undefined) continue;
    const text = lineTextAt(content, line);
    if (text === undefined) continue;
    const dup = nearDuplicateLine(content, line, rng);
    if (dup === null || dup === text) continue;
    // The inserted copy must not already sit above an identical line
    // elsewhere, or the repair would be ambiguous.
    if (findAdjacentPair(content, dup, text) !== -1) continue;
    const { start: lineStart } = lineSpan(content, line);
    return {
      content: content.slice(0, lineStart) + dup + '\n' + content.slice(lineStart),
      result: {
        originalSnippet: text,
        mutatedSnippet: dup,
        line,
        hunks: [{ start: lineStart, end: lineStart, replacement: `${dup}\n` }],
      },
    };
  }
  return null;
}

function listLongLines(content: string): number[] {
  const lines = splitLines(content);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text !== undefined && text.length >= LONG_LINE_MIN_CHARS) out.push(i + 1);
  }
  return out;
}

function corruptLongLine(content: string, rng: () => number): Corrupted | null {
  const longLines = listLongLines(content);
  if (longLines.length === 0) return null;
  const offset = Math.floor(rng() * longLines.length);
  for (let step = 0; step < longLines.length; step += 1) {
    const line = longLines[(offset + step) % longLines.length];
    if (line === undefined) continue;
    const text = lineTextAt(content, line);
    if (text === undefined) continue;
    const { start: lineStart } = lineSpan(content, line);
    const tokens: { word: string; index: number }[] = [];
    for (const match of text.matchAll(WORD_PATTERN)) {
      const word = match[0];
      if (word === undefined || match.index === undefined) continue;
      if (word.length < RENAMABLE_MIN_LENGTH || RESERVED_WORDS.has(word)) continue;
      if (!isWholeWordAt(content, lineStart + match.index, word.length)) continue;
      tokens.push({ word, index: match.index });
    }
    if (tokens.length === 0) continue;
    const token = tokens[Math.floor(rng() * tokens.length)];
    if (token === undefined) continue;
    const variant = misspell(token.word, rng, content);
    return {
      content:
        content.slice(0, lineStart + token.index) +
        variant +
        content.slice(lineStart + token.index + token.word.length),
      result: {
        originalSnippet: token.word,
        mutatedSnippet: variant,
        line,
        hunks: [
          {
            start: lineStart + token.index,
            end: lineStart + token.index + token.word.length,
            replacement: variant,
          },
        ],
      },
    };
  }
  return null;
}

const CORRUPTORS: Readonly<Record<string, Corruptor>> = {
  'identifier-rename': corruptIdentifierSingle,
  'identifier-rename-multi': corruptIdentifierMulti,
  'subtle-whitespace': corruptWhitespace,
  'comment-swap': corruptComment,
  'boundary-splice': corruptBoundary,
  'duplicate-line': corruptDuplicate,
  'long-line-splice': corruptLongLine,
};

// ---------------------------------------------------------------------------
// Repair-time helpers: relocate corrupted lines (shift-tolerant)
// ---------------------------------------------------------------------------

/**
 * Finds the corrupted line inside possibly-shifted content: exact line
 * fast path, then unique match, then neighbour-context match, then the match
 * closest to the recorded position.
 */
function locateLine(lines: readonly string[], result: MutationResult): number {
  const target = result.mutatedSnippet;
  const expectedIndex = (result.line ?? 1) - 1;
  if (lines[expectedIndex] === target) return expectedIndex;
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === target) matches.push(i);
  }
  const single = matches.length === 1 ? matches[0] : undefined;
  if (single !== undefined) return single;
  const context = result.context;
  if (context !== undefined) {
    for (const index of matches) {
      if (context.before !== undefined && lines[index - 1] === context.before) return index;
      if (context.after !== undefined && lines[index + 1] === context.after) return index;
    }
  }
  let best = matches[0] ?? -1;
  let bestDistance = Math.abs(best - expectedIndex);
  for (const index of matches) {
    const distance = Math.abs(index - expectedIndex);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Restores the corrupted line to its original text, wherever it now sits. */
function restoreLine(content: string, result: MutationResult): string {
  const lines = splitLines(content);
  const index = locateLine(lines, result);
  if (index === -1) return content;
  lines[index] = result.originalSnippet;
  return lines.join('\n');
}

function fixParts(content: string, result: MutationResult): string {
  let fixed = content;
  // Parts are fixed in reverse application order: a later line-level part can
  // sit on the same line as an earlier token-level part, and its whole-line
  // restore keeps the earlier part's token mutation — the token fix must run
  // after the line is back in place, not before.
  const parts = result.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part === undefined) continue;
    const partClass = mutationClassByName(part.className);
    if (partClass === undefined) continue;
    fixed = partClass.fix(fixed, part.result);
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// Mutation classes
// ---------------------------------------------------------------------------

class IdentifierRenameMutation implements MutationClass {
  readonly name = 'identifier-rename';
  readonly category = 'surgical';

  canApply(content: string): boolean {
    return listRenamableIdentifiers(content, 2).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    return corruptIdentifierSingle(content, rng)?.result ?? null;
  }

  instruction(result: MutationResult, _fixtureName: string): string {
    return (
      `the identifier "${result.mutatedSnippet}" on line ${result.line} is a misspelling; ` +
      `rename that one occurrence back to "${result.originalSnippet}" so it matches the other uses of the name`
    );
  }

  fix(content: string, result: MutationResult): string {
    return replaceWholeWordAll(content, result.mutatedSnippet, result.originalSnippet);
  }
}

class IdentifierRenameMultiMutation implements MutationClass {
  readonly name = 'identifier-rename-multi';
  readonly category = 'multi-hunk';
  readonly multiHunk = true;

  canApply(content: string): boolean {
    return listRenamableIdentifiers(content, 4).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    return corruptIdentifierMulti(content, rng)?.result ?? null;
  }

  instruction(result: MutationResult, _fixtureName: string): string {
    const sites = result.hunks?.length ?? 0;
    return (
      `the identifier "${result.mutatedSnippet}" is a misspelling of "${result.originalSnippet}" ` +
      `introduced at ${sites} places (first on line ${result.line}); ` +
      'fix every occurrence so the name is consistent again'
    );
  }

  fix(content: string, result: MutationResult): string {
    return replaceWholeWordAll(content, result.mutatedSnippet, result.originalSnippet);
  }
}

class SubtleWhitespaceMutation implements MutationClass {
  readonly name = 'subtle-whitespace';
  readonly category = 'whitespace';

  canApply(content: string): boolean {
    return listIndentableLines(content).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    return corruptWhitespace(content, rng)?.result ?? null;
  }

  instruction(result: MutationResult, _fixtureName: string): string {
    return (
      `line ${result.line} has the wrong indentation (off by two spaces); ` +
      `fix that line's indentation so it matches the surrounding block`
    );
  }

  fix(content: string, result: MutationResult): string {
    return restoreLine(content, result);
  }
}

class CommentSwapMutation implements MutationClass {
  readonly name = 'comment-swap';
  readonly category = 'comment';

  canApply(content: string): boolean {
    return listCommentLines(content).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    return corruptComment(content, rng)?.result ?? null;
  }

  instruction(result: MutationResult, _fixtureName: string): string {
    return (
      `the comment on line ${result.line} describes the wrong thing; ` +
      `replace that comment with exactly: ${result.originalSnippet.trim()}`
    );
  }

  fix(content: string, result: MutationResult): string {
    return restoreLine(content, result);
  }
}

class BoundarySpliceMutation implements MutationClass {
  readonly name = 'boundary-splice';
  readonly category = 'boundary';

  canApply(content: string): boolean {
    return listSpliceableLines(content).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    return corruptBoundary(content, rng)?.result ?? null;
  }

  instruction(result: MutationResult, _fixtureName: string): string {
    const before = firstPlainNumberLiteral(result.originalSnippet)?.text ?? '?';
    const after = firstPlainNumberLiteral(result.mutatedSnippet)?.text ?? '?';
    return (
      `line ${result.line} contains a wrong numeric literal: "${after}" should be "${before}"; ` +
      'fix that literal'
    );
  }

  fix(content: string, result: MutationResult): string {
    return restoreLine(content, result);
  }
}

class DuplicateLineMutation implements MutationClass {
  readonly name = 'duplicate-line';
  readonly category = 'duplicate';

  canApply(content: string): boolean {
    return listDuplicableLines(content).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    return corruptDuplicate(content, rng)?.result ?? null;
  }

  instruction(result: MutationResult, _fixtureName: string): string {
    const duplicateLine = result.line ?? 1;
    return (
      `a near-duplicate of line ${duplicateLine + 1} was inserted directly above it as line ${duplicateLine}; ` +
      `delete the duplicate on line ${duplicateLine} and leave line ${duplicateLine + 1} unchanged`
    );
  }

  fix(content: string, result: MutationResult): string {
    const lines = splitLines(content);
    const duplicate = result.mutatedSnippet;
    const original = result.originalSnippet;
    const expectedIndex = (result.line ?? 1) - 1;
    if (lines[expectedIndex] === duplicate && lines[expectedIndex + 1] === original) {
      lines.splice(expectedIndex, 1);
      return lines.join('\n');
    }
    for (let i = 0; i + 1 < lines.length; i += 1) {
      if (lines[i] === duplicate && lines[i + 1] === original) {
        lines.splice(i, 1);
        return lines.join('\n');
      }
    }
    return content;
  }
}

class LongLineSpliceMutation implements MutationClass {
  readonly name = 'long-line-splice';
  readonly category = 'long-line';

  canApply(content: string): boolean {
    return listLongLines(content).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    return corruptLongLine(content, rng)?.result ?? null;
  }

  instruction(result: MutationResult, _fixtureName: string): string {
    return (
      `line ${result.line} is a very long line; one token on it is misspelled: ` +
      `"${result.mutatedSnippet}" should be "${result.originalSnippet}"; fix that token`
    );
  }

  fix(content: string, result: MutationResult): string {
    return replaceWholeWordAll(content, result.mutatedSnippet, result.originalSnippet);
  }
}

const IDENTIFIER_RENAME_INSTANCE = new IdentifierRenameMutation();
const SUBTLE_WHITESPACE_INSTANCE = new SubtleWhitespaceMutation();
const COMMENT_SWAP_INSTANCE = new CommentSwapMutation();

/** Base mutations the recovery class composes with an external shift. */
const SHIFT_BASE_CLASSES: readonly MutationClass[] = [
  IDENTIFIER_RENAME_INSTANCE,
  SUBTLE_WHITESPACE_INSTANCE,
  COMMENT_SWAP_INSTANCE,
];

/**
 * Recovery bases whose fix restores a single located line: when the
 * corrupted line's text occurs more than once in the post-shift on-disk
 * content, the content-based relocation could restore a twin instead of the
 * corrupted line, and the case could silently pass (the benchmark's own
 * `fix` mislocates the same way). identifier-rename is deliberately not
 * listed — its fix replaces every whole-word occurrence at once, so a twin
 * is repaired together with the target and stays unambiguous.
 */
const TWIN_AMBIGUOUS_RECOVERY_BASES: ReadonlySet<string> = new Set([
  SUBTLE_WHITESPACE_INSTANCE.name,
  COMMENT_SWAP_INSTANCE.name,
]);

/**
 * Applies a shift to content the way the harness writes the on-disk file
 * (`applyExternalShift` in expected.ts): `count` blank lines inserted before
 * `atLine`, or deleted from it (both 1-based). Kept local — expected.ts
 * imports this module, so the dependency cannot point the other way.
 */
function applyShift(content: string, shift: ExternalShift): string {
  const lines = content.split('\n');
  const at = Math.min(Math.max(shift.atLine - 1, 0), lines.length);
  if (shift.mode === 'insert') {
    lines.splice(at, 0, ...Array.from({ length: shift.count }, () => ''));
  } else {
    lines.splice(at, shift.count);
  }
  return lines.join('\n');
}

/** Number of lines of `content` exactly equal to `text`. */
function lineOccurrenceCount(content: string, text: string): number {
  let count = 0;
  for (const line of content.split('\n')) {
    if (line === text) count += 1;
  }
  return count;
}

class MultiHunkDoubleMutation implements MutationClass {
  readonly name = 'multi-hunk-double';
  readonly category = 'multi-hunk';
  readonly multiHunk = true;

  canApply(content: string): boolean {
    return listRenamableIdentifiers(content, 2).length > 0 && listIndentableLines(content).length > 0;
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    const identifier = corruptIdentifierSingle(content, rng);
    if (identifier === null) return null;
    const whitespace = corruptWhitespace(identifier.content, rng);
    if (whitespace === null) return null;
    return {
      originalSnippet: identifier.result.originalSnippet,
      mutatedSnippet: identifier.result.mutatedSnippet,
      line: identifier.result.line,
      parts: [
        { className: IDENTIFIER_RENAME_INSTANCE.name, result: identifier.result },
        { className: SUBTLE_WHITESPACE_INSTANCE.name, result: whitespace.result },
      ],
    };
  }

  instruction(result: MutationResult, fixtureName: string): string {
    const parts = result.parts ?? [];
    const identifierPart = parts[0];
    const whitespacePart = parts[1];
    if (identifierPart === undefined || whitespacePart === undefined) {
      return 'fix the two corrupted spots';
    }
    return (
      'two independent problems: ' +
      `(1) ${IDENTIFIER_RENAME_INSTANCE.instruction(identifierPart.result, fixtureName)}; ` +
      `(2) ${SUBTLE_WHITESPACE_INSTANCE.instruction(whitespacePart.result, fixtureName)}; ` +
      'fix both problems'
    );
  }

  fix(content: string, result: MutationResult): string {
    return fixParts(content, result);
  }
}

class ExternalShiftMutation implements MutationClass {
  readonly name = 'external-shift';
  readonly category = 'recovery';

  canApply(content: string): boolean {
    return lineCountOf(content) >= 20 && SHIFT_BASE_CLASSES.some((cls) => cls.canApply(content));
  }

  mutate(content: string, rng: () => number): MutationResult | null {
    const eligible = SHIFT_BASE_CLASSES.filter((cls) => cls.canApply(content));
    if (eligible.length === 0) return null;
    for (const baseIndex of shuffledIndices(eligible.length, rng)) {
      const base = eligible[baseIndex];
      if (base === undefined) continue;
      const corruptor = CORRUPTORS[base.name];
      if (corruptor === undefined) continue;
      const attempt = corruptor(content, rng);
      if (attempt === null) continue;
      const targetLine = attempt.result.line ?? 1;
      const shift = pickShift(attempt.content, targetLine, rng);
      if (shift === null) continue;
      // Recovery repair relocates the corrupted line by its text
      // (locateLine), so when that text occurs more than once in the
      // post-shift on-disk content the repair is ambiguous: a twin could be
      // restored instead and the case could silently pass. Exclude such
      // cases, the same way duplicate-line excludes pre-existing adjacent
      // pairs; the run counts the dropped case as skipped.
      if (
        TWIN_AMBIGUOUS_RECOVERY_BASES.has(base.name) &&
        lineOccurrenceCount(applyShift(attempt.content, shift), attempt.result.mutatedSnippet) > 1
      ) {
        continue;
      }
      return {
        originalSnippet: attempt.result.originalSnippet,
        mutatedSnippet: attempt.result.mutatedSnippet,
        line: attempt.result.line,
        parts: [{ className: base.name, result: attempt.result }],
        shift,
      };
    }
    return null;
  }

  instruction(result: MutationResult, fixtureName: string): string {
    const part = result.parts?.[0];
    const base = part === undefined ? undefined : mutationClassByName(part.className);
    if (part === undefined || base === undefined) return 'fix the corrupted spot';
    // Deliberately quotes the pre-shift line numbers: the file on disk has
    // already moved, and discovering that is the point of the case.
    return base.instruction(part.result, fixtureName);
  }

  fix(content: string, result: MutationResult): string {
    return fixParts(content, result);
  }
}

const MUTATION_CLASS_LIST: readonly MutationClass[] = [
  IDENTIFIER_RENAME_INSTANCE,
  new IdentifierRenameMultiMutation(),
  SUBTLE_WHITESPACE_INSTANCE,
  COMMENT_SWAP_INSTANCE,
  new BoundarySpliceMutation(),
  new DuplicateLineMutation(),
  new LongLineSpliceMutation(),
  new MultiHunkDoubleMutation(),
  new ExternalShiftMutation(),
];

/** All benchmark mutation classes, in stable sampling order. */
export const MUTATION_CLASSES: readonly MutationClass[] = MUTATION_CLASS_LIST;

function mutationClassByName(name: string): MutationClass | undefined {
  return MUTATION_CLASSES.find((cls) => cls.name === name);
}

/**
 * Picks the external shift for a recovery case: `count` lines (1..3) inserted
 * or deleted at a position that leaves the target line and its neighbours
 * untouched (the shift must move the target's line number, not its content).
 */
function pickShift(content: string, targetLine: number, rng: () => number): ExternalShift | null {
  const total = lineCountOf(content);
  const count = 1 + Math.floor(rng() * 3);
  if (rng() < 0.5) {
    const deletable = listDeletableLines(content).filter(
      (line) =>
        (line + count - 1 <= targetLine - 2 || line >= targetLine + 2) &&
        line + count - 1 <= total,
    );
    const line = deletable[Math.floor(rng() * deletable.length)];
    if (line !== undefined) return { atLine: line, count, mode: 'delete' };
  }
  const boundaries: number[] = [];
  for (let atLine = 1; atLine <= total + 1; atLine += 1) {
    if (atLine <= targetLine - 2 || atLine >= targetLine + 2) boundaries.push(atLine);
  }
  const atLine = boundaries[Math.floor(rng() * boundaries.length)];
  if (atLine === undefined) return null;
  return { atLine, count, mode: 'insert' };
}

function listDeletableLines(content: string): number[] {
  const lines = splitLines(content);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text === undefined) continue;
    if (text.trim().length === 0 || isCommentOnlyLine(text)) out.push(i + 1);
  }
  return out;
}

/**
 * Applies a mutation result's hunks to content. Hunks are non-overlapping;
 * they are applied from the end so earlier indices stay valid.
 */
export function applyHunks(content: string, hunks: readonly TextHunk[]): string {
  const ordered = hunks.toSorted((a, b) => b.start - a.start);
  let out = content;
  for (const hunk of ordered) {
    out = out.slice(0, hunk.start) + hunk.replacement + out.slice(hunk.end);
  }
  return out;
}

/**
 * Replays a mutation result onto content. Compound results fold their parts
 * in order; each part's hunks are relative to the content produced by the
 * previous parts.
 */
export function applyMutation(content: string, result: MutationResult): string {
  const parts = result.parts;
  if (parts !== undefined && parts.length > 0) {
    let folded = content;
    for (const part of parts) {
      folded = applyMutation(folded, part.result);
    }
    return folded;
  }
  const hunks = result.hunks;
  if (hunks === undefined || hunks.length === 0) return content;
  return applyHunks(content, hunks);
}
