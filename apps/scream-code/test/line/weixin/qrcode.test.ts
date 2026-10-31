import { describe, expect, it, vi } from 'vitest';

import {
  WeixinLoginError,
  beginWeixinQRLogin,
  pollWeixinQRStatus,
} from '#/line/weixin/qrcode';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe('beginWeixinQRLogin (official ilink gateway)', () => {
  it('requests bot_type=3 and returns the QR key + login url', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return jsonResponse({ qrcode: 'qr_key_1', qrcode_img_content: ' https://login.example/wx?id=abc ' });
    }) as unknown as typeof fetch;
    const begin = await beginWeixinQRLogin({}, fetchImpl);
    expect(begin).toEqual({ qrKey: 'qr_key_1', qrUrl: 'https://login.example/wx?id=abc' });
    expect(calls[0]).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
  });

  it('honors a custom base url without trailing slash duplication', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return jsonResponse({ qrcode: 'k', qrcode_img_content: 'https://x' });
    }) as unknown as typeof fetch;
    await beginWeixinQRLogin({ baseUrl: 'https://gw.cn///' }, fetchImpl);
    expect(calls[0]).toBe('https://gw.cn/ilink/bot/get_bot_qrcode?bot_type=3');
  });

  it('throws typed errors on HTTP failure and empty QR content', async () => {
    const httpFail = (async () => new Response('oops', { status: 502 })) as unknown as typeof fetch;
    await expect(beginWeixinQRLogin({}, httpFail)).rejects.toBeInstanceOf(WeixinLoginError);
    await expect(beginWeixinQRLogin({}, httpFail)).rejects.toThrow('502');
    const empty = (async () => jsonResponse({ qrcode: 'k', qrcode_img_content: '' })) as unknown as typeof fetch;
    await expect(beginWeixinQRLogin({}, empty)).rejects.toThrow('二维码');
  });
});

describe('pollWeixinQRStatus (long-poll behaviour)', () => {
  it('sends the client-version header and resolves wait for status=wait', async () => {
    const initCalls: Array<RequestInit | undefined> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      initCalls.push(init);
      return jsonResponse({ status: 'wait' });
    }) as unknown as typeof fetch;
    const poll = await pollWeixinQRStatus({}, 'qr_key_1', fetchImpl);
    expect(poll).toEqual({ status: 'wait' });
    const headers = (initCalls[0]?.headers ?? {}) as Record<string, string>;
    expect(headers['iLink-App-ClientVersion']).toBe('1');
  });

  it('resolves the token bundle on confirmed', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        status: 'confirmed',
        bot_token: ' tok123 ',
        ilink_user_id: ' me@im.wechat ',
        ilink_bot_id: 'bot1',
        baseurl: 'https://gw.cn',
      })) as unknown as typeof fetch;
    const poll = await pollWeixinQRStatus({}, 'k', fetchImpl);
    expect(poll).toEqual({
      status: 'confirmed',
      botToken: 'tok123',
      ilinkUserId: 'me@im.wechat',
      ilinkBotId: 'bot1',
      baseUrl: 'https://gw.cn',
    });
  });

  it('treats mid-poll network errors as wait (keep waiting)', async () => {
    const flaky = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(jsonResponse({ status: 'wait' }));
    const poll = await pollWeixinQRStatus({}, 'k', flaky as unknown as typeof fetch);
    expect(poll.status).toBe('wait');
  });

  it('throws on unexpected statuses and on confirmation without a token', async () => {
    const expired = (async () => jsonResponse({ status: 'expired' })) as unknown as typeof fetch;
    await expect(pollWeixinQRStatus({}, 'k', expired)).rejects.toThrow('expired');
    const noToken = (async () => jsonResponse({ status: 'confirmed' })) as unknown as typeof fetch;
    await expect(pollWeixinQRStatus({}, 'k', noToken)).rejects.toThrow('token');
  });
});
