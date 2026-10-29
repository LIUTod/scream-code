/**
 * ilink bot HTTP client for the weixin channel — WeChat's official bot
 * gateway (long-poll `getupdates` + `sendmessage`), the official messaging
 * bot open interface. Wire format follows the reference implementation
 * (types/client).
 *
 * Wire details preserved from the Go client:
 *   - headers: AuthorizationType=ilink_bot_token, Bearer token, X-WECHAT-UIN
 *     (random base64 uint32), optional SKRouteTag
 *   - long-poll timeout gets a +5s HTTP buffer; a poll timeout is an EMPTY
 *     result carrying the same cursor, not an error
 *   - envelope {ret, errcode, errmsg}; ret=-2 on send is the ilink burst
 *     throttle and must fail fast (retrying escalates the penalty)
 */

import { log } from '@scream-code/scream-code-sdk';

import type { WeixinRuntimeOptions } from '../config';

export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;
export const MESSAGE_STATE_FINISH = 2;
export const SESSION_EXPIRED_ERRCODE = -14;
export const TYPING_STATUS_START = 1;
export const TYPING_STATUS_STOP = 2;

const CHANNEL_VERSION = 'scream-line-weixin/1.0';
const API_TIMEOUT_MS = 15_000;
const LONG_POLL_HTTP_BUFFER_MS = 5_000;

export interface IlinkMessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  ref_msg?: {
    title?: string;
    message_item?: IlinkMessageItem;
  };
}

export interface IlinkMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: IlinkMessageItem[];
  context_token?: string;
}

export interface IlinkGetUpdatesResponse {
  ret: number;
  errcode: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
}

interface IlinkEnvelope {
  ret: number;
  errcode: number;
  errmsg?: string;
}

interface GetConfigResponse extends IlinkEnvelope {
  typing_ticket?: string;
}

export class WeixinApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'ret' | 'network',
    readonly ret?: number,
    readonly errcode?: number,
  ) {
    super(message);
    this.name = 'WeixinApiError';
  }
}

/** True for ilink's burst throttle on sendmessage (ret=-2 "prepare failed"). */
export function isSendThrottled(error: unknown): boolean {
  return error instanceof WeixinApiError && error.ret === -2;
}

function randomWechatUin(): string {
  const value = Math.trunc(Math.random() * 0x1_0000_0000);
  return Buffer.from(String(value), 'utf-8').toString('base64');
}

function randomHex(n: number): string {
  let out = '';
  while (out.length < n * 2) {
    out += Math.floor(Math.random() * 0x1_0000).toString(16).padStart(4, '0');
  }
  return out.slice(0, n * 2);
}

export class WeixinClient {
  constructor(
    readonly options: WeixinRuntimeOptions,
    private readonly deps: {
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
    };
    if (this.options.token !== '') {
      headers['Authorization'] = `Bearer ${this.options.token}`;
    }
    if (this.options.routeTag !== '') {
      headers['SKRouteTag'] = this.options.routeTag;
    }
    return headers;
  }

