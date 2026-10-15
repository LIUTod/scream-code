/**
 * Covers: GoogleSearchProvider.
 *
 * Tests the provider directly with a mocked fetch implementation so no real
 * network calls are made. The HTML fixtures mirror Google's server-rendered
 * results page: organic results anchor an `<h3>` title (both the
 * `anchor-wraps-heading` and `heading-wraps-anchor` variants), the snippet
 * lives in a `VwiC3b`-style block, and some links come wrapped in
 * `google.com/url?q=…`.
 */

import { describe, expect, it, vi } from 'vitest';

import { GoogleSearchProvider, parseGoogleResults } from '../../src/tools/providers/google-search';

// ── Helpers ──────────────────────────────────────────────────────────────

function googleHtmlResult(title: string, href: string, snippet?: string): string {
  return `<div class="g"><a href="${href}"><h3 class="zBAuAb">${title}</h3></a>${
    snippet !== undefined ? `<div class="VwiC3b"><span>${snippet}</span></div>` : ''
  }</div>`;
}

/** Heading-wraps-anchor variant (appears on some result surfaces). */
function googleHtmlResultInnerAnchor(title: string, href: string): string {
  return `<div class="g"><h3 class="zBAuAb uvx3id"><a href="${href}">${title}</a></h3></div>`;
}

// ── GoogleSearchProvider ─────────────────────────────────────────────────

describe('GoogleSearchProvider', () => {
  it('implements WebSearchProvider', () => {
    const provider = new GoogleSearchProvider();
    expect(provider).toBeDefined();
    expect(provider.name).toBe('google');
    expect(typeof provider.search).toBe('function');
  });

  it('GETs the search endpoint with a browser User-Agent and the query', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html></html>', { status: 200 }));
    const p = new GoogleSearchProvider({ fetchImpl });
    await p.search('hello world', { limit: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://www.google.com/search?');
    expect(url).toContain('q=hello+world');
    expect(url).toContain('num=');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
    expect(init.signal).toBeDefined();
  });

  it('parses organic blocks and drops ad, tracker and self-navigating links', async () => {
    const html = `<html><body>
      ${googleHtmlResult('Page One', 'https://example.com/one', 'Snippet one.')}
      ${googleHtmlResult('Ad Row', 'https://www.googleadservices.com/pagead/aclk?sa=L&adurl=https://ad.example.com')}
      ${googleHtmlResult('Self Link', 'https://www.google.com/search?q=next')}
      ${googleHtmlResult('Page Two', 'https://example.com/two', 'Snippet <em>two</em>.')}
      ${googleHtmlResult('Page One Dup', 'https://example.com/one')}
    </body></html>`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
    const p = new GoogleSearchProvider({ fetchImpl });
    const results = await p.search('test');

    expect(results.map((r) => r.title)).toEqual(['Page One', 'Page Two']);
    expect(results[0]).toEqual({
      title: 'Page One',
      url: 'https://example.com/one',
      snippet: 'Snippet one.',
    });
    // Inline tags are stripped from snippets.
    expect(results[1]?.snippet).toBe('Snippet two.');
  });

  it('unwraps `/url?q=` redirects and falls back to the title for untracked links', async () => {
    const html = `<html><body>
      ${googleHtmlResult('Wrapped', 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Ftarget&sa=U', 'Wrapped snippet.')}
      ${googleHtmlResult('Protocol Only', '//example.com/relative', 'Snippet.')}
    </body></html>`;
    const results = parseGoogleResults(html);

    expect(results).toHaveLength(2);
    expect(results[0]?.url).toBe('https://example.com/target');
    expect(results[1]?.url).toBe('https://example.com/relative');
  });

  it('handles the heading-wraps-anchor variant', () => {
    const html = `<html><body>${googleHtmlResultInnerAnchor('Inner', 'https://example.com/inner')}</body></html>`;
    const results = parseGoogleResults(html);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Inner', url: 'https://example.com/inner' });
    // No snippet block → the title doubles as the snippet.
    expect(results[0]?.snippet).toBe('Inner');
  });

  it('returns an empty array for a page without organic h3 links', () => {
    const results = parseGoogleResults('<html><body><div class="kp-wholepage">panel</div></body></html>');
    expect(results).toEqual([]);
  });

  it('throws on CAPTCHA, unusual-traffic and consent interstitials', async () => {
    const pages = [
      '<script>location.replace("https://www.google.com/sorry/index?continue=x")</script>',
      '<html><body><form class="g-recaptcha" action="#"></form></body></html>',
      '<html><body>Our systems have detected unusual traffic from your computer network</body></html>',
      '<html><body>Before you continue to Google</body></html>',
    ];
    for (const html of pages) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status: 200 }));
      const p = new GoogleSearchProvider({ fetchImpl });
      await expect(p.search('test')).rejects.toThrow(/Google blocked the request/);
    }
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 503 }));
    const p = new GoogleSearchProvider({ fetchImpl });
    await expect(p.search('test')).rejects.toThrow(/HTTP 503/);
  });
});
