/**
 * Feishu client for the line daemon — a thin wrapper over the official
 * `@larksuiteoapi/node-sdk` (WS long-connection events + REST send) with a
 * cached tenant token for direct REST calls the SDK does not surface.
 *
 * Ports of the reference behavior (platform/feishu/feishu.go):
 *   - transient retry with exponential backoff + jitter (withTransientRetry)
 *   - bot open_id fetch that degrades fail-closed when unreachable
 *     (issue #1618 semantics: never answer every group message)
 * The JS SDK manages tenant tokens internally for its REST calls; the manual
 * cached-token path here only serves validateCredentials/bot-info, which use
 * raw fetch so failures map to explicit, user-facing error messages.
 */

import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';

import { log } from '@scream-code/scream-code-sdk';

import type { FeishuRuntimeOptions } from '../config';

// ─── Normalized inbound event ─────────────────────────────────────────────

export interface FeishuMention {
  key: string;
  openId?: string;
  name?: string;
}

export interface FeishuEventMessage {
  messageId: string;
  chatId: string;
  /** 'p2p' | 'group' (other values pass through as-is). */
  chatType: string;
  msgType: string;
  /** Raw JSON string from Feishu (e.g. `{"text":"..."}`). */
  content: string;
  mentions: FeishuMention[];
  /** Epoch ms parsed from create_time; 0 when absent/unparseable. */
  createTimeMs: number;
  rootId?: string;
  parentId?: string;
  senderUserId: string;
}

export interface FeishuSdkLike {
  new (opts: { appId: string; appSecret: string; domain?: string }): unknown;
}

// ─── Transient retry (port of withTransientRetry) ─────────────────────────

export const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_INITIAL_DELAY_MS = 500;
const TRANSIENT_MAX_DELAY_MS = 5_000;

/** Retryable network failures (the reference isTransientError, typed where JS allows). */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
    return true;
  }
  const rawMessage = (error as Error)?.message;
  const msg = typeof rawMessage === 'string' ? rawMessage : typeof error;
  return [
    'connection reset by peer',
    'broken pipe',
    'i/o timeout',
    'TLS handshake timeout',
    'server misbehaving',
    'connection refused',
    'fetch failed',
    'network timeout',
  ].some((substr) => msg.includes(substr));
}

/** Exponential backoff with ≤25% jitter (the reference withTransientRetry). */
export async function withTransientRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  let delay = TRANSIENT_INITIAL_DELAY_MS;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        log.info('line: transient retry succeeded', { operation, attempt: attempt + 1 });
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isTransientError(error)) throw error;
      if (attempt === MAX_TRANSIENT_RETRIES) break;
      const jitter = Math.floor(Math.random() * (delay / 4));
      log.warn('line: transient error, retrying', {
        operation,
        attempt: attempt + 1,
        delay: delay + jitter,
        error: String(error),
      });
      await sleep(delay + jitter);
      delay = Math.min(delay * 2, TRANSIENT_MAX_DELAY_MS);
    }
  }
  throw new Error(`${operation} 在 ${MAX_TRANSIENT_RETRIES} 次重试后仍失败：${String(lastError)}`);
}
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ─── Credential validation (raw REST for explicit error mapping) ──────────

export class FeishuCredentialError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'invalid' | 'unknown',
  ) {
    super(message);
    this.name = 'FeishuCredentialError';
  }
}

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