  private async post(endpoint: string, body: unknown, timeoutMs: number, label: string): Promise<unknown> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\//, '')}`;
    const payload = JSON.stringify(body);
    let response: Response;
    try {
      const doFetch = this.deps.fetchImpl ?? fetch;
      response = await doFetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
        throw new WeixinApiError(`weixin: ${label}: timeout`, 'network');
      }
      throw new WeixinApiError(`weixin: ${label}: ${String(error)}`, 'network');
    }
    if (response.status !== 200) {
      const preview = (await response.text().catch(() => '')).slice(0, 512);
      throw new WeixinApiError(`weixin: ${label}: http ${response.status}: ${preview}`, 'http');
    }
    const raw = await response.text();
    if (raw.trim() === '') return { ret: 0, errcode: 0 };
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new WeixinApiError(`weixin: ${label}: invalid JSON response`, 'http');
    }
  }

  /**
   * One long-poll round. A poll timeout is NOT an error — it returns an
   * empty batch with the unchanged cursor (the reference getUpdates).
   */
  async getUpdates(cursor: string): Promise<IlinkGetUpdatesResponse> {
    const timeoutMs = this.options.longPollTimeoutMs + LONG_POLL_HTTP_BUFFER_MS;
    try {
      const body = await this.post(
        'ilink/bot/getupdates',
        { get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION } },
        timeoutMs,
        'getUpdates',
      );
      return body as IlinkGetUpdatesResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('timeout')) {
        return { ret: 0, errcode: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  /** Send one text message; rejects on ret!==0 (including the -2 throttle). */
  async sendText(toUserId: string, text: string, contextToken: string, clientId: string): Promise<void> {
    if (contextToken.trim() === '') {
      throw new WeixinApiError('weixin: context_token is required for send', 'ret');
    }
    if (text.trim() === '') {
      throw new WeixinApiError('weixin: sendText: empty item_list', 'ret');
    }
    const body = await this.post(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
      API_TIMEOUT_MS,
      'sendMessage',
    );
    const env = body as IlinkEnvelope;
    // Go-parity zero-value semantics: the gateway may omit `ret`/`errcode`
    // on success (Go's json.Unmarshal fills them with 0). Missing = 0 = ok.
    if ((env.ret ?? 0) !== 0) {
      throw new WeixinApiError(
        `weixin: sendMessage: ret=${env.ret} errcode=${env.errcode} errmsg=${env.errmsg ?? ''}`,
        'ret',
        env.ret,
        env.errcode,
      );
    }
  }

  async getConfig(userId: string, contextToken: string): Promise<string> {
    const body = await this.post(
      'ilink/bot/getconfig',
      { ilink_user_id: userId, context_token: contextToken, base_info: { channel_version: CHANNEL_VERSION } },
      API_TIMEOUT_MS,
      'getConfig',
    );
    const env = body as GetConfigResponse;
    if ((env.ret ?? 0) !== 0 || (env.errcode ?? 0) !== 0) {
      throw new WeixinApiError(
        `weixin: getConfig ret=${env.ret} errcode=${env.errcode} errmsg=${env.errmsg ?? ''}`,
        'ret',
        env.ret,
        env.errcode,
      );
    }
    return (env.typing_ticket ?? '').trim();
  }

  async sendTyping(userId: string, ticket: string, status: number): Promise<void> {
    await this.post(
      'ilink/bot/sendtyping',
      {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      API_TIMEOUT_MS,
      'sendTyping',
    );
  }

  /** New outbound client message id (`line-<hex>`), mirrors the reference's prefix. */
  newClientId(): string {
    return `line-${randomHex(6)}`;
  }
}

// ─── Credential validation (wizard) ───────────────────────────────────────

export interface WeixinTokenCheck {
  /** Token accepted by the gateway. */
  valid: boolean;
  /** errcode -14: token valid but the session needs a fresh user message. */
  sessionExpired: boolean;
}

/**
 * Probe the gateway with one short getUpdates round. There is no dedicated
 * auth endpoint — the reference treats the first successful getUpdates as the
 * authoritative ready signal.
 */
export async function validateWeixinToken(
  options: WeixinRuntimeOptions,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<WeixinTokenCheck> {
  const client = new WeixinClient({ ...options, longPollTimeoutMs: 5_000 }, deps);
  let response: IlinkGetUpdatesResponse;
  try {
    response = await client.getUpdates('');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/http (401|403)/.test(message)) {
      throw new WeixinApiError('token 无效或无权限（网关拒绝）', 'http');
    }
    throw new WeixinApiError(`网络错误，无法连接 ilink 网关：${message}`, 'network');
  }
  if ((response.ret ?? 0) === 0) {
    return { valid: true, sessionExpired: (response.errcode ?? 0) === SESSION_EXPIRED_ERRCODE };
  }
  if (response.errcode === SESSION_EXPIRED_ERRCODE) {
    return { valid: true, sessionExpired: true };
  }
  throw new WeixinApiError(
    `token 校验失败（ret=${response.ret}，errcode=${response.errcode}，msg=${response.errmsg ?? ''}）`,
    'ret',
    response.ret,
    response.errcode,
  );
}

export function logWeixinDebug(context: Record<string, unknown>): void {
  log.debug('line-weixin', context);
}
