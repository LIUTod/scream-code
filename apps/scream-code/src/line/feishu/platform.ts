/**
 * Feishu receive pipeline for the line daemon.
 *
 * Direct port of the reference `platform/feishu/feishu.go::onMessage`
 * (L1696-1894) plus `stripMentions`/`isBotMentioned`/`makeSessionKey`,
 * preserving the filter order: dedup → old-message drop (restart replay
 * guard) → group @mention filter (fail-closed even when the bot identity is
 * unknown, issue #1618) → allow_from (user whitelist, polite rejection when
 * directly addressed) → allow_chat (group whitelist, silent) → group_only →
 * mention stripping → receipt reaction → async dispatch.
 *
 * Media: `text` / `image` / `post` / `file` / `audio` / `media` are dispatched
 * by `msgType`; images arriving in one burst are batched (800 ms) into a single
 * turn, attachments land under `<scream-home>/line/inbox/<sessionKey>/`.
 *
 * Deviations (documented): no recall tracking, no group history share, no
 * interactive card rendering (replies stay text/post).
 */

import { createHash } from 'node:crypto';

import { log } from '@scream-code/scream-code-sdk';

import {
  feishuFileType,
  type FeishuClient,
  type FeishuEventMessage,
  type FeishuQuotedMessage,
} from './client';
import { buildTextJSON } from './format';
import { MessageDedup } from '../dedup';
import type { FeishuRuntimeOptions } from '../config';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  MAX_IMAGES_PER_TURN,
  MAX_INBOUND_FILE_BYTES,
  MAX_INBOUND_IMAGE_BYTES,
  saveInboundFile,
  sniffImageMime,
  type LineImageAttachment,
} from '../media';

export interface LineDispatchContext {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
}

export interface LineDispatch {
  /** Scream session key (`line-feishu-<hash>`). */
  sessionKey: string;
  text: string;
  /** Inbound images, already downloaded (image messages and rich-text posts). */
  images?: LineImageAttachment[];
  /** Inbound files already written to disk (absolute paths). */
  files?: string[];
  context: LineDispatchContext;
}

/**
 * Phone albums arrive as a burst of separate image messages; without batching
 * every photo becomes its own turn. The reference implementation merges them in
 * a short window; 800 ms is enough for a burst and short enough to feel instant.
 */
const IMAGE_BATCH_WINDOW_MS = 800;

export const IMAGE_FAILED_TEXT = '图片下载失败，请重新发送一次。';
export const FILE_FAILED_TEXT = '附件下载失败，请重新发送一次。';

interface PendingImageBatch {
  images: LineImageAttachment[];
  lastEvent: FeishuEventMessage;
  timer: ReturnType<typeof setTimeout>;
}

const QUOTED_TEXT_MAX = 500;
const QUOTED_MAX_IMAGES = 2;

interface QuotedPayload {
  text: string;
  imageKeys: string[];
  fileKeys: Array<{ key: string; name: string }>;
}

/** Rich-text (post) content → plain text chunks + inline image keys. */
function parsePostPayload(content: string): {
  textChunks: string[];
  imageKeys: string[];
  fileKeys: Array<{ key: string; name: string }>;
} {
  const parsed = parseContent<{ title?: string; content?: unknown; files?: unknown[] }>(content);
  // The post body's top-level `files[]` was silently dropped before the
  // reference fixed it (#1884): a composer attachment must reach the agent.
  const fileKeys: Array<{ key: string; name: string }> = [];
  for (const entry of Array.isArray(parsed?.files) ? parsed.files : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record['is_folder'] === true) continue;
    const key = record['file_key'];
    if (typeof key !== 'string' || key.length === 0) continue;
    fileKeys.push({ key, name: typeof record['file_name'] === 'string' ? record['file_name'] : '' });
  }
  const rows = Array.isArray(parsed?.content) ? (parsed.content as unknown[]) : [];
  const textChunks: string[] = [];
  if (typeof parsed?.title === 'string' && parsed.title.trim().length > 0) textChunks.push(parsed.title);
  const imageKeys: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (node === null || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      if ((record['tag'] === 'text' || record['tag'] === 'a') && typeof record['text'] === 'string') {
        textChunks.push(record['text']);
      } else if (record['tag'] === 'img' && typeof record['image_key'] === 'string') {
        imageKeys.push(record['image_key']);
      }
    }
  }
  return { textChunks, imageKeys, fileKeys };
}

