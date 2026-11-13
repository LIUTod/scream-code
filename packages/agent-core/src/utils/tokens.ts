import type { ContentPart, Message, Tool } from '@scream-code/ltod';
// Import the lite entry plus the two ranks we actually expose. The package
// barrel (`js-tiktoken`) re-exports `getEncoding`, which statically pulls every
// shipped rank (cl100k, o200k, p50k, p50k_edit, r50k, gpt2 ≈ 6 MB of tables)
// into the shipped bundle even though only two kinds are selectable.
import { Tiktoken, type TiktokenBPE } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

/**
 * Text measurement strategy for local token estimates.
 *
 * - `cl100k` / `o200k`: exact BPE counts via js-tiktoken's OpenAI encodings.
 * - `heuristic`: character-based estimate (ASCII ~4 chars per token, every
 *   other character ~1 token), no encoder load.
 *
 * The encoder counts are near-exact, not exact: Anthropic and Gemini
 * tokenizers are closed, so an OpenAI encoding only approximates what those
 * providers bill. Every count below feeds compaction watermarks and budget
 * display only — actual usage always comes from the provider-reported usage,
 * which re-anchors the context gauge at each step end.
 */
export type TokenizerKind = 'cl100k' | 'o200k' | 'heuristic';

type EncoderKind = Exclude<TokenizerKind, 'heuristic'>;

const ENCODING_RANKS: Record<EncoderKind, TiktokenBPE> = {
  cl100k: cl100kBase,
  o200k: o200kBase,
};

/**
 * Encoders built lazily on first use and kept for the process lifetime. The
 * ~100ms BPE construction and its ~70MB heap cost are what the deferral
 * avoids; the rank tables themselves (~11ms of module evaluation, ~3MB) are
 * eagerly bundled because the counting API is synchronous and the tables sit
 * behind static imports. `null` records a construction failure: it is not
 * retried, and it is warned about once.
 */
const encoders = new Map<EncoderKind, Tiktoken | null>();
let encoderFailureWarned = false;

/**
 * The encoder for `kind`, or `undefined` when exact counting is unavailable
 * (the heuristic kind, or an encoder construction failure). Never throws: a
 * tokenizer problem must degrade to the heuristic, not break a turn.
 */
function getEncoder(kind: TokenizerKind | undefined): Tiktoken | undefined {
  if (kind === undefined || kind === 'heuristic') return undefined;
  const cached = encoders.get(kind);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const encoder = new Tiktoken(ENCODING_RANKS[kind]);
    encoders.set(kind, encoder);
    return encoder;
  } catch (error) {
    encoders.set(kind, null);
    if (!encoderFailureWarned) {
      encoderFailureWarned = true;
      const reason = error instanceof Error ? error.message : String(error);
      process.emitWarning(
        `tokenizer "${kind}" is unavailable; token estimates fall back to the character heuristic (${reason})`,
        'TokenizerWarning',
      );
    }
    return undefined;
  }
}

/**
 * Character-based fallback estimate.
 *   - ASCII (~4 chars per token)
 *   - CJK and other non-ASCII (~1 char per token)
 */
function heuristicTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

/**
 * js-tiktoken's BPE is quadratic in the length of one pretokenizer chunk: an
 * unbroken 8k-char run (`'x'.repeat(8000)`, a base64 payload, a minified line)
 * takes ~6.5s, while 9KB of prose takes ~1ms. Tool results routinely carry
 * such runs, so a text containing an over-long run (whitespace or not) is
 * counted per run instead of in one call:
 *   - short runs (≤ MAX_ENCODE_RUN) are encoded directly — still exact;
 *   - a long uniform run is sampled and scaled (exact for the periodic merges
 *     of a repeated character, near-exact otherwise);
 *   - any other long run is encoded in bounded slices.
 * Splitting at run boundaries can move the leading-space token of a segment,
 * so the total stays near-exact — enough for watermarks, which is the only
 * consumer (billing uses the provider-reported usage).
 */
const MAX_ENCODE_RUN = 512;
/** Prefix length used to extrapolate a long uniform run; encode cost grows
 *  quadratically with the run, so this must stay small (~2ms). */
