import { describe, expect, it, vi } from 'vitest';

import {
  WeixinApiError,
  WeixinClient,
  isSendThrottled,
  validateWeixinToken,
} from '#/line/weixin/client';
import { DEFAULT_WEIXIN_BASE_URL, type WeixinRuntimeOptions } from '#/line/config';

function baseOptions(overrides: Partial<WeixinRuntimeOptions> = {}): WeixinRuntimeOptions {
  return {
    token: 'tok',
    baseUrl: DEFAULT_WEIXIN_BASE_URL,
    allowFrom: [],
    routeTag: '',
    longPollTimeoutMs: 1000,
    dedupWindowMs: 300_000,
    ...overrides,
  };
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fetch mock returning a JSON envelope; captures requests for header asserts. */
function fetchMock(respond: (body: unknown) => unknown): { calls: CapturedRequest[]; fetch: typeof fetch } {
  const calls: CapturedRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown;
    calls.push({ url, headers, body });
    return new Response(JSON.stringify(respond(body)), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

describe('WeixinClient wire format', () => {
  it('sends ilink headers and the long-poll body shape', async () => {
    const { calls, fetch } = fetchMock(() => ({ ret: 0, errcode: 0, msgs: [], get_updates_buf: 'next' }));
    const client = new WeixinClient(baseOptions({ routeTag: 'rt1' }), { fetchImpl: fetch });
    const resp = await client.getUpdates('cur1');
    expect(resp.get_updates_buf).toBe('next');
    const call = calls[0];
    expect(call?.url).toBe(`${DEFAULT_WEIXIN_BASE_URL}/ilink/bot/getupdates`);
    expect(call?.headers['AuthorizationType']).toBe('ilink_bot_token');
    expect(call?.headers['Authorization']).toBe('Bearer tok');
    expect(call?.headers['SKRouteTag']).toBe('rt1');
    expect(call?.headers['X-WECHAT-UIN']).toBeTruthy();
    expect((call?.body as { get_updates_buf?: string }).get_updates_buf).toBe('cur1');
    expect((call?.body as { base_info?: { channel_version?: string } }).base_info?.channel_version).toContain(
      'scream-line-weixin',
    );
  });

  it('treats a poll timeout as an empty batch with the unchanged cursor', async () => {
    const timeoutFetch = (async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const client = new WeixinClient(baseOptions(), { fetchImpl: timeoutFetch });
    const resp = await client.getUpdates('keep');
    expect(resp.ret).toBe(0);
    expect(resp.msgs).toEqual([]);
    expect(resp.get_updates_buf).toBe('keep');
  });

  it('surfaces network failures as errors for the poll backoff', async () => {
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = new WeixinClient(baseOptions(), { fetchImpl: failing });
    await expect(client.getUpdates('')).rejects.toThrow('ECONNRESET');
  });

  it('sends bot messages with message_type=2/state=2 and a context token', async () => {
    const { calls, fetch } = fetchMock(() => ({ ret: 0, errcode: 0 }));
    const client = new WeixinClient(baseOptions(), { fetchImpl: fetch });
    await client.sendText('user@im.wechat', 'hello', 'ctx_tok', 'line-abc');
    const call = calls[0];
    expect(call?.url).toContain('/ilink/bot/sendmessage');
    const msg = (call?.body as { msg?: Record<string, unknown> }).msg;
    expect(msg?.['message_type']).toBe(2);
    expect(msg?.['message_state']).toBe(2);
    expect(msg?.['from_user_id']).toBe('');
    expect(msg?.['to_user_id']).toBe('user@im.wechat');
    expect(msg?.['context_token']).toBe('ctx_tok');
    const items = msg?.['item_list'] as Array<{ type: number; text_item?: { text?: string } }>;
    expect(items[0]?.type).toBe(1);
    expect(items[0]?.text_item?.text).toBe('hello');
  });

  it('rejects sends without a context token or with empty text', async () => {
    const client = new WeixinClient(baseOptions());
    await expect(client.sendText('u', 'hi', '  ', 'id')).rejects.toThrow('context_token');
    await expect(client.sendText('u', '  ', 'ctx', 'id')).rejects.toThrow('empty item_list');
  });

  it('throws a typed error when the envelope reports ret!==0', async () => {
    const { fetch } = fetchMock(() => ({ ret: -2, errcode: 0, errmsg: 'prepare failed' }));
    const client = new WeixinClient(baseOptions(), { fetchImpl: fetch });
    const caught = await client.sendText('u', 'hi', 'ctx', 'id').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(WeixinApiError);
    expect((caught as WeixinApiError).ret).toBe(-2);
    expect(isSendThrottled(caught)).toBe(true);
  });

  it('treats a response WITHOUT ret/errcode as success (Go zero-value parity)', async () => {
    // Regression: the real gateway omits `ret` on sendmessage success —
    // Go's json.Unmarshal fills missing fields with 0 (success); the port
    // must not treat undefined as failure.
    const { fetch } = fetchMock(() => ({}));
    const client = new WeixinClient(baseOptions(), { fetchImpl: fetch });
    await expect(client.sendText('u', 'hi', 'ctx', 'id')).resolves.toBeUndefined();
  });

  it('getConfig succeeds when ret/errcode are omitted (zero-value parity)', async () => {
    const { fetch } = fetchMock(() => ({ typing_ticket: 'tk1' }));
    const client = new WeixinClient(baseOptions(), { fetchImpl: fetch });
    await expect(client.getConfig('u', 'ctx')).resolves.toBe('tk1');
  });

  it('validateWeixinToken accepts a response without ret (session expired)', async () => {
    const { fetch } = fetchMock(() => ({ errcode: -14, errmsg: 'session expired' }));
    const check = await validateWeixinToken(baseOptions(), { fetchImpl: fetch });
    expect(check).toEqual({ valid: true, sessionExpired: true });
  });
});

describe('validateWeixinToken (wizard probe)', () => {
  it('accepts ret=0 as valid', async () => {
    const { fetch } = fetchMock(() => ({ ret: 0, errcode: 0, msgs: [], get_updates_buf: 'b' }));
    const check = await validateWeixinToken(baseOptions(), { fetchImpl: fetch });
    expect(check).toEqual({ valid: true, sessionExpired: false });
  });

  it('treats errcode -14 as valid-but-session-expired', async () => {
    const { fetch } = fetchMock(() => ({ ret: 0, errcode: -14, errmsg: 'session expired' }));
    const check = await validateWeixinToken(baseOptions(), { fetchImpl: fetch });
    expect(check).toEqual({ valid: true, sessionExpired: true });
  });

  it('rejects other envelope failures with the code in the message', async () => {
    const { fetch } = fetchMock(() => ({ ret: 7, errcode: 9, errmsg: 'bad token' }));
    await expect(validateWeixinToken(baseOptions(), { fetchImpl: fetch })).rejects.toThrow('bad token');
  });

  it('maps HTTP 401/403 rejections to an explicit invalid-token error', async () => {
    const impl = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    await expect(validateWeixinToken(baseOptions(), { fetchImpl: impl })).rejects.toThrow('token 无效');
  });
});

describe('sendText client id helper', () => {
  it('generates line-prefixed client ids', () => {
    const client = new WeixinClient(baseOptions());
    expect(client.newClientId()).toMatch(/^line-[0-9a-f]{12}$/);
  });
});
