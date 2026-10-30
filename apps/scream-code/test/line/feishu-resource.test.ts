import { describe, expect, it, vi } from 'vitest';

import { FeishuClient, parseContentRangeTotal } from '#/line/feishu/client';
import type { FeishuRuntimeOptions } from '#/line/config';

/**
 * The Range-chunked download exists because Feishu truncates a plain
 * `messageResource.get` at ~2 MiB — smaller than a full-screen PNG. These tests
 * pin the three response shapes that path must survive.
 */

interface RangeCall {
  range: string | undefined;
}

function makeClient(body: Buffer, respond: (call: RangeCall) => unknown): {
  client: FeishuClient;
  calls: RangeCall[];
} {
  const calls: RangeCall[] = [];
  const instance = new FeishuClient({
    appId: 'app',
    appSecret: 'secret',
  } as unknown as FeishuRuntimeOptions);
  (instance as unknown as { client: unknown }).client = {
    request: vi.fn(async (opts: { headers?: Record<string, string> }) => {
      const range = opts.headers?.['Range'];
      calls.push({ range });
      return respond({ range });
    }),
  };
  return { client: instance, calls };
}

describe('parseContentRangeTotal', () => {
  it('reads the total from a Content-Range header', () => {
    expect(parseContentRangeTotal('bytes 0-0/3420000')).toBe(3_420_000);
    expect(parseContentRangeTotal('bytes 8388608-16777215/20000000')).toBe(20_000_000);
  });

  it('returns null when the header is absent or malformed', () => {
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
    expect(parseContentRangeTotal('bytes 0-0')).toBeNull();
    expect(parseContentRangeTotal('bytes 0-0/*')).toBeNull();
  });
});

describe('FeishuClient.downloadResource', () => {
  it('returns the whole body when the server ignores Range (no content-range)', async () => {
    const body = Buffer.alloc(2048, 1);
    const { client, calls } = makeClient(body, () => ({ data: body, headers: {} }));

    const result = await client.downloadResource('om_1', 'img_key', 'image');
    expect(result.equals(body)).toBe(true);
    // Exactly one request: a header-less response already carries everything.
    expect(calls).toHaveLength(1);
  });

  it('falls back to a plain GET when the server rejects Range outright', async () => {
    const body = Buffer.alloc(512, 2);
    let attempt = 0;
    const { client } = makeClient(body, () => {
      attempt += 1;
      if (attempt === 1) throw new Error('400 range rejected');
      return { data: body, headers: {} };
    });

    const result = await client.downloadResource('om_fallback', 'k', 'file');
    expect(result.equals(body)).toBe(true);
    expect(attempt).toBe(2);
  });

  it('reassembles a chunked response and preserves byte order', async () => {
    // 8 MiB + 10 bytes forces a second chunk with the real chunk size.
    const total = 8 * 1024 * 1024 + 10;
    const body = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) body[i] = i % 251;

    const { client, calls } = makeClient(body, ({ range }) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (match === null) throw new Error(`unexpected range: ${range ?? 'none'}`);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return {
        headers: { 'content-range': `bytes ${start}-${end}/${total}` },
        data: body.subarray(start, end + 1),
      };
    });

    const result = await client.downloadResource('om_2', 'file_key', 'file');
    expect(result.length).toBe(total);
    expect(result.equals(body)).toBe(true);
    expect(calls).toHaveLength(3); // probe + two data chunks
    expect(calls[0]?.range).toBe('bytes=0-0');
    expect(calls[1]?.range).toBe(`bytes=1-${8 * 1024 * 1024}`);
  });

  it('asks the SDK for headers explicitly (otherwise the body is unwrapped)', async () => {
    const body = Buffer.from('x');
    const { client } = makeClient(body, () => ({ data: body, headers: {} }));
    const seen: Array<Record<string, unknown>> = [];
    (client as unknown as { client: { request: unknown } }).client = {
      request: vi.fn(async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return { data: body, headers: {} };
      }),
    };
    await client.downloadImage('om_5', 'k');
    expect(seen[0]?.['$return_headers']).toBe(true);
    expect(seen[0]?.['responseType']).toBe('arraybuffer');
  });

  it('fails instead of returning a truncated file when a chunk is short', async () => {
    const total = 100;
    const { client } = makeClient(Buffer.alloc(total), ({ range }) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      const start = Number(match?.[1] ?? 0);
      const end = Number(match?.[2] ?? 0);
      return {
        headers: { 'content-range': `bytes ${start}-${end}/${total}` },
        // Deliberately short: the whole point of the size check.
        data: Buffer.alloc(Math.max(1, end - start)),
      };
    });
    await expect(client.downloadResource('om_4', 'k', 'image')).rejects.toThrow(
      /short read|size mismatch/,
    );
  });

  it('refuses resources above the cap before reading them', async () => {
    const { client, calls } = makeClient(Buffer.alloc(1), () => ({
      headers: { 'content-range': `bytes 0-0/${600 * 1024 * 1024}` },
      data: Buffer.alloc(1),
    }));
    await expect(client.downloadResource('om_6', 'k', 'file')).rejects.toThrow(/too large/);
    expect(calls).toHaveLength(1);
  });

  it('wraps the image endpoint with type=image', async () => {
    const body = Buffer.from('png');
    const urls: string[] = [];
    const { client } = makeClient(body, () => ({ data: body, headers: {} }));
    (client as unknown as { client: { request: unknown } }).client = {
      request: vi.fn(async (opts: { url: string }) => {
        urls.push(opts.url);
        return { data: body, headers: {} };
      }),
    };
    await client.downloadImage('om_7', 'img_key');
    expect(urls[0]).toBe('/open-apis/im/v1/messages/om_7/resources/img_key?type=image');
  });
});