const UNIFORM_SAMPLE_CHARS = 32;
/** Slice length for a long non-uniform run (~8ms per slice in the worst case). */
const RUN_SLICE_CHARS = 256;

function isSpaceCode(code: number): boolean {
  return code <= 32;
}

/** True when some run of same-class characters (whitespace vs. other) exceeds
 *  `MAX_ENCODE_RUN` — the shape that makes a single encode call blow up. */
function hasOverlongRun(text: string): boolean {
  let previousIsSpace: boolean | undefined;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const isSpace = isSpaceCode(text.codePointAt(i) ?? 0);
    if (isSpace === previousIsSpace) {
      run += 1;
      if (run > MAX_ENCODE_RUN) return true;
    } else {
      previousIsSpace = isSpace;
      run = 1;
    }
  }
  return false;
}

/** Encode one long run (no whitespace boundary inside) without the quadratic
 *  blow-up: uniform runs are sampled and scaled, the rest is sliced. */
function countLongRun(encoder: Tiktoken, run: string): number {
  // Uniformity is sampled (first/last/eight evenly spaced positions) instead of
  // scanned: this runs on megabyte-scale runs, and a false negative only sends
  // the run to the slower (still bounded) slice path.
  const first = run.codePointAt(0) ?? 0;
  let uniform = (run.codePointAt(run.length - 1) ?? 0) === first;
  for (let offset = 1; uniform && offset <= 8; offset++) {
    uniform = (run.codePointAt(Math.floor((run.length * offset) / 9)) ?? 0) === first;
  }
  if (uniform) {
    const sample = run.slice(0, UNIFORM_SAMPLE_CHARS);
    return Math.round((encoder.encode(sample).length * run.length) / sample.length);
  }
  let total = 0;
  for (let start = 0; start < run.length; start += RUN_SLICE_CHARS) {
    total += encoder.encode(run.slice(start, start + RUN_SLICE_CHARS)).length;
  }
  return total;
}

function encodeCount(encoder: Tiktoken, text: string): number {
  if (text.length <= MAX_ENCODE_RUN || !hasOverlongRun(text)) {
    return encoder.encode(text).length;
  }
  // Walk maximal whitespace / non-whitespace runs. Short runs concatenate back
  // into one exact encode; only over-long runs are measured on their own.
  let total = 0;
  let exactStart = 0;
  let segmentStart = 0;
  let segmentIsSpace = isSpaceCode(text.codePointAt(0) ?? 0);
  for (let i = 1; i <= text.length; i++) {
    const isSpace = i < text.length && isSpaceCode(text.codePointAt(i) ?? 0);
    if (i === text.length || isSpace !== segmentIsSpace) {
      if (i - segmentStart > MAX_ENCODE_RUN) {
        if (segmentStart > exactStart) {
          total += encoder.encode(text.slice(exactStart, segmentStart)).length;
        }
        total += countLongRun(encoder, text.slice(segmentStart, i));
        exactStart = i;
      }
      segmentStart = i;
      segmentIsSpace = isSpace;
    }
  }
  if (exactStart < text.length) {
    total += encoder.encode(text.slice(exactStart)).length;
  }
  return total;
}

function countTokens(text: string, encoder: Tiktoken | undefined): number {
  return encoder === undefined ? heuristicTokens(text) : encodeCount(encoder, text);
}

/**
 * Estimate the token count of `text`. With a `tokenizer` the text is measured
 * with that encoder; omitted (or `heuristic`) keeps the character heuristic
 * unchanged. Used to keep `tokenCountWithPending` monotonic between LLM
 * round-trips.
 */
export function estimateTokens(text: string, tokenizer?: TokenizerKind): number {
  return countTokens(text, getEncoder(tokenizer));
}

/**
 * Per-message estimate caches. Messages are immutable once settled (streaming
 * `partial` messages never enter compaction paths), so the cache is safe.
 * Spread copies created by micro-compaction ({ ...msg, content }) are new
 * objects → natural cache miss → re-estimated. Original objects retain their
 * cached count, avoiding O(n²) re-scans during compaction detection.
 *
 * One cache per tokenizer kind: the same message must never return a
 * heuristic count to an exact-count caller (or vice versa).
 */
