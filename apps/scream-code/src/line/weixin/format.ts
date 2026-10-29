/**
 * Inbound text extraction and outbound chunking for the weixin (ilink) channel.
 *
 * Ports of the reference:
 *   - platform/weixin/parse.go `bodyFromItemList` (text, quoted refs, voice ASR)
 *   - platform/weixin/weixin.go `mediaOnlyItems` + the media placeholder copy
 *   - core.SplitMessageCodeFenceAware (3800-char chunks, fence-balanced)
 */

export const MAX_WEIXIN_CHUNK = 3800;
export const WEIXIN_CHUNK_SEND_DELAY_MS = 100;

/** ilink item type codes (platform/weixin/types.go). */
export const MESSAGE_ITEM_TEXT = 1;
export const MESSAGE_ITEM_VOICE = 3;
export const MESSAGE_ITEM_IMAGE = 2;
export const MESSAGE_ITEM_FILE = 4;
export const MESSAGE_ITEM_VIDEO = 5;

export interface IlinkMessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  ref_msg?: {
    title?: string;
    message_item?: IlinkMessageItem;
  };
}

function isMediaItemType(t: number | undefined): boolean {
  return t === MESSAGE_ITEM_IMAGE || t === MESSAGE_ITEM_VOICE || t === MESSAGE_ITEM_FILE || t === MESSAGE_ITEM_VIDEO;
}

/**
 * Extract user-visible text from item_list: the first non-empty text item,
 * with quoted references rendered as `[引用: title | quoted body]`, falling
 * back to voice ASR text (the reference parse.go).
 */
export function bodyFromItemList(items: IlinkMessageItem[] | undefined): string {
  if (!items || items.length === 0) return '';
  for (const item of items) {
    if (item.type !== MESSAGE_ITEM_TEXT) continue;
    const text = (item.text_item?.text ?? '').trim();
    const ref = item.ref_msg;
    if (!ref) {
      if (text === '') continue; // skip placeholder text items
      return text;
    }
    if (ref.message_item && isMediaItemType(ref.message_item.type)) {
      return text; // quote of a media message — the caption is the body
    }
    const parts: string[] = [];
    if (ref.title) parts.push(ref.title);
    const refBody = ref.message_item ? bodyFromItemList([ref.message_item]) : '';
    if (refBody !== '') parts.push(refBody);
    if (parts.length === 0) {
      if (text === '') continue;
      return text;
    }
    return `[引用: ${parts.join(' | ')}]\n${text}`;
  }
  // Voice transcription fallback (parse.go).
  for (const item of items) {
    if (item.type === MESSAGE_ITEM_VOICE) {
      const asr = (item.voice_item?.text ?? '').trim();
      if (asr !== '') return asr;
    }
  }
  return '';
}

/** True when every item is media (used for the "media received" placeholder). */
export function mediaOnlyItems(items: IlinkMessageItem[] | undefined): boolean {
  if (!items || items.length === 0) return false;
  let sawMedia = false;
  for (const it of items) {
    if (it.type === MESSAGE_ITEM_IMAGE || it.type === MESSAGE_ITEM_VIDEO || it.type === MESSAGE_ITEM_FILE) {
      sawMedia = true;
      continue;
    }
    if (it.type === MESSAGE_ITEM_VOICE) {
      if (!it.voice_item || (it.voice_item.text ?? '').trim() === '') {
        sawMedia = true; // voice without ASR counts as media
        continue;
      }
      return false; // has usable ASR text
    }
    return false; // a text item exists
  }
  return sawMedia;
}

export const WEIXIN_MEDIA_PLACEHOLDER =
  '[收到媒体消息：图片/文件接收即将支持，请改用文字说明。]';

/**
 * Split long replies into ≤max chunks at line boundaries, keeping code fences
 * balanced: a chunk that would end inside an open fence is closed first and
 * the next chunk reopens it (the reference core.SplitMessageCodeFenceAware).
 */
export function splitMessageCodeFenceAware(content: string, max = MAX_WEIXIN_CHUNK): string[] {
  const text = content.trim();
  if (text.length === 0) return [];
  if (text.length <= max) return [text];

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let fenceOpen = false;

  const flush = (): void => {
    if (current.length === 0) return;
    let chunk = current.join('\n');
    if (fenceOpen) {
      chunk += '\n```';
    }
    chunks.push(chunk);
    if (fenceOpen) {
      // Reopen the fence in the next chunk.
      const opener = current.find((l) => l.startsWith('```'));
      current = opener ? [opener] : ['```'];
      currentLen = current[0]?.length ?? 0;
    } else {
      current = [];
      currentLen = 0;
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) fenceOpen = !fenceOpen;
    if (currentLen > 0 && currentLen + 1 + line.length > max) {
      flush();
    }
    // A single line longer than max is hard-split so progress is never lost.
    if (line.length > max) {
      for (let i = 0; i < line.length; i += max) {
        const piece = line.slice(i, i + max);
        if (currentLen === 0) {
          chunks.push(piece);
        } else {
          current.push(piece);
          flush();
        }
      }
      continue;
    }
    current.push(line);
    currentLen += (currentLen > 0 ? 1 : 0) + line.length;
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}