/** Flattens a quoted message of any supported type into text + media keys. */
function parseQuoted(parent: FeishuQuotedMessage): QuotedPayload {
  switch (parent.msgType) {
    case 'text': {
      const parsed = parseContent<{ text?: string }>(parent.content);
      return { text: typeof parsed?.text === 'string' ? parsed.text : '', imageKeys: [], fileKeys: [] };
    }
    case 'post': {
      const { textChunks, imageKeys, fileKeys } = parsePostPayload(parent.content);
      return { text: textChunks.join('\n'), imageKeys, fileKeys };
    }
    case 'image': {
      const parsed = parseContent<{ image_key?: string }>(parent.content);
      const key = parsed?.image_key;
      return {
        text: '',
        imageKeys: typeof key === 'string' && key.length > 0 ? [key] : [],
        fileKeys: [],
      };
    }
    case 'file':
    case 'audio':
    case 'media': {
      const parsed = parseContent<{ file_key?: string; file_name?: string }>(parent.content);
      const key = parsed?.file_key;
      if (typeof key !== 'string' || key.length === 0) return { text: '', imageKeys: [], fileKeys: [] };
      return {
        text: '',
        imageKeys: [],
        fileKeys: [{ key, name: typeof parsed?.file_name === 'string' ? parsed.file_name : '' }],
      };
    }
    default:
      return { text: '', imageKeys: [], fileKeys: [] };
  }
}

/** One-line quote prefix, clipped so a long parent cannot eat the prompt. */
function quotePrefix(text: string): string {
  const flattened = text.replaceAll(/\s*\n\s*/g, ' ').trim();
  if (flattened.length === 0) return '';
  const clipped = flattened.length > QUOTED_TEXT_MAX ? `${flattened.slice(0, QUOTED_TEXT_MAX)}…` : flattened;
  return `[引用: ${clipped}]\n`;
}

/** Tolerant JSON parse for channel content (never throws). */
function parseContent<T>(content: string): T | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function dispatchContext(event: FeishuEventMessage): LineDispatchContext {
  return {
    messageId: event.messageId,
    chatId: event.chatId,
    chatType: event.chatType,
    userId: event.senderUserId,
  };
}

export const UNAUTHORIZED_TEXT =
  '抱歉，你还不在本机器人的授权名单中，无法使用。请联系机器人主人把你的用户 ID 加入 allow_from 白名单。';

// ─── Ports of the reference helpers ──────────────────────────────────────────

/** the reference isBotMentioned (L4013): any mention whose open_id is the bot. */
export function isBotMentioned(mentions: FeishuEventMessage['mentions'], botOpenId: string | undefined): boolean {
  if (!botOpenId) return false;
  return mentions.some((m) => m.openId !== undefined && m.openId === botOpenId);
}

/**
 * the reference stripMentions (L4146): the bot's own @mention is removed, other
 * @mentions become `@Name` so the agent keeps the reference.
 */
export function stripMentions(
  text: string,
  mentions: FeishuEventMessage['mentions'],
  botOpenId: string | undefined,
): string {
  if (mentions.length === 0) return text;
  for (const m of mentions) {
    if (!m.key) continue;
    if (botOpenId && m.openId && m.openId === botOpenId) {
      text = text.replaceAll(m.key, '');
    } else if (m.name) {
      text = text.replaceAll(m.key, `@${m.name}`);
    } else {
      text = text.replaceAll(m.key, '');
    }
  }
  return text.trim();
}

/** the reference allow-list semantics: empty list = allow everyone. */
export function allowListPasses(list: string[], value: string): boolean {
  if (list.length === 0) return true;
  return list.includes(value);
}

/** the reference makeSessionKey (L4167), then hashed into a scream session id. */
export function makeSessionKey(event: FeishuEventMessage, shareSessionInChannel: boolean): string {
  const ccKey = shareSessionInChannel
    ? `feishu:${event.chatId}`
    : `feishu:${event.chatId}:${event.senderUserId}`;
  const hash = createHash('sha1').update(ccKey).digest('hex').slice(0, 16);
  return `line-feishu-${hash}`;
}

