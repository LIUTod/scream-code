/**
 * weixin (ilink bot gateway) platform for the line daemon.
 *
 * Direct port of the reference platform/weixin/weixin.go behaviors:
 *   - long-poll loop with 1s→30s exponential backoff; errcode -14 (session
 *     expired) pauses the session for 1h instead of hammering the gateway
 *   - getupdates cursor (get_updates.buf) + per-peer context_token cache,
 *     both persisted 0600 under ~/.scream-code/line/weixin/
 *   - dispatch filter order: bot/self messages → empty sender → allow_from
 *     (SILENT drop — unlike feishu there is no unauthorized reply) → old
 *     message (replay guard) → dedup (key from|message_id|seq|create_time|
 *     client_id, default 300s window) → text extraction → dispatch
 *   - typing indicator lifecycle (getconfig ticket, 5s keep-alive, stop)
 *   - chunked replies (≤3800 chars, fence-aware, 100ms between chunks);
 *     ret=-2 throttle fails fast, and a partial-failure notice is sent once
 *
 * Media: `inbound-media.ts` downloads and AES-128-ECB-decrypts image / file /
 * video / untranscribed voice items (ASR text wins when present); outbound goes
 * `getuploadurl` → CDN upload → `sendmessage` media item (`sendMedia`).
 *
 * Deviations: no proactive push path (line only replies), no proxy support,
 * burst quota not needed (everything is a reply, which ilink does not throttle).
 */

import { createHash, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { log } from '@scream-code/scream-code-sdk';

import { basename } from 'node:path';

import { MessageDedup } from '../dedup';
import type { LineImageAttachment } from '../media';
import type { ProactiveDelivery } from '../proactive';
import { collectInboundMedia } from './inbound-media';
import { AudioConversionError, FfmpegUnavailableError, convertToAmr } from './voice';
import { DEFAULT_CDN_BASE_URL } from './cdn';
import {
  getWeixinContextTokensFile,
  getWeixinCursorFile,
  getWeixinStateDir,
  type WeixinRuntimeOptions,
} from '../config';
import {
  MESSAGE_TYPE_BOT,
  MESSAGE_TYPE_USER,
  SESSION_EXPIRED_ERRCODE,
  TYPING_STATUS_START,
  TYPING_STATUS_STOP,
  UPLOAD_MEDIA_TYPE,
  WeixinClient,
  isSendThrottled,
  type IlinkMessage,
} from './client';
import {
  WEIXIN_CHUNK_SEND_DELAY_MS,
  bodyFromItemList,
  splitMessageCodeFenceAware,
  type IlinkMessageItem,
} from './format';

const PAUSE_AFTER_SESSION_EXPIRED_MS = 60 * 60 * 1000;
const PAUSE_POLL_RETRY_MS = 5_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const TYPING_TICKET_TTL_MS = 10 * 60 * 1000;
const TYPING_REPEAT_MS = 5_000;
const PARTIAL_SEND_NOTICE = '⚠️ 消息发送不完整，请在终端查看完整结果。';
/** ilink item types used for outbound media (reference: 2/4/5). */
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_FILE = 4;
const ITEM_TYPE_VOICE = 3;
const ITEM_TYPE_VIDEO = 5;
/** Reply used when a media-only message could not be decoded. */
export const MEDIA_FAILED_TEXT = '媒体接收失败，请重新发送一次。';

export interface WeixinDispatchContext {
  peerUserId: string;
  contextToken: string;
  messageId: string;
  userId: string;
}

export interface WeixinDispatch {
  sessionKey: string;
  text: string;
  /** Inbound images, already downloaded and decrypted. */
  images?: LineImageAttachment[];
  /** Inbound files already written to disk (absolute paths). */
  files?: string[];
  context: WeixinDispatchContext;
}

interface TypingTicketEntry {
  ticket: string;
  fetchedAt: number;
}

function randomHex(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += randomInt(16).toString(16);
  }
  return out;
}