const heuristicMessageTokenCache = new WeakMap<Message, number>();
const encoderMessageTokenCaches = new Map<TokenizerKind, WeakMap<Message, number>>();

function messageCacheFor(tokenizer: TokenizerKind | undefined): WeakMap<Message, number> {
  if (tokenizer === undefined || tokenizer === 'heuristic') return heuristicMessageTokenCache;
  let cache = encoderMessageTokenCaches.get(tokenizer);
  if (cache === undefined) {
    cache = new WeakMap();
    encoderMessageTokenCaches.set(tokenizer, cache);
  }
  return cache;
}

export function estimateTokensForMessages(
  messages: readonly Message[],
  tokenizer?: TokenizerKind,
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message, tokenizer);
  }
  return total;
}

export function estimateTokensForTools(
  tools: readonly Tool[],
  tokenizer?: TokenizerKind,
): number {
  const encoder = getEncoder(tokenizer);
  let total = 0;
  for (const tool of tools) {
    total += countTokens(tool.name, encoder);
    total += countTokens(tool.description, encoder);
    total += countTokens(JSON.stringify(tool.parameters), encoder);
  }
  return total;
}

export function estimateTokensForMessage(
  message: Message,
  tokenizer?: TokenizerKind,
): number {
  const cache = messageCacheFor(tokenizer);
  const cached = cache.get(message);
  if (cached !== undefined) return cached;
  const encoder = getEncoder(tokenizer);
  // The role is per-message structural overhead, not content: it stays on the
  // heuristic in every mode so only the text measurement changes.
  let total = heuristicTokens(message.role);
  for (const part of message.content) {
    total += estimateTokensForContentPart(part, tokenizer);
  }
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += countTokens(call.name, encoder);
      total += countTokens(JSON.stringify(call.arguments), encoder);
    }
  }
  cache.set(message, total);
  return total;
}

/**
 * Media parts carry no width/height metadata, and providers differ on how they
 * tokenize media (image token counts range from a few hundred to ~1600 for a
 * single image depending on provider and resolution). There is no cross-
 * provider formula, so these estimates are deliberately conservative — for
 * watermark detection an OVERestimate only compacts slightly earlier
 * (harmless), whereas counting media as 0 systematically UNDERESTIMATED the
 * watermark and delayed compaction on media-heavy sessions.
 *
 * These estimates are consumed only by watermark detection and micro-compaction
 * recycling decisions — the real usage reported by the provider re-anchors the
 * context token count at each step end, so billing/usage accounting is
 * unaffected.
 */
const IMAGE_BASE_TOKENS = 1_600;
const IMAGE_MAX_TOKENS = 8_000;
/** data-URI payloads above this many bytes are treated as high-resolution/long captures. */
const IMAGE_LARGE_PAYLOAD_BYTES = 512_000;
const AUDIO_TOKENS = 2_000;
const VIDEO_TOKENS = 5_000;

/** Long screenshots (large data URIs) carry more visual content than a single
 *  bounded-resolution image; grow the estimate linearly and cap it. */
function estimateDataUriTokens(url: string, baseTokens: number, maxTokens: number): number {
  const marker = 'base64,';
  const start = url.indexOf(marker);
  if (start < 0) return baseTokens;
  const bytes = Math.floor(((url.length - start - marker.length) * 3) / 4);
  if (bytes <= IMAGE_LARGE_PAYLOAD_BYTES) return baseTokens;
  return Math.min(maxTokens, baseTokens + Math.floor((bytes - IMAGE_LARGE_PAYLOAD_BYTES) / 1_000));
}

export function estimateTokensForContentPart(
  part: ContentPart,
  tokenizer?: TokenizerKind,
): number {
  if (part.type === 'text') {
    return countTokens(part.text, getEncoder(tokenizer));
  } else if (part.type === 'think') {
    return countTokens(part.think, getEncoder(tokenizer));
  } else if (part.type === 'image_url') {
    return estimateDataUriTokens(part.imageUrl.url, IMAGE_BASE_TOKENS, IMAGE_MAX_TOKENS);
  } else if (part.type === 'audio_url') {
    return AUDIO_TOKENS;
  } else if (part.type === 'video_url') {
    return VIDEO_TOKENS;
  }
  return 0;
}