// ─── Platform ─────────────────────────────────────────────────────────────

export class FeishuPlatform {
  private readonly dedup = new MessageDedup();
  /** Process start time — messages created earlier are dropped (replay guard). */
  private readonly startMs = Date.now();
  /** messageId → reaction id for the receipt emoji (removed on completion). */
  private readonly receipts = new Map<string, string>();
  /** Sessions with an open image batch, keyed by sessionKey. */
  private readonly pendingImages = new Map<string, PendingImageBatch>();
  /** sessionKey → chat id, so outbound media can be addressed after the fact. */
  private readonly chatBySession = new Map<string, string>();

  constructor(
    private readonly client: FeishuClient,
    private readonly options: FeishuRuntimeOptions,
    private readonly dispatch: (message: LineDispatch) => Promise<void> | void,
  ) {}

  /** Inbound message entry point (wired to the WS event dispatcher). */
  async handleEvent(event: FeishuEventMessage): Promise<void> {
    // Dedup — Feishu delivery is at-least-once (the reference dedup.IsDuplicate).
    if (this.dedup.isDuplicate(event.messageId)) {
      log.debug('line: duplicate message ignored', { messageId: event.messageId });
      return;
    }
    // Old message after restart — the server replays unacked events.
    if (event.createTimeMs > 0 && event.createTimeMs < this.startMs) {
      log.debug('line: old message ignored after restart', { messageId: event.messageId });
      return;
    }

    const isGroup = event.chatType === 'group';
    const botMentioned = isBotMentioned(event.mentions, this.client.botOpenId);

    // Group @mention filter — fail-closed: when the bot identity is unknown
    // (degraded) group messages are dropped, never answered wholesale
    // (issue #1618 (fail-closed group filter)).
    if (isGroup && this.options.requireMention) {
      if (!this.client.groupFilterActive || !botMentioned) {
        log.debug('line: group message without bot mention (or filter degraded)', {
          chatId: event.chatId,
          messageId: event.messageId,
          filterActive: this.client.groupFilterActive,
        });
        return;
      }
    }

    // User whitelist — reply politely only when directly addressed.
    if (!allowListPasses(this.options.allowFrom, event.senderUserId)) {
      log.debug('line: message from unauthorized user', { userId: event.senderUserId });
      if (!isGroup || botMentioned) {
        await this.safeReply(event.messageId, buildTextJSON(UNAUTHORIZED_TEXT));
      }
      return;
    }

    // Group whitelist — silent drop (the reference behavior).
    if (isGroup && !allowListPasses(this.options.allowChat, event.chatId)) {
      log.debug('line: message from unauthorized chat', { chatId: event.chatId });
      return;
    }

    if (!isGroup && this.options.groupOnly) {
      log.debug('line: p2p message skipped (group_only)', { messageId: event.messageId });
      return;
    }

    // ── Message type dispatch ───────────────────────────────────────────
    // Only text, images, rich-text posts and files are understood; anything
    // else (stickers, cards, merge-forward) is logged and dropped.
    const sessionKey = makeSessionKey(event, this.options.shareSessionInChannel);
    this.chatBySession.set(sessionKey, event.chatId);
    // Flush any open image batch first: a text message must not be reordered
    // after the photos that preceded it.
    if (event.msgType !== 'image') await this.flushImageBatch(sessionKey);

    switch (event.msgType) {
      case 'text':
        await this.handleText(event, sessionKey);
        return;
      case 'image':
        await this.handleImage(event, sessionKey);
        return;
      case 'post':
        await this.handlePost(event, sessionKey);
        return;
      case 'file':
        await this.handleFile(event, sessionKey, 'file');
        return;
      case 'audio':
        await this.handleFile(event, sessionKey, 'audio');
        return;
      case 'media':
        await this.handleFile(event, sessionKey, 'media');
        return;
      default:
        log.debug('line: unsupported message type dropped', {
          msgType: event.msgType,
          messageId: event.messageId,
        });
    }
  }

