/**
 * Covers: BingSearchProvider.
 *
 * Tests the provider directly with a mocked fetch implementation so no real
 * network calls are made. The HTML fixtures mirror Bing's server-rendered
 * results page (`<li class="b_algo">` blocks with a title h2 and a
 * `b_lineclamp*` snippet; outbound links wrapped in `bing.com/ck/a?u=a1…`).
 */

import { describe, expect, it, vi } from 'vitest';

import { BingSearchProvider, parseBingResults } from '../../src/tools/providers/bing-search';

// ── Helpers ──────────────────────────────────────────────────────────────

function bingHtmlResult(title: string, href: string, snippet?: string): string {
  return `<li class="b_algo" data-id iid=SERP.1><h2 class=""><a target="_blank" href="${href}">${title}</a></h2>${
    snippet !== undefined ? `<p class="b_lineclamp2">${snippet}</p>` : ''
  }</li>`;
}

/** Build a Bing click-tracker URL (`u=a1<base64url>` payload). */
function wrapUrl(target: string): string {
  const b64 = Buffer.from(target, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `https://www.bing.com/ck/a?!&amp;&amp;p=abc123&u=a1${b64}&ntb=1`;
}

// ── BingSearchProvider ───────────────────────────────────────────────────

describe('BingSearchProvider', () => {
  it('implements WebSearchProvider', () => {
    const provider = new BingSearchProvider();
    expect(provider).toBeDefined();
    expect(provider.name).toBe('bing');
    expect(typeof provider.search).toBe('function');
  });

  it('GETs the search endpoint with a browser User-Agent and the query', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html></html>', { status: 200 }));
    const p = new BingSearchProvider({ fetchImpl });
    await p.search('hello world', { limit: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://www.bing.com/search?');
    expect(url).toContain('q=hello+world');
    expect(url).toContain('count=');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
    expect(init.signal).toBeDefined();
  });

  it('parses result blocks and decodes click-tracker URLs back to the target', async () => {
    const html = `<html><body><ol id="b_results">
      ${bingHtmlResult('Page One', wrapUrl('https://example.com/one'), 'Snippet one.')}
      ${bingHtmlResult('Page Two', wrapUrl('https://example.com/two'), 'Snippet <strong>two</strong>.')}
    </ol></body></html>`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    const p = new BingSearchProvider({ fetchImpl });
    const results = await p.search('test');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Page One',
      url: 'https://example.com/one',
      snippet: 'Snippet one.',
    });
    // Inline tags are stripped from snippets.
    expect(results[1]?.snippet).toBe('Snippet two.');
  });

  it('keeps direct (non-wrapped) absolute URLs as-is', () => {
    const html = `<ol>${bingHtmlResult('Direct', 'https://direct.example.com/page', 'ok')}</ol>`;
    const results = parseBingResults(html);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://direct.example.com/page');
  });

  it('drops duplicate URLs and respects the limit', async () => {
    const html = `<ol>
      ${bingHtmlResult('One', wrapUrl('https://example.com/dup'), 'a')}
      ${bingHtmlResult('One again', wrapUrl('https://example.com/dup'), 'b')}
      ${bingHtmlResult('Two', wrapUrl('https://example.com/2'), 'c')}
      ${bingHtmlResult('Three', wrapUrl('https://example.com/3'), 'd')}
    </ol>`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    const p = new BingSearchProvider({ fetchImpl });
    const results = await p.search('test', { limit: 2 });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.url)).toEqual(['https://example.com/dup', 'https://example.com/2']);
  });

  it('throws on an anti-bot challenge page so the fallback chain can move on', async () => {
    const challenge =
      '<html><head><title>One last step</title></head><body>Please verify you are human.</body></html>';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(challenge, { status: 200 }));
    const p = new BingSearchProvider({ fetchImpl });

    await expect(p.search('test')).rejects.toThrow(/challenge/i);
  });

  it('returns an empty array when the page has no result blocks', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html><body>No results found.</body></html>', { status: 200 }));
    const p = new BingSearchProvider({ fetchImpl });

    await expect(p.search('test')).resolves.toEqual([]);
  });
  it('throws on non-2xx responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('server error', { status: 500 }));
    const p = new BingSearchProvider({ fetchImpl });
    await expect(p.search('test')).rejects.toThrow(/HTTP 500/);
  });

  it('parses blocks and snippets whose attributes are in a different order', async () => {
    const html = `<ol><li data-id class="b_algo extra-class"><h2><a href="${wrapUrl(
      'https://example.com/shuffled',
    )}">Shuffled</a></h2><p data-x class="b_lineclamp4 b_snippet">Order-agnostic snippet.</p></li></ol>`;
    const results = parseBingResults(html);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://example.com/shuffled');
    expect(results[0]?.snippet).toBe('Order-agnostic snippet.');
  });

  it('drops click-tracker URLs it cannot decode instead of surfacing the redirector', () => {
    const html = `<ol>${bingHtmlResult('Undecodable', 'https://www.bing.com/ck/a?!&&p=abc&ntb=1', 'x')}</ol>`;
    expect(parseBingResults(html)).toEqual([]);
  });

  it('survives out-of-range numeric entities', () => {
    const html = `<ol>${bingHtmlResult('Entity', wrapUrl('https://example.com/e'), 'A &#x110000; B')}</ol>`;
    const results = parseBingResults(html);
    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toBe('A B');
  });

  it('maps <br> and block tags to spaces without fusing words', () => {
    const html = `<ol>${bingHtmlResult('Breaks', wrapUrl('https://example.com/br'), 'line one<br>line two</p>')}</ol>`;
    expect(parseBingResults(html)[0]?.snippet).toBe('line one line two');
  });

  it('clamps the requested count to a sane window', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('<html></html>', { status: 200 }));
    const p = new BingSearchProvider({ fetchImpl });
    await p.search('test', { limit: 1 });
    const [url1] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url1).toContain('count=10');
    fetchImpl.mockClear();
    await p.search('test', { limit: 20 });
    const [url2] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url2).toContain('count=25');
  });
});