/** Prove app_id + app_secret work; called by the /line wizard. */
export async function validateFeishuCredentials(
  appId: string,
  appSecret: string,
  domain = 'https://open.feishu.cn',
): Promise<void> {
  let response: Response;
  try {
    response = await withTransientRetry('feishu.validate', () =>
      fetch(new URL('/open-apis/auth/v3/tenant_access_token/internal', domain), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
  } catch (error) {
    throw new FeishuCredentialError(`网络错误，无法连接飞书开放平台：${String(error)}`, 'network');
  }
  let body: TokenResponse;
  try {
    body = (await response.json()) as TokenResponse;
  } catch {
    throw new FeishuCredentialError(`飞书开放平台返回异常响应（HTTP ${response.status}）`, 'unknown');
  }
  if (body.code !== 0) {
    throw new FeishuCredentialError(
      `凭证无效或应用不可用（code=${body.code}，msg=${body.msg ?? '未知'}）。请检查 app_id/app_secret 是否正确、应用是否已发布。`,
      'invalid',
    );
  }
}

// ─── Client ───────────────────────────────────────────────────────────────

interface LarkClient {
  im: {
    message: {
      reply: (payload: {
        path: { message_id: string };
        data: { msg_type: string; content: string };
      }) => Promise<unknown>;
      create: (payload: {
        params: { receive_id_type: string };
        data: { receive_id: string; msg_type: string; content: string };
      }) => Promise<unknown>;
    };
    messageReaction: {
      create: (payload: {
        path: { message_id: string };
        data: { reaction_type: { emoji_type: string } };
      }) => Promise<{ data?: { reaction_id?: string } }>;
      delete: (payload: { path: { message_id: string; reaction_id: string } }) => Promise<unknown>;
    };
  };
}

interface LarkWSClient {
  start: (params: { eventDispatcher: InstanceType<typeof EventDispatcher> }) => Promise<void>;
  close: (params?: { force?: boolean }) => void;
}

export type FeishuMessageHandler = (event: FeishuEventMessage) => Promise<void> | void;

export class FeishuClient {
  private readonly client: LarkClient;
  private ws: LarkWSClient | undefined;
  private cachedToken: { token: string; expireAt: number } | undefined;
  /** Bot open_id; undefined while unknown (group filter degraded → fail closed). */
  botOpenId: string | undefined;

  constructor(
    readonly options: FeishuRuntimeOptions,
    private readonly deps: {
      ClientCtor?: unknown;
      WSClientCtor?: unknown;
      EventDispatcherCtor?: unknown;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    const ClientCtor = (deps.ClientCtor ?? Client) as unknown as new (o: {
      appId: string;
      appSecret: string;
      domain?: string;
    }) => LarkClient;
    this.client = new ClientCtor({
      appId: options.appId,
      appSecret: options.appSecret,
      domain: options.domain,
    });
  }

  /** Open the WebSocket long connection; resolves after a successful start. */
  async connect(onMessage: FeishuMessageHandler): Promise<void> {
    const DispatcherCtor = (this.deps.EventDispatcherCtor ?? EventDispatcher) as typeof EventDispatcher;
    const dispatcher = new DispatcherCtor({});
    const handlers: Record<string, unknown> = {
      'im.message.receive_v1': (data: unknown) => {
        const event = normalizeReceiveEvent(data);
        if (!event) return Promise.resolve();
        return Promise.resolve(onMessage(event));
      },
    };
    (dispatcher.register as (h: Record<string, unknown>) => void)(handlers);
    const WSClientCtor = (this.deps.WSClientCtor ?? WSClient) as typeof WSClient;
    const ws = new WSClientCtor({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: this.options.domain,
    });
    this.ws = ws;
    await withTransientRetry('feishu.ws.start', () => ws.start({ eventDispatcher: dispatcher }), this.deps.sleep);
  }

  async close(): Promise<void> {
    this.ws?.close({ force: true });
    this.ws = undefined;
  }

  // ── Outbound ──

  async reply(messageId: string, msgType: string, body: string): Promise<void> {
    await withTransientRetry('feishu.reply', () =>
      this.client.im.message.reply({ path: { message_id: messageId }, data: { msg_type: msgType, content: body } }),
    );
  }

  async sendToChat(chatId: string, msgType: string, body: string): Promise<void> {
    await withTransientRetry('feishu.create', () =>
      this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content: body },
      }),
    );
  }

  /** Add a reaction; returns the reaction id (empty when the call fails). */
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    try {
      const result = await withTransientRetry('feishu.reaction.add', () =>
        this.client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emojiType } },
        }),
      );
      return result?.data?.reaction_id ?? '';
    } catch (error) {
      log.warn('line: add reaction failed', { messageId, emoji: emojiType, error: String(error) });
      return '';
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!reactionId) return;
    try {
      await this.client.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
    } catch (error) {
      log.debug?.('line: remove reaction failed', { messageId, error: String(error) });
    }
  }

  // ── Bot identity (fail-closed group filter, port of issue #1618) ──

  /**
   * Fetch the bot's own open_id. Returns success/failure; on failure the
   * caller must treat the group mention filter as degraded and drop group
   * messages (never answer everything).
   */
  async fetchBotOpenId(): Promise<boolean> {
    try {
      const token = await this.getTenantToken();
      const response = await fetch(new URL('/open-apis/im/v1/bots/info', this.options.domain), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as {
        code: number;
        bot?: { open_id?: string; activate_status?: number };
      };
      if (body.code !== 0 || !body.bot?.open_id) {
        throw new Error(`bots/info code=${body.code}`);
      }
      this.botOpenId = body.bot.open_id;
      return true;
    } catch (error) {
      log.warn('line: fetch bot open_id failed (group filter degraded)', { error: String(error) });
      return false;
    }
  }

  /** True once the bot identity is known — the group filter is active. */
  get groupFilterActive(): boolean {
    return this.botOpenId !== undefined;
  }

  private async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expireAt) {
      return this.cachedToken.token;
    }
    const response = await fetch(
      new URL('/open-apis/auth/v3/tenant_access_token/internal', this.options.domain),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await response.json()) as TokenResponse;
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`tenant_access_token code=${body.code} msg=${body.msg ?? ''}`);
    }
    const ttlMs = Math.max((body.expire ?? 7200) - 300, 60) * 1000;
    this.cachedToken = { token: body.tenant_access_token, expireAt: now + ttlMs };
    return body.tenant_access_token;
  }
}

// ─── Event normalization ──────────────────────────────────────────────────

interface RawReceiveEvent {
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: { text?: string } | string; id?: { open_id?: string }; name?: string }>;
    create_time?: string;
    root_id?: string;
    parent_id?: string;
  };
  sender?: { sender_id?: { open_id?: string; user_id?: string; union_id?: string } };
}

/** Map the raw `im.message.receive_v1` payload to our normalized event. */
export function normalizeReceiveEvent(data: unknown): FeishuEventMessage | undefined {
  const raw = data as RawReceiveEvent;
  const msg = raw?.message;
  if (!msg?.message_id) return undefined;
  const mentions: FeishuMention[] = (msg.mentions ?? []).map((m) => {
    const key = typeof m.key === 'string' ? m.key : (m.key?.text ?? '');
    return { key, openId: m.id?.open_id, name: m.name };
  });
  const createTimeMs = msg.create_time ? Number.parseInt(msg.create_time, 10) || 0 : 0;
  return {
    messageId: msg.message_id,
    chatId: msg.chat_id ?? '',
    chatType: msg.chat_type ?? '',
    msgType: msg.message_type ?? '',
    content: msg.content ?? '',
    mentions,
    createTimeMs,
    rootId: msg.root_id,
    parentId: msg.parent_id,
    senderUserId:
      raw?.sender?.sender_id?.open_id ?? raw?.sender?.sender_id?.user_id ?? raw?.sender?.sender_id?.union_id ?? '',
  };
}

/** Lark international base URL (mirror of the reference's Domain.Lark). */
export const LARK_INTERNATIONAL_DOMAIN = 'https://open.larksuite.com';
