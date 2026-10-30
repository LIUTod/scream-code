import { describe, expect, it, vi } from 'vitest';

import { UPLOAD_MEDIA_TYPE, WeixinClient } from '#/line/weixin/client';
import type { WeixinRuntimeOptions } from '#/line/config';

/**
 * Outbound media is a three-step handshake: `getuploadurl` → CDN POST (with the
 * AES-encrypted body) → `x-encrypted-param`. These tests pin the handshake and
 * the `upload_full_url`/`upload_param` duality the gateway still ships.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): WeixinClient {
  return new WeixinClient(
    {
      token: 'token',
      baseUrl: 'https://ilink.example',
      allowFrom: [],
      routeTag: 'rt',
      longPollTimeoutMs: 1,
      dedupWindowMs: 1,
    } as unknown as WeixinRuntimeOptions,
    { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
}

describe('WeixinClient.uploadMedia', () => {
  it('uploads the encrypted body and returns the CDN download param', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = makeClient(async (url, init) => {
      calls.push({ url, init });
      if (url.includes('getuploadurl')) {
        return jsonResponse({ ret: 0, upload_param: 'up-param' });
      }
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-param' } });
    });

    const data = Buffer.from('image-bytes');
    const ref = await client.uploadMedia({
      toUserId: 'peer',
      data,
      mediaType: UPLOAD_MEDIA_TYPE.image,
      cdnBaseUrl: 'https://cdn.example/c2c',
    });

    expect(ref.downloadParam).toBe('dl-param');
    expect(ref.rawSize).toBe(data.length);
    // Ciphertext is block-aligned and not the plaintext.
    expect(ref.cipherSize % 16).toBe(0);
    expect(ref.aesKey.length).toBe(16);

    const upload = calls.find((call) => call.url.includes('/upload'));
    expect(upload?.url).toContain('/upload?encrypted_query_param=up-param&filekey=');
    const body = upload?.init?.body as Uint8Array | undefined;
    expect(body?.byteLength).toBe(ref.cipherSize);
  });

  it('prefers upload_full_url when the gateway provides one', async () => {
    const urls: string[] = [];
    const client = makeClient(async (url) => {
      urls.push(url);
      if (url.includes('getuploadurl')) {
        return jsonResponse({ ret: 0, upload_full_url: 'https://cdn.example/full?k=1' });
      }
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl' } });
    });

    await client.uploadMedia({
      toUserId: 'peer',
      data: Buffer.from('x'),
      mediaType: UPLOAD_MEDIA_TYPE.file,
      cdnBaseUrl: 'https://cdn.example/c2c',
    });
    expect(urls.some((url) => url === 'https://cdn.example/full?k=1')).toBe(true);
  });

  it('retries a 5xx upload and surfaces a 4xx rejection verbatim', async () => {
    let attempts = 0;
    const retrying = makeClient(async (url) => {
      if (url.includes('getuploadurl')) return jsonResponse({ ret: 0, upload_param: 'p' });
      attempts += 1;
      if (attempts < 3) return new Response('', { status: 503 });
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl' } });
    });
    const ref = await retrying.uploadMedia({
      toUserId: 'peer',
      data: Buffer.from('x'),
      mediaType: UPLOAD_MEDIA_TYPE.image,
      cdnBaseUrl: 'https://cdn.example/c2c',
    });
    expect(attempts).toBe(3);
    expect(ref.downloadParam).toBe('dl');

    const rejected = makeClient(async (url) => {
      if (url.includes('getuploadurl')) return jsonResponse({ ret: 0, upload_param: 'p' });
      return new Response('', { status: 403, headers: { 'x-error-message': 'no quota' } });
    });
    await expect(
      rejected.uploadMedia({
        toUserId: 'peer',
        data: Buffer.from('x'),
        mediaType: UPLOAD_MEDIA_TYPE.image,
        cdnBaseUrl: 'https://cdn.example/c2c',
      }),
    ).rejects.toThrow(/no quota/);
  });

  it('fails when getuploadurl returns a non-zero ret', async () => {
    const client = makeClient(async () => jsonResponse({ ret: -2, errmsg: 'throttled' }));
    await expect(
      client.uploadMedia({
        toUserId: 'peer',
        data: Buffer.from('x'),
        mediaType: UPLOAD_MEDIA_TYPE.image,
        cdnBaseUrl: 'https://cdn.example/c2c',
      }),
    ).rejects.toThrow(/ret=-2/);
  });
});
