import type { ContentPart, Message, TextPart } from '@scream-code/ltod';

/**
 * Media (image / audio / video) content parts in conversation history.
 * These are the parts that get stripped or degraded when the provider
 * rejects the request because of media issues.
 */
function isMediaPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

/**
 * Build a compact text marker that replaces a stripped media part, so the
 * model knows there WAS media at this position without receiving the bytes.
 */
function mediaMarker(part: ContentPart): TextPart {
  switch (part.type) {
    case 'image_url':
      return { type: 'text', text: `<image>${part.imageUrl.id ?? ''}</image>` };
    case 'audio_url':
      return { type: 'text', text: `<audio>${part.audioUrl.id ?? ''}</audio>` };
    case 'video_url':
      return { type: 'text', text: `<video>${part.videoUrl.id ?? ''}</video>` };
    default:
      return { type: 'text', text: '<media></media>' };
  }
}

/**
 * Replace ALL media parts in every message with text markers.
 *
 * Used when the provider rejects an image because of its format or data
 * (unsupported media type, undecodable bytes). The rejection is
 * deterministic - the same image is re-sent every request - so stripping
 * all media and retrying once is the only recovery.
 */
export function stripMedia(messages: readonly Message[]): Message[] {
  return messages.map((msg) => ({
    ...msg,
    content: msg.content.map((part) => (isMediaPart(part) ? mediaMarker(part) : part)),
  }));
}

/**
 * Keep only the `keepRecent` most recent media parts across the entire
 * conversation; replace all older media with text markers.
 *
 * Used when the provider rejects the request because the body is too large
 * (HTTP 413), most commonly from accumulated images. Keeping recent media
 * preserves visual context for the current exchange while shedding the
 * bulk of older images that are no longer the focus.
 */
export function degradeMedia(messages: readonly Message[], keepRecent = 4): Message[] {
  // Walk in reverse to find the indices of the last `keepRecent` media parts.
  const mediaIndices: Array<{ msg: number; part: number }> = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]!.content;
    for (let j = content.length - 1; j >= 0; j -= 1) {
      if (isMediaPart(content[j]!)) {
        mediaIndices.push({ msg: i, part: j });
        if (mediaIndices.length >= keepRecent) break;
      }
    }
    if (mediaIndices.length >= keepRecent) break;
  }

  // If total media <= keepRecent, nothing to degrade.
  if (mediaIndices.length < keepRecent) return messages.map((m) => ({ ...m }));

  // Build a set of (msg,part) pairs to keep.
  const keepSet = new Set(mediaIndices.map((idx) => `${idx.msg}:${idx.part}`));

  return messages.map((msg, i) => ({
    ...msg,
    content: msg.content.map((part, j) =>
      isMediaPart(part) && !keepSet.has(`${i}:${j}`) ? mediaMarker(part) : part,
    ),
  }));
}
