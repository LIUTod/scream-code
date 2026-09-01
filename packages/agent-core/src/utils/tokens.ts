import type { ContentPart, Message, Tool } from '@scream-code/ltod';

/**
 * WeakMap cache for per-message token estimates. Messages are immutable once
 * settled (streaming `partial` messages never enter compaction paths), so the
 * cache is safe. Spread copies created by micro-compaction ({ ...msg, content })
 * are new objects → natural cache miss → re-estimated. Original objects retain
 * their cached count, avoiding O(n²) re-scans during compaction detection.
 */
const messageTokenCache = new WeakMap<Message, number>();

/**
 * Estimate token count from text using a character-based heuristic.
 *   - ASCII (~4 chars per token)
 *   - CJK and other non-ASCII (~1 char per token)
 * The estimate is transient — the next LLM call returns the real count
 * and supersedes this value. Used to keep `tokenCountWithPending`
 * monotonic between LLM round-trips without paying for a tokenizer.
 */
export function estimateTokens(text: string): number {
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

export function estimateTokensForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message);
  }
  return total;
}

export function estimateTokensForTools(tools: readonly Tool[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokens(JSON.stringify(tool.parameters));
  }
  return total;
}

export function estimateTokensForMessage(message: Message): number {
  const cached = messageTokenCache.get(message);
  if (cached !== undefined) return cached;
  let total = estimateTokens(message.role);
  for (const part of message.content) {
    total += estimateTokensForContentPart(part);
  }
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
    }
  }
  messageTokenCache.set(message, total);
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

export function estimateTokensForContentPart(part: ContentPart): number {
  if (part.type === 'text') {
    return estimateTokens(part.text);
  } else if (part.type === 'think') {
    return estimateTokens(part.think);
  } else if (part.type === 'image_url') {
    return estimateDataUriTokens(part.imageUrl.url, IMAGE_BASE_TOKENS, IMAGE_MAX_TOKENS);
  } else if (part.type === 'audio_url') {
    return AUDIO_TOKENS;
  } else if (part.type === 'video_url') {
    return VIDEO_TOKENS;
  }
  return 0;
}