  /**
   * Sends a local image or file to the chat that owns this session. Used by the
   * `line_send_media` tool; the path has already been validated by the caller.
   */
  async sendMedia(sessionKey: string, kind: 'image' | 'file' | 'voice', path: string): Promise<string> {
    const chatId = this.chatBySession.get(sessionKey);
    if (chatId === undefined) {
      throw new Error(`line: no chat recorded for session ${sessionKey}`);
    }
    const data = await readFile(path);
    if (kind === 'image') {
      const imageKey = await this.client.uploadImage(data);
      await this.client.sendToChat(chatId, 'image', JSON.stringify({ image_key: imageKey }));
      return '';
    }
    const name = basename(path);
    const fileKey = await this.client.uploadFile(data, name, feishuFileType(name));
    await this.client.sendToChat(chatId, 'file', JSON.stringify({ file_key: fileKey }));
    // Voice bubbles are a WeChat-only shape here; Lark gets the file instead.
    return kind === 'voice' ? '（飞书按文件发送，语音气泡仅微信支持）' : '';
  }

  /** Cancels pending batch timers (daemon shutdown). */
  stop(): void {
    for (const batch of this.pendingImages.values()) clearTimeout(batch.timer);
    this.pendingImages.clear();
  }

  private async handleText(event: FeishuEventMessage, sessionKey: string): Promise<void> {
    let text: string;
    try {
      const parsed = parseContent<{ text?: string }>(event.content);
      text = typeof parsed?.text === 'string' ? parsed.text : '';
    } catch {
      log.warn('line: unparseable text content', { messageId: event.messageId });
      return;
    }
    text = stripMentions(text, event.mentions, this.client.botOpenId);
    const quoted = await this.collectQuoted(event, sessionKey, MAX_IMAGES_PER_TURN);
    if (!text.trim() && quoted.images.length === 0 && quoted.files.length === 0) {
      log.debug('line: empty text after mention stripping', { messageId: event.messageId });
      return;
    }
    await this.react(event.messageId);
    await this.dispatch({
      sessionKey,
      text: `${quoted.prefix}${text}`,
      images: quoted.images,
      files: quoted.files,
      context: dispatchContext(event),
    });
  }

  /**
   * Image messages join a short per-session batch: phones send album selections
   * as N separate messages, and one turn per photo is both slow and token-heavy.
   */
  private async handleImage(event: FeishuEventMessage, sessionKey: string): Promise<void> {
    const parsed = parseContent<{ image_key?: string }>(event.content);
    const key = parsed?.image_key;
    if (typeof key !== 'string' || key.length === 0) {
      log.warn('line: image message without image_key', { messageId: event.messageId });
      return;
    }
    try {
      const data = await this.client.downloadImage(event.messageId, key, MAX_INBOUND_IMAGE_BYTES);
      if (data.length > MAX_INBOUND_IMAGE_BYTES) {
        log.warn('line: inbound image over the size cap', { bytes: data.length });
        await this.safeReply(event.messageId, buildTextJSON(IMAGE_FAILED_TEXT));
        return;
      }
      const quoted = await this.collectQuoted(event, sessionKey, MAX_IMAGES_PER_TURN - 1);
      const image = { mime: sniffImageMime(data), data };
      if (quoted.prefix.length > 0 || quoted.files.length > 0) {
        // A quote-reply carrying a photo must keep the quoted text: batching
        // would dispatch `text: ''` and drop it. Flush anything already queued
        // first, otherwise this reply overtakes the photos it refers to.
        await this.flushImageBatch(sessionKey);
        await this.react(event.messageId);
        await this.dispatch({
          sessionKey,
          text: quoted.prefix,
          images: [...quoted.images, image].slice(0, MAX_IMAGES_PER_TURN),
          files: quoted.files,
          context: dispatchContext(event),
        });
        return;
      }
      this.queueImage(sessionKey, event, image);
    } catch (error) {
      log.warn('line: image download failed', { messageId: event.messageId, error: String(error) });
      await this.safeReply(event.messageId, buildTextJSON(IMAGE_FAILED_TEXT));
    }
  }