/** the reference sessionKey `weixin:dm:<from>`, hashed into a scream session id. */
export function makeWeixinSessionKey(peerUserId: string): string {
  const ccKey = `weixin:dm:${peerUserId}`;
  const hash = createHash('sha1').update(ccKey).digest('hex').slice(0, 16);
  return `line-weixin-${hash}`;
}

export class WeixinPlatform {
  private readonly dedup: MessageDedup;
  private readonly startMs = Date.now();
  private cursor = '';
  private readonly contextTokens = new Map<string, string>();
  /** sessionKey → latest peer/context, so outbound media can be addressed. */
  private readonly latestTargets = new Map<string, { peerUserId: string; contextToken: string }>();
  private readonly typingTickets = new Map<string, TypingTicketEntry>();
  private readonly activeTypings = new Map<string, ReturnType<typeof setInterval>>();
  private pauseUntil = 0;
  private stopping = false;
  private abort: AbortController | undefined;

  constructor(
    readonly options: WeixinRuntimeOptions,
    private readonly client: WeixinClient,
    private readonly dispatch: (message: WeixinDispatch) => Promise<void> | void,
  ) {
    this.dedup = new MessageDedup(options.dedupWindowMs);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Load persisted state and start the long-poll loop (fire and forget). */
  async start(onReady?: () => void): Promise<void> {
    await mkdir(getWeixinStateDir(), { recursive: true });
    this.cursor = (await readFile(getWeixinCursorFile(), 'utf-8').catch(() => '')).trim();
    const tokensRaw = await readFile(getWeixinContextTokensFile(), 'utf-8').catch(() => '{}');
    try {
      const parsed = JSON.parse(tokensRaw) as Record<string, string>;
      for (const [peer, token] of Object.entries(parsed)) {
        if (typeof token === 'string') this.contextTokens.set(peer, token);
      }
    } catch {
      // start fresh on a corrupted cache; the next inbound message rebuilds it
    }
    this.abort = new AbortController();
    void this.pollLoop(onReady).catch((error) => {
      log.error('line-weixin: poll loop crashed', { error: String(error) });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    for (const [peer, timer] of this.activeTypings) {
      clearInterval(timer);
      void this.sendTypingStop(peer).catch(() => {});
    }
    this.activeTypings.clear();
  }

  // ─── Poll loop (port of pollLoop) ───────────────────────────────────────

  private async pollLoop(onReady?: () => void): Promise<void> {
    let backoffMs = BACKOFF_INITIAL_MS;
    let readyNotified = false;
    while (!this.stopping) {
      if (this.pauseUntil > Date.now()) {
        await sleep(Math.min(PAUSE_POLL_RETRY_MS, this.pauseUntil - Date.now()));
        continue;
      }
      this.pauseUntil = 0;
      let response;
      try {
        response = await this.client.getUpdates(this.cursor);
      } catch (error) {
        log.warn('line-weixin: getUpdates failed, backing off', { backoff: backoffMs, error: String(error) });
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }
      backoffMs = BACKOFF_INITIAL_MS;

      if (response.errcode === SESSION_EXPIRED_ERRCODE) {
        this.pauseUntil = Date.now() + PAUSE_AFTER_SESSION_EXPIRED_MS;
        log.warn('line-weixin: session expired (errcode -14), paused 1h — 在微信里重新给机器人发一条消息即可恢复', {});
        continue;
      }
      if ((response.ret ?? 0) !== 0 && response.errmsg) {
        log.warn('line-weixin: getUpdates ret', { ret: response.ret, errcode: response.errcode, errmsg: response.errmsg });
      }
      if (!readyNotified) {
        readyNotified = true;
        log.info('line-weixin: ilink ready-for-poll', {});
        onReady?.();
      }
      for (const message of response.msgs ?? []) {
        if (this.stopping) break;
        await this.dispatchInbound(message);
      }
      if (!this.stopping && response.get_updates_buf) {
        this.cursor = response.get_updates_buf;
        await this.persistCursor();
      }
    }
  }

  // ─── Inbound pipeline (port of dispatchInbound) ─────────────────────────

  /** Inbound pipeline entry (wired from the poll loop; public for tests). */
  async dispatchInbound(m: IlinkMessage): Promise<void> {
    if (m.message_type === MESSAGE_TYPE_BOT) return; // our own echo
    if (m.message_type !== 0 && m.message_type !== MESSAGE_TYPE_USER) return;
    const from = (m.from_user_id ?? '').trim();
    if (from === '') return;

    // allow_from — SILENT drop (the reference weixin has no unauthorized reply).
    if (!allowListPasses(this.options.allowFrom, from)) {
      log.debug('line-weixin: sender not in allow_from', { from });
      return;
    }
    if ((m.create_time_ms ?? 0) > 0 && (m.create_time_ms ?? 0) < this.startMs) {
      log.debug('line-weixin: skip old message after restart', { from });
      return;
    }
    const dedupKey = `${from}|${m.message_id ?? 0}|${m.seq ?? 0}|${m.create_time_ms ?? 0}|${(m.client_id ?? '').trim()}`;
    if (this.dedup.isDuplicate(dedupKey)) {
      log.debug('line-weixin: dropping duplicate message', { from, message_id: m.message_id });
      return;
    }

    const contextToken = (m.context_token ?? '').trim();
    if (contextToken !== '') {
      await this.setContextToken(from, contextToken);
      void this.prefetchTypingTicket(from, contextToken).catch(() => {});
    }

    const messageId = (m.message_id ?? 0) !== 0 ? String(m.message_id) : randomHex(8);
    const dispatchContext: WeixinDispatchContext = {
      peerUserId: from,
      contextToken,
      messageId,
      userId: from,
    };
    const sessionKey = makeWeixinSessionKey(from);

    const body = bodyFromItemList(m.item_list);
    const media = await collectInboundMedia({
      client: this.client,
      items: (m.item_list ?? []) as IlinkMessageItem[],
      cdnBaseUrl: this.options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      sessionKey,
    });

    if (body.trim() === '' && media.images.length === 0 && media.files.length === 0) {
      // A media-only message that we could not decode is worth one line back;
      // staying silent reads as "the bot is broken".
      if (media.failed) await this.replyText(dispatchContext, MEDIA_FAILED_TEXT);
      return;
    }

    this.latestTargets.set(sessionKey, { peerUserId: from, contextToken });
    log.debug('line-weixin: dispatching inbound message', {
      messageId,
      sessionKey,
      images: media.images.length,
      files: media.files.length,
    });
    await this.dispatch({
      sessionKey,
      text: body,
      images: media.images,
      files: media.files,
      context: dispatchContext,
    });
  }

  // ─── Outbound (port of Reply/sendChunks) ────────────────────────────────

  /** Reply text to a peer; chunked, fence-aware, throttle fail-fast. */
  /**
   * Sends text to the peer that owns this session with no inbound message to
   * reply to — the scheduled-task path. WeChat requires a `context_token`,
   * cached from the last inbound message; without one there is nothing we can
   * legally address, so this reports `no-target` instead of failing a send.
   */
  async sendProactive(sessionKey: string, text: string): Promise<ProactiveDelivery> {
    const body = text.trim();
    if (body === '') return 'no-target';
    const target = this.latestTargets.get(sessionKey);
    const peer = target?.peerUserId;
    if (peer === undefined) {
      log.warn('line-weixin: no peer recorded for proactive send', { sessionKey });
      return 'no-target';
    }
    const token = (target?.contextToken ?? '').trim() || (this.contextTokens.get(peer) ?? '');
    if (token === '') {
      // Same constraint the reference documents: the user must message the bot
      // once after a restart before we may push to them.
      log.warn('line-weixin: no context_token for proactive send (user must message first)', {
        sessionKey,
      });
      return 'no-target';
    }
    try {
      const chunks = splitMessageCodeFenceAware(body);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(WEIXIN_CHUNK_SEND_DELAY_MS);
        await this.client.sendText(peer, chunks[i] ?? '', token, this.client.newClientId());
      }
      return 'sent';
    } catch (error) {
      log.warn('line-weixin: proactive send failed', { sessionKey, error: String(error) });
      return 'failed';
    }
  }

  /**
   * Sends a local image or file to the chat that owns this session: upload to
   * the CDN (AES-128-ECB), then `sendmessage` with the media item. Ported from
   * the reference `SendImage`/`SendFile`.
   */
  async sendMedia(
    sessionKey: string,
    kind: 'image' | 'file' | 'voice',
    path: string,
  ): Promise<string> {
    const target = this.latestTargets.get(sessionKey);
    if (target === undefined) {
      throw new Error(`line: no reply target recorded for session ${sessionKey}`);
    }
    let data: Buffer = await readFile(path);
    const name = basename(path);
    let effectiveKind: 'image' | 'file' | 'voice' = kind;
    let note = '';

    if (kind === 'voice') {
      // The gateway only accepts AMR-NB for a voice bubble; anything else is
      // transcoded. A missing/unusable ffmpeg degrades to a file message
      // instead of failing the turn — product must work without extra deps.
      try {
        data = await this.convertVoiceToAmr(data);
      } catch (error) {
        if (error instanceof FfmpegUnavailableError || error instanceof AudioConversionError) {
          effectiveKind = 'file';
          note = `（未转成语音：${error.message}）`;
        } else {
          throw error;
        }
      }
    }

    const isVideo = effectiveKind === 'file' && /\.(mp4|mov|m4v)$/i.test(name);
    const mediaType =
      effectiveKind === 'image'
        ? UPLOAD_MEDIA_TYPE.image
        : isVideo
          ? UPLOAD_MEDIA_TYPE.video
          : UPLOAD_MEDIA_TYPE.file;
    const ref = await this.client.uploadMedia({
      toUserId: target.peerUserId,
      data,
      mediaType,
      cdnBaseUrl: this.options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
    });
    const media = {
      encrypt_query_param: ref.downloadParam,
      // The gateway wants base64 of the 32-char hex form, not the raw bytes.
      aes_key: Buffer.from(ref.aesKey.toString('hex'), 'latin1').toString('base64'),
      encrypt_type: 1,
    };
    const item =
      effectiveKind === 'image'
        ? { type: ITEM_TYPE_IMAGE, image_item: { media, mid_size: ref.cipherSize } }
        : effectiveKind === 'voice'
          ? // encode_type 0 = AMR (1 would be SILK).
            { type: ITEM_TYPE_VOICE, voice_item: { media, encode_type: 0 } }
          : isVideo
            ? { type: ITEM_TYPE_VIDEO, video_item: { media, video_size: ref.cipherSize } }
            : { type: ITEM_TYPE_FILE, file_item: { media, file_name: name, len: String(ref.rawSize) } };
    await this.client.sendMediaItem(
      target.peerUserId,
      target.contextToken,
      this.client.newClientId(),
      item,
    );
    if (effectiveKind === 'voice') {
      // The gateway answers `ret: 0` even when it drops a voice item, so a
      // successful call is not proof of delivery. Record it: without this line
      // "sent but the phone stayed silent" has no trace to investigate.
      log.warn('line: voice submitted without delivery receipt', {
        sessionKey,
        bytes: data.length,
        note: 'gateway ret=0 is not a delivery confirmation',
      });
    }
    return note;
  }

  /** Indirection so tests can exercise the ffmpeg-missing fallback. */
  protected async convertVoiceToAmr(data: Buffer): Promise<Buffer> {
    return convertToAmr(data);
  }

  async replyText(context: WeixinDispatchContext, content: string): Promise<void> {
    let token = context.contextToken.trim();
    if (token === '') token = this.contextTokens.get(context.peerUserId) ?? '';
    if (token === '') {
      throw new Error(`weixin: missing context_token for ${context.peerUserId} — 需要对方先发一条消息`);
    }
    if (content.trim() === '') return;
    const chunks = splitMessageCodeFenceAware(content);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(WEIXIN_CHUNK_SEND_DELAY_MS);
      try {
        await this.client.sendText(context.peerUserId, chunks[i] ?? '', token, this.client.newClientId());
      } catch (error) {
        log.error('line-weixin: chunk send failed, message incomplete', {
          peer: context.peerUserId,
          chunk: `${i + 1}/${chunks.length}`,
          error: String(error),
        });
        // Throttle: sending more (including the notice) escalates the penalty.
        if (!isSendThrottled(error)) {
          await this.client
            .sendText(context.peerUserId, PARTIAL_SEND_NOTICE, token, this.client.newClientId())
            .catch((noticeError) => {
              log.warn('line-weixin: partial-delivery notice failed', { error: String(noticeError) });
            });
        }
        throw error;
      }
    }
  }

  // ─── Typing indicator (port of StartTyping/getTypingTicket) ─────────────

  /** Start a typing indicator for the peer; returns the stop function. */
  startTyping(context: WeixinDispatchContext): () => void {
    const peer = context.peerUserId;
    void (async () => {
      const ticket = await this.getTypingTicket(peer, context.contextToken).catch(() => '');
      if (this.stopping || ticket === '') return;
      try {
        await this.client.sendTyping(peer, ticket, TYPING_STATUS_START);
      } catch {
        return; // best-effort
      }
      const existing = this.activeTypings.get(peer);
      if (existing) clearInterval(existing);
      const timer = setInterval(() => {
        void this.client.sendTyping(peer, ticket, TYPING_STATUS_START).catch(() => {
          this.clearTyping(peer);
        });
      }, TYPING_REPEAT_MS);
      this.activeTypings.set(peer, timer);
    })();
    return () => {
      this.stopTyping(peer);
    };
  }

  stopTyping(peer: string): void {
    this.clearTyping(peer);
    void this.sendTypingStop(peer).catch(() => {});
  }

  private clearTyping(peer: string): void {
    const timer = this.activeTypings.get(peer);
    if (timer) {
      clearInterval(timer);
      this.activeTypings.delete(peer);
    }
  }

  private async sendTypingStop(peer: string): Promise<void> {
    const ticket = this.typingTickets.get(peer)?.ticket ?? '';
    if (ticket === '') return;
    await this.client.sendTyping(peer, ticket, TYPING_STATUS_STOP);
  }

  private async getTypingTicket(peer: string, contextToken: string): Promise<string> {
    const cached = this.typingTickets.get(peer);
    if (cached && Date.now() - cached.fetchedAt < TYPING_TICKET_TTL_MS) return cached.ticket;
    const token = contextToken.trim() !== '' ? contextToken.trim() : (this.contextTokens.get(peer) ?? '');
    if (token === '') return '';
    const ticket = await this.client.getConfig(peer, token);
    if (ticket === '') return '';
    this.typingTickets.set(peer, { ticket, fetchedAt: Date.now() });
    return ticket;
  }

  private async prefetchTypingTicket(peer: string, contextToken: string): Promise<void> {
    await this.getTypingTicket(peer, contextToken);
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private async persistCursor(): Promise<void> {
    await writeFile(getWeixinCursorFile(), this.cursor, { encoding: 'utf-8', mode: 0o600 }).catch((error) => {
      log.warn('line-weixin: save sync buf failed', { error: String(error) });
    });
  }

  private async setContextToken(peer: string, token: string): Promise<void> {
    if (peer === '' || token === '') return;
    this.contextTokens.set(peer, token);
    const obj: Record<string, string> = {};
    for (const [k, v] of this.contextTokens) obj[k] = v;
    try {
      await mkdir(getWeixinStateDir(), { recursive: true });
      await writeFile(getWeixinContextTokensFile(), JSON.stringify(obj, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } catch (error) {
      log.warn('line-weixin: save context tokens failed', { error: String(error) });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────/** the reference core.AllowList semantics: empty list = allow everyone. */
export function allowListPasses(list: string[], value: string): boolean {
  if (list.length === 0) return true;
  return list.includes(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
