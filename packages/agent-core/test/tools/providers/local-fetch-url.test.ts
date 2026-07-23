/**
 * Covers: LocalFetchURLProvider content-kind reporting.
 *
 * Verifies the provider tells callers whether the returned content is a
 * verbatim passthrough of the response body or the main text extracted
 * from an HTML page.
 */

import { describe, expect, it, vi } from 'vitest';
import { FetchCache } from '../../../src/tools/providers/fetch-cache';
import { LocalFetchURLProvider } from '../../../src/tools/providers/local-fetch-url';

const fakeDnsLookup = vi.fn().mockResolvedValue(['93.184.216.34']);

function htmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('LocalFetchURLProvider content kind', () => {
  it('reports text/plain bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('plain body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup: fakeDnsLookup });

    const result = await provider.fetch('https://example.com/file.txt');

    expect(result).toEqual({ content: 'plain body', kind: 'passthrough' });
  });

  it('reports text/markdown bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('# Title\n\nbody', 'text/markdown'));
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup: fakeDnsLookup });

    const result = await provider.fetch('https://example.com/readme.md');

    expect(result).toEqual({ content: '# Title\n\nbody', kind: 'passthrough' });
  });

  it('reports HTML bodies as extracted main content', async () => {
    const html =
      '<html><head><title>Doc</title></head><body><article>' +
      '<p>The quick brown fox jumps over the lazy dog. '.repeat(20) +
      '</p></article></body></html>';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse(html, 'text/html; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup: fakeDnsLookup });

    const result = await provider.fetch('https://example.com/page');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('quick brown fox');
  });

  it('returns a cached result on the second fetch', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('fresh', 'text/plain; charset=utf-8'));
    const cache = new FetchCache();
    const provider = new LocalFetchURLProvider({ fetchImpl, cache, dnsLookup: fakeDnsLookup });

    const first = await provider.fetch('https://example.com/file.txt');
    const second = await provider.fetch('https://example.com/file.txt');

    expect(first).toEqual({ content: 'fresh', kind: 'passthrough' });
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not share cache across different URLs', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(htmlResponse('a', 'text/plain; charset=utf-8'))
      .mockResolvedValueOnce(htmlResponse('b', 'text/plain; charset=utf-8'));
    const cache = new FetchCache();
    const provider = new LocalFetchURLProvider({ fetchImpl, cache, dnsLookup: fakeDnsLookup });

    await provider.fetch('https://example.com/a');
    await provider.fetch('https://example.com/b');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('LocalFetchURLProvider redirect safety', () => {
  it('follows relative public redirects manually and revalidates every target', async () => {
    const dnsLookup = vi.fn().mockResolvedValue(['93.184.216.34']);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('redirect', { status: 302, headers: { location: '/next' } }),
      )
      .mockResolvedValueOnce(htmlResponse('done', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup });

    await expect(provider.fetch('https://example.com/start')).resolves.toEqual({
      content: 'done',
      kind: 'passthrough',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://example.com/start',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://example.com/next',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(dnsLookup).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['loopback host', 'http://localhost/admin'],
    ['private IP', 'http://192.168.1.5/admin'],
    ['non-http scheme', 'file:///etc/passwd'],
  ])('blocks a redirect to a %s before issuing the next request', async (_label, location) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup: fakeDnsLookup });

    await expect(provider.fetch('https://example.com/start')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect whose hostname resolves to a private address', async () => {
    const dnsLookup = vi.fn(async (hostname: string) =>
      hostname === 'internal.example' ? ['10.0.0.2'] : ['93.184.216.34'],
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://internal.example/secret' },
        }),
      );
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup });

    await expect(provider.fetch('https://example.com/start')).rejects.toThrow(
      'resolves to private address 10.0.0.2',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a redirect has no Location header', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302 }));
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup: fakeDnsLookup });

    await expect(provider.fetch('https://example.com/start')).rejects.toThrow(
      'missing a Location header',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops before issuing a request beyond the redirect limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const current = new URL(String(input));
      const step = Number(current.searchParams.get('step') ?? '0');
      return new Response(null, {
        status: 302,
        headers: { location: `/?step=${String(step + 1)}` },
      });
    });
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup: fakeDnsLookup });

    await expect(provider.fetch('https://example.com/?step=0')).rejects.toThrow(
      'Too many redirects (maximum 5)',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('cancels each redirect response body before following the next target', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const redirectResponse = {
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: '/next' }),
      body: { cancel },
    } as unknown as Response;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(htmlResponse('done', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl, dnsLookup: fakeDnsLookup });

    await provider.fetch('https://example.com/start');

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