  /** Rich-text post: collects its text and inline images. */
  private async handlePost(event: FeishuEventMessage, sessionKey: string): Promise<void> {
    const { textChunks, imageKeys, fileKeys } = parsePostPayload(event.content);
    const quoted = await this.collectQuoted(event, sessionKey, MAX_IMAGES_PER_TURN);
    const images: LineImageAttachment[] = [...quoted.images];
    const files: string[] = [...quoted.files];
    for (const file of fileKeys) {
      try {
        const data = await this.client.downloadResource(
          event.messageId,
          file.key,
          'file',
          MAX_INBOUND_FILE_BYTES,
        );
        files.push(await saveInboundFile(sessionKey, file.name.trim() || `${event.messageId}.bin`, data));
      } catch (error) {
        log.warn('line: post file download failed', { messageId: event.messageId, error: String(error) });
      }
    }
    for (const key of imageKeys.slice(0, Math.max(0, MAX_IMAGES_PER_TURN - images.length))) {
      try {
        const data = await this.client.downloadImage(event.messageId, key, MAX_INBOUND_IMAGE_BYTES);
        if (data.length <= MAX_INBOUND_IMAGE_BYTES) {
          images.push({ mime: sniffImageMime(data), data });
        }
      } catch (error) {
        log.warn('line: post image download failed', { messageId: event.messageId, error: String(error) });
      }
    }
    const text = `${quoted.prefix}${stripMentions(textChunks.join('\n').trim(), event.mentions, this.client.botOpenId)}`;
    if (text.trim().length === 0 && images.length === 0 && files.length === 0) return;
    await this.react(event.messageId);
    await this.dispatch({ sessionKey, text, images, files, context: dispatchContext(event) });
  }

  /**
   * Pulls the message the user replied to (quote) and returns its text prefix
   * plus any media it carried. Never throws: a missing parent degrades to a
   * reply without the quote.
   */
  private async collectQuoted(
    event: FeishuEventMessage,
    sessionKey: string,
    imageSlots: number,
  ): Promise<{ prefix: string; images: LineImageAttachment[]; files: string[] }> {
    const requesterId = event.senderUserId;
    const empty = { prefix: '', images: [] as LineImageAttachment[], files: [] as string[] };
    const parentId = event.parentId;
    if (parentId === undefined || parentId.length === 0) return empty;

    let parent: FeishuQuotedMessage | null = null;
    try {
      parent = await this.client.getMessage(parentId);
    } catch (error) {
      log.warn('line: quoted message fetch failed', { parentId, error: String(error) });
      return empty;
    }
    if (parent === null) return empty;

    const parsed = parseQuoted(parent);
    const images: LineImageAttachment[] = [];
    for (const key of parsed.imageKeys.slice(0, Math.min(QUOTED_MAX_IMAGES, imageSlots))) {
      try {
        const data = await this.client.downloadImage(parentId, key, MAX_INBOUND_IMAGE_BYTES);
        if (data.length <= MAX_INBOUND_IMAGE_BYTES) {
          images.push({ mime: sniffImageMime(data), data });
        }
      } catch (error) {
        log.warn('line: quoted image download failed', { parentId, error: String(error) });
      }
    }
    // Quoted attachments are only fetched when the quoting user is the one who
    // sent the parent: otherwise a group member could pull another member's
    // file into their own session (reference issue #1560).
    const filesAllowed =
      parsed.fileKeys.length > 0 &&
      parent.senderId !== undefined &&
      parent.senderId === requesterId;
    if (parsed.fileKeys.length > 0 && !filesAllowed) {
      log.debug('line: quoted attachments skipped (different sender)', {
        parentId,
        requesterId,
        senderId: parent.senderId,
      });
    }
    const files: string[] = [];
    for (const file of filesAllowed ? parsed.fileKeys : []) {
      try {
        const data = await this.client.downloadResource(parentId, file.key, 'file', MAX_INBOUND_FILE_BYTES);
        files.push(await saveInboundFile(sessionKey, file.name.trim() || `${parentId}.bin`, data));
      } catch (error) {
        log.warn('line: quoted file download failed', { parentId, error: String(error) });
      }
    }
    return { prefix: quotePrefix(parsed.text), images, files };
  }

