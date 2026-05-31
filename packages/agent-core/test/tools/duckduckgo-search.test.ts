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

function ddgApiResponse(overrides: Record<string, unknown> = {}): object {
  return {
    Abstract: '',
    AbstractText: '',
    AbstractURL: '',
    AbstractSource: '',
    Heading: '',
    RelatedTopics: [],
    ...overrides,
  };
}

function ddgTopic(
  firstUrl: string,
  text: string,
): { FirstURL: string; Text: string } {
  return { FirstURL: firstUrl, Text: text };
}

function ddgCategory(
  name: string,
  topics: Array<{ FirstURL: string; Text: string }>,
): { Name: string; Topics: Array<{ FirstURL: string; Text: string }> } {
  return { Name: name, Topics: topics };
}

// ── DuckDuckGoSearchProvider ─────────────────────────────────────────────

describe('DuckDuckGoSearchProvider', () => {
  const provider = new DuckDuckGoSearchProvider();

  it('implements WebSearchProvider', () => {
    expect(provider).toBeDefined();
    expect(typeof provider.search).toBe('function');
  });

  describe('Instant Answer API parsing', () => {
    it('returns abstract as a result when present', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify(
            ddgApiResponse({
              AbstractText: 'Paris is the capital of France.',
              AbstractURL: 'https://en.wikipedia.org/wiki/Paris',
              Heading: 'Paris',
              AbstractSource: 'Wikipedia',
            }),
          ),
          { status: 200 },
        ),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('Paris');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]?.title).toBe('Paris');
      expect(results[0]?.url).toBe('https://en.wikipedia.org/wiki/Paris');
      expect(results[0]?.snippet).toBe('Paris is the capital of France.');
    });

    it('returns RelatedTopics as results', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify(
            ddgApiResponse({
              RelatedTopics: [
                ddgTopic('https://example.com/a', 'Topic A'),
                ddgTopic('https://example.com/b', 'Topic B'),
              ],
            }),
          ),
          { status: 200 },
        ),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results.length).toBe(2);
      expect(results[0]?.url).toBe('https://example.com/a');
      expect(results[1]?.url).toBe('https://example.com/b');
    });

    it('flattens hierarchical RelatedTopics (categories with nested topics)', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify(
            ddgApiResponse({
              RelatedTopics: [
                ddgCategory('Category', [
                  ddgTopic('https://example.com/nested', 'Nested Topic'),
                ]),
                ddgTopic('https://example.com/direct', 'Direct Topic'),
              ],
            }),
          ),
          { status: 200 },
        ),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results.length).toBe(2);
      expect(results[0]?.url).toBe('https://example.com/nested');
      expect(results[1]?.url).toBe('https://example.com/direct');
    });

    it('respects the limit option', async () => {
      const topics = Array.from({ length: 10 }, (_, i) =>
        ddgTopic(`https://example.com/${i}`, `Topic ${i}`),
      );
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(ddgApiResponse({ RelatedTopics: topics })), { status: 200 }),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test', { limit: 3 });

      expect(results.length).toBe(3);
    });

    it('skips topics with empty URL or text', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify(
            ddgApiResponse({
              RelatedTopics: [
                { FirstURL: '', Text: 'No URL' },
                { FirstURL: 'https://example.com/ok', Text: '' },
                { FirstURL: '', Text: '' },
              ],
            }),
          ),
          { status: 200 },
        ),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results.length).toBe(0);
    });

    it('returns empty array on HTTP 500 from API', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('server error', { status: 500 }),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results).toEqual([]);
    });

    it('returns empty array on JSON parse failure', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('not json', { status: 200 }),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results).toEqual([]);
    });
  });

  describe('Lite HTML scraping', () => {
    it('returns empty array when HTML contains CAPTCHA markers', async () => {
      // First call: API returns empty (no results). Second call: Lite returns CAPTCHA.
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(ddgApiResponse()), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response('<html><body><div class="anomaly-modal__mask"></div></body></html>', {
            status: 200,
          }),
        );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results).toEqual([]);
    });

    it('extracts results from valid Lite HTML', async () => {
      const liteHtml = `
        <html><body><table>
          <tr>
            <td><a rel="nofollow" class="result-link" href="https://example.com/page1">Page One Title</a></td>
          </tr>
          <tr>
            <td class="result-snippet">Snippet for page one.</td>
          </tr>
          <tr>
            <td><a rel="nofollow" class="result-link" href="https://example.com/page2">Page Two Title</a></td>
          </tr>
          <tr>
            <td class="result-snippet">Snippet for page two.</td>
          </tr>
        </table></body></html>`;

      // First call: API returns empty. Second call: Lite returns results.
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(ddgApiResponse()), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(liteHtml, { status: 200 }));
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      const results = await p.search('test');

      expect(results.length).toBeGreaterThanOrEqual(1);
      const page1 = results.find((r) => r.url === 'https://example.com/page1');
      expect(page1).toBeDefined();
      expect(page1?.title).toBe('Page One Title');
      expect(page1?.snippet).toBe('Snippet for page one.');
    });

    it('does not scrape Lite HTML when API already returns results', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify(
            ddgApiResponse({
              RelatedTopics: [ddgTopic('https://example.com/from-api', 'From API')],
            }),
          ),
          { status: 200 },
        ),
      );
      const p = new DuckDuckGoSearchProvider({ fetchImpl });
      await p.search('test');

      // Only one fetch call — the API returned results, so Lite was skipped.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});

// ── FallbackSearchProvider ───────────────────────────────────────────────

function fakeProvider(
  results: WebSearchResult[],
  shouldThrow = false,
): WebSearchProvider {
  return {
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

  it('returns empty array when all providers fail', async () => {
    const p1 = fakeProvider([], true);
    const p2 = fakeProvider([]);
    const fallback = new FallbackSearchProvider([p1, p2]);
    const results = await fallback.search('query');

    expect(results).toEqual([]);
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
});
