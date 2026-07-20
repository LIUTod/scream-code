/**
 * Covers: DuckDuckGoSearchProvider, FallbackSearchProvider.
 *
 * Tests the providers directly using mocked fetch implementations so no
 * real network calls are made.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WebSearchProvider, WebSearchResult } from '../../src/tools/builtin/web/web-search';
import { DuckDuckGoSearchProvider } from '../../src/tools/providers/duckduckgo-search';
import { FallbackSearchProvider } from '../../src/tools/providers/fallback-search';

// ── Helpers ──────────────────────────────────────────────────────────────

function ddgHtmlResult(title: string, url: string, snippet?: string): string {
  return `
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title">
        <a class="result__a" href="${url}">${title}</a>
      </h2>
      ${snippet !== undefined ? `<a class="result__snippet">${snippet}</a>` : ''}
    </div>`;
}

// ── DuckDuckGoSearchProvider ─────────────────────────────────────────────

describe('DuckDuckGoSearchProvider', () => {
  it('implements WebSearchProvider', () => {
    const provider = new DuckDuckGoSearchProvider();
    expect(provider).toBeDefined();
    expect(provider.name).toBe('duckduckgo');
    expect(typeof provider.search).toBe('function');
  });

  it('POSTs the query to the html endpoint with a browser User-Agent', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html></html>', { status: 200 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });
    await p.search('hello world');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://html.duckduckgo.com/html/');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('q=hello+world');
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
    expect(init.signal).toBeDefined();
  });

  it('parses result blocks with titles, urls, and snippets', async () => {
    const html = `<html><body>
      ${ddgHtmlResult('Page One', 'https://example.com/one', 'Snippet one.')}
      ${ddgHtmlResult('Page Two', 'https://example.com/two', 'Snippet two.')}
    </body></html>`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });
    const results = await p.search('test');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: 'Page One', url: 'https://example.com/one', snippet: 'Snippet one.' });
    expect(results[1]?.url).toBe('https://example.com/two');
  });

  it('unwraps DDG redirect URLs to the real target', async () => {
    const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent('https://real.example/page?a=1&b=2')}&rut=abc`;
    const html = `<html><body>${ddgHtmlResult('Real', wrapped)}</body></html>`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });
    const results = await p.search('test');

    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://real.example/page?a=1&b=2');
  });

  it('decodes HTML entities and strips bold markers in titles', async () => {
    const html = `<html><body>
      ${ddgHtmlResult('<b>Tom &amp; Jerry</b> &#8211; guide', 'https://example.com/tj')}
    </body></html>`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });
    const results = await p.search('test');

    expect(results[0]?.title).toBe('Tom & Jerry – guide');
    // Snippet falls back to the title when the block has no snippet element.
    expect(results[0]?.snippet).toBe('Tom & Jerry – guide');
  });

  it('respects the limit option', async () => {
    const blocks = Array.from({ length: 8 }, (_, i) => ddgHtmlResult(`P${String(i)}`, `https://example.com/${String(i)}`)).join('');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`<html>${blocks}</html>`, { status: 200 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });
    const results = await p.search('test', { limit: 3 });

    expect(results).toHaveLength(3);
  });

  it('deduplicates repeated URLs', async () => {
    const html = `<html><body>
      ${ddgHtmlResult('One', 'https://example.com/dup')}
      ${ddgHtmlResult('Two', 'https://example.com/dup')}
    </body></html>`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });
    const results = await p.search('test');

    expect(results).toHaveLength(1);
  });

  it('returns an empty array when the page parses but has no results', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html><body>No results</body></html>', { status: 200 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });
    const results = await p.search('test');

    expect(results).toEqual([]);
  });

  it('throws on HTTP errors so the fallback chain records the failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('server error', { status: 500 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });

    await expect(p.search('test')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on bot-detection pages (anomaly modal)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html><body><div class="anomaly-modal__mask"></div></body></html>', { status: 202 }));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });

    await expect(p.search('test')).rejects.toThrow(/bot-detection/);
  });

  it('propagates network errors instead of swallowing them', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    const p = new DuckDuckGoSearchProvider({ fetchImpl });

    await expect(p.search('test')).rejects.toThrow('ECONNREFUSED');
  });
});

// ── FallbackSearchProvider ───────────────────────────────────────────────

function fakeProvider(
  results: WebSearchResult[],
  shouldThrow = false,
  name?: string,
): WebSearchProvider {
  return {
    name,
    search: shouldThrow
      ? vi.fn<WebSearchProvider['search']>().mockRejectedValue(new Error('boom'))
      : vi.fn<WebSearchProvider['search']>().mockResolvedValue(results),
  };
}

describe('FallbackSearchProvider', () => {
  it('throws when constructed with empty providers array', () => {
    expect(() => new FallbackSearchProvider([])).toThrow(
      'FallbackSearchProvider requires at least one provider',
    );
  });

  it('returns results from the first provider when it succeeds', async () => {
    const p1 = fakeProvider([{ title: 'R1', url: 'https://a.com', snippet: 'S1' }]);
    const p2 = fakeProvider([{ title: 'R2', url: 'https://b.com', snippet: 'S2' }]);
    const fallback = new FallbackSearchProvider([p1, p2]);
    const results = await fallback.search('query');

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('R1');
    expect(p1.search).toHaveBeenCalledTimes(1);
    // Second provider should never be called since the first returned results.
    expect(p2.search).not.toHaveBeenCalled();
  });

  it('falls back to second provider when first returns empty array', async () => {
    const p1 = fakeProvider([]);
    const p2 = fakeProvider([{ title: 'Fallback', url: 'https://b.com', snippet: 'S' }]);
    const fallback = new FallbackSearchProvider([p1, p2]);
    const results = await fallback.search('query');

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Fallback');
    expect(p1.search).toHaveBeenCalledTimes(1);
    expect(p2.search).toHaveBeenCalledTimes(1);
  });

  it('falls back to second provider when first throws', async () => {
    const p1 = fakeProvider([], true);
    const p2 = fakeProvider([{ title: 'After Error', url: 'https://b.com', snippet: 'S' }]);
    const fallback = new FallbackSearchProvider([p1, p2]);
    const results = await fallback.search('query');

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('After Error');
  });

  it('returns empty array when every provider ran cleanly but found nothing', async () => {
    const p1 = fakeProvider([]);
    const p2 = fakeProvider([]);
    const fallback = new FallbackSearchProvider([p1, p2]);
    const results = await fallback.search('query');

    expect(results).toEqual([]);
  });

  it('throws an aggregated error naming each provider failure', async () => {
    const p1 = fakeProvider([], true, 'scream-cli');
    const p2 = fakeProvider([], false, 'duckduckgo');
    const fallback = new FallbackSearchProvider([p1, p2]);

    await expect(fallback.search('query')).rejects.toThrow(
      'All web search providers failed — scream-cli: boom; duckduckgo: no results',
    );
  });

  it('aborts the chain immediately on user cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const p1 = fakeProvider([]);
    const p2 = fakeProvider([{ title: 'T', url: 'https://b.com', snippet: 'S' }]);
    const fallback = new FallbackSearchProvider([p1, p2]);

    await expect(fallback.search('query', { signal: controller.signal })).rejects.toThrow();
    expect(p1.search).not.toHaveBeenCalled();
    expect(p2.search).not.toHaveBeenCalled();
  });

  it('does not continue the chain after an abort raised mid-chain', async () => {
    const controller = new AbortController();
    const p1: WebSearchProvider = {
      name: 'first',
      search: vi.fn<WebSearchProvider['search']>().mockImplementation(() => {
        controller.abort();
        return Promise.resolve([]);
      }),
    };
    const p2 = fakeProvider([{ title: 'T', url: 'https://b.com', snippet: 'S' }], false, 'second');
    const fallback = new FallbackSearchProvider([p1, p2]);

    await expect(fallback.search('query', { signal: controller.signal })).rejects.toThrow();
    expect(p2.search).not.toHaveBeenCalled();
  });

  it('forwards search options to each provider', async () => {
    const p1 = fakeProvider([]);
    const p2 = fakeProvider([{ title: 'T', url: 'https://b.com', snippet: 'S' }]);
    const fallback = new FallbackSearchProvider([p1, p2]);
    await fallback.search('query', { limit: 3, includeContent: true, toolCallId: 'c1' });

    expect(p1.search).toHaveBeenCalledWith('query', {
      limit: 3,
      includeContent: true,
      toolCallId: 'c1',
    });
    expect(p2.search).toHaveBeenCalledWith('query', {
      limit: 3,
      includeContent: true,
      toolCallId: 'c1',
    });
  });

  it('chains three providers correctly', async () => {
    const p1 = fakeProvider([]);
    const p2 = fakeProvider([]);
    const p3 = fakeProvider([{ title: 'Third', url: 'https://c.com', snippet: 'S' }]);
    const fallback = new FallbackSearchProvider([p1, p2, p3]);
    const results = await fallback.search('query');

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Third');
    expect(p1.search).toHaveBeenCalledTimes(1);
    expect(p2.search).toHaveBeenCalledTimes(1);
    expect(p3.search).toHaveBeenCalledTimes(1);
  });

  it('propagates the raw reason without the aggregate wrapper for a single provider', async () => {
    const p1 = fakeProvider([], true, 'duckduckgo');
    const fallback = new FallbackSearchProvider([p1]);

    await expect(fallback.search('query')).rejects.toThrow('boom');
    await expect(fallback.search('query')).rejects.not.toThrow(/All web search providers failed/);
  });
});