  /** Files, audio and video: written under the Scream home, path handed over. */
  private async handleFile(
    event: FeishuEventMessage,
    sessionKey: string,
    kind: 'file' | 'audio' | 'media',
  ): Promise<void> {
    const parsed = parseContent<{ file_key?: string; file_name?: string }>(event.content);
    const key = parsed?.file_key;
    if (typeof key !== 'string' || key.length === 0) {
      log.warn('line: attachment message without file_key', { messageId: event.messageId, kind });
      return;
    }
    const declared = typeof parsed?.file_name === 'string' ? parsed.file_name : '';
    const fallback = kind === 'audio' ? `${event.messageId}.audio` : kind === 'media' ? `${event.messageId}.mp4` : `${event.messageId}.bin`;
    try {
      const data = await this.client.downloadResource(event.messageId, key, 'file', MAX_INBOUND_FILE_BYTES);
      const path = await saveInboundFile(sessionKey, declared.trim() || fallback, data);
      const quoted = await this.collectQuoted(event, sessionKey, MAX_IMAGES_PER_TURN);
      await this.react(event.messageId);
      await this.dispatch({
        sessionKey,
        text: quoted.prefix,
        images: quoted.images,
        files: [...quoted.files, path],
        context: dispatchContext(event),
      });
    } catch (error) {
      log.warn('line: attachment download failed', { messageId: event.messageId, kind, error: String(error) });
      await this.safeReply(event.messageId, buildTextJSON(FILE_FAILED_TEXT));
    }
  }

  private queueImage(
    sessionKey: string,
    event: FeishuEventMessage,
    image: LineImageAttachment,
  ): void {
    const batch = this.pendingImages.get(sessionKey);
    if (batch !== undefined && batch.images.length >= MAX_IMAGES_PER_TURN) {
      // Batch is full: flush it now and open a fresh one with this image, so a
      // five-photo album loses nothing (and the reply is not threaded onto the
      // wrong message).
      void this.flushImageBatch(sessionKey).catch((error: unknown) => {
        log.warn('line: image batch dispatch failed', { sessionKey, error: String(error) });
      });
    }
    const current = this.pendingImages.get(sessionKey);
    if (current !== undefined) {
      clearTimeout(current.timer);
      current.images.push(image);
      current.lastEvent = event;
      current.timer = setTimeout(() => {
        void this.flushImageBatch(sessionKey).catch((error: unknown) => {
          log.warn('line: image batch dispatch failed', { sessionKey, error: String(error) });
        });
      }, IMAGE_BATCH_WINDOW_MS);
      return;
    }
    const created: PendingImageBatch = {
      images: [image],
      lastEvent: event,
      timer: setTimeout(() => {
        void this.flushImageBatch(sessionKey).catch((error: unknown) => {
          log.warn('line: image batch dispatch failed', { sessionKey, error: String(error) });
        });
      }, IMAGE_BATCH_WINDOW_MS),
    };
    this.pendingImages.set(sessionKey, created);
  }

  private async flushImageBatch(sessionKey: string): Promise<void> {
    const batch = this.pendingImages.get(sessionKey);
    if (batch === undefined) return;
    this.pendingImages.delete(sessionKey);
    clearTimeout(batch.timer);
    await this.react(batch.lastEvent.messageId);
    await this.dispatch({
      sessionKey,
      text: '',
      images: batch.images,
      context: dispatchContext(batch.lastEvent),
    });
  }

  /** Receipt reaction (visible "on it" marker, removed when the turn ends). */
  private async react(messageId: string): Promise<void> {
    if (!this.options.reactionEmoji) return;
    const reactionId = await this.client.addReaction(messageId, this.options.reactionEmoji);
    if (reactionId) this.receipts.set(messageId, reactionId);
  }

  /** Turn finished: remove the receipt reaction, add the done emoji. */
  async finishMessage(messageId: string): Promise<void> {
    const reactionId = this.receipts.get(messageId);
    if (reactionId) {
      this.receipts.delete(messageId);
      await this.client.removeReaction(messageId, reactionId);
    }
    if (this.options.doneEmoji) {
      await this.client.addReaction(messageId, this.options.doneEmoji);
    }
  }

  private async safeReply(messageId: string, body: string): Promise<void> {
    try {
      await this.client.reply(messageId, 'text', body);
    } catch (error) {
      log.warn('line: reply failed', { messageId, error: String(error) });
    }
  }
}
