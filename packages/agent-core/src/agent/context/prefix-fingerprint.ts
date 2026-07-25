/**
 * Append-only-context support: stable fingerprinting of the message prefix
 * sent to the LLM, so prompt-cache hit rate can be observed and regressions
 * detected.
 *
 * Providers (Anthropic, OpenAI, ...) cache prompt prefixes by exact byte
 * match. Appending messages to the tail preserves the prefix and lets the
 * cache hit; mutating any early message invalidates the cache from that
 * point onward. This module computes a deterministic per-message hash so the
 * context layer can measure how much of the prefix survived between two LLM
 * calls and log cache-breaking events (compaction, micro-compaction
 * truncation, projection repairs).
 *
 * The hash covers every field that contributes to the provider-visible byte
 * sequence: role, name, toolCallId, content parts (including think
 * signatures), and tool calls. Context-internal metadata (origin, useless,
 * partial) is intentionally excluded because `project()` already strips it
 * before it reaches the provider.
 */

import type { ContentPart, Message, ToolCall } from '@scream-code/ltod';

/**
 * Deterministic non-crypto string hash (djb2). Fast and sufficient for change
 * detection; not used for any security purpose. Returns a compact base36
 * string so an array of fingerprints stays small.
 */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + (input.codePointAt(i) ?? 0)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Stable JSON serialization that sorts object keys so key insertion order
 * can't affect the fingerprint. Only used for media parts whose payload is
 * already a stable base64/url string; text/think parts have a dedicated
 * fast path.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function serializeContentPart(part: ContentPart): string {
  switch (part.type) {
    case 'text':
      return `text:${part.text}`;
    case 'think':
      // encrypted is a provider reasoning signature (e.g. Anthropic
      // thinking blocks) that MUST be echoed back verbatim, so it is part
      // of the provider-visible bytes.
      return `think:${part.think}${part.encrypted !== undefined ? `\u0003${part.encrypted}` : ''}`;
    default:
      // image_url / audio_url / video_url: payload is a stable url/id.
      return `${part.type}:${stableJson(part)}`;
  }
}

function serializeToolCall(tc: ToolCall): string {
  return `function|${tc.id}|${tc.name}|${tc.arguments ?? ''}`;
}

/**
 * Serialize a message to a deterministic string covering all
 * provider-visible bytes. Two messages with the same serialization produce
 * identical provider bytes (modulo serialization the provider adapter
 * normalizes). Separator bytes (\x00-\x03) are used so concatenated fields
 * can't alias.
 */
export function serializeMessage(message: Message): string {
  const content = message.content.map(serializeContentPart).join('\u0001');
  const toolCalls = message.toolCalls.map(serializeToolCall).join('\u0002');
  return `${message.role}\u0000${message.name ?? ''}\u0000${message.toolCallId ?? ''}\u0000${content}\u0000${toolCalls}`;
}

/** Per-message fingerprint. Equal fingerprints => equal provider bytes. */
export function messageFingerprint(message: Message): string {
  return hashString(serializeMessage(message));
}

/**
 * Longest common prefix length by provider-visible bytes. This is the number
 * of leading messages a provider prompt cache could reuse from the previous
 * call. When this is less than the previous call's message count, an early
 * message mutated and the cache broke from that index.
 *
 * `prev` is the array of per-message fingerprints captured last call;
 * `current` is the live messages this call.
 */
export function stablePrefixLength(
  prev: readonly string[],
  current: readonly Message[],
): number {
  const n = Math.min(prev.length, current.length);
  let i = 0;
  for (; i < n; i++) {
    if (prev[i] !== messageFingerprint(current[i]!)) break;
  }
  return i;
}
