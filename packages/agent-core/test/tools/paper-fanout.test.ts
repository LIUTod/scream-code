/**
 * Covers: PaperFanoutProvider — parallel fan-out, merge/dedupe, and the
 * partial-failure policy that keeps one broken backend from erasing an answer.
 */

import { describe, expect, it, vi } from 'vitest';

import type { PaperSearchResult, PaperSource } from '../../src/tools/builtin/web/paper-search';
import { PaperFanoutProvider, dedupePaperResults } from '../../src/tools/providers/paper/fanout';

function paper(overrides: Partial<PaperSearchResult> = {}): PaperSearchResult {
  return {
    id: 'id',
    title: 'A Reasonably Long Paper Title About Agents',
    authors: ['A. Author'],
    url: 'https://example.org/paper',
    source: 'stub',
    ...overrides,
  };
}

function source(name: string, results: PaperSearchResult[]): PaperSource {
  return { name, search: vi.fn().mockResolvedValue(results) };
}

function failingSource(name: string, message: string): PaperSource {
  return { name, search: vi.fn().mockRejectedValue(new Error(message)) };
}

describe('PaperFanoutProvider', () => {
  it('refuses to be constructed without sources', () => {
    expect(() => new PaperFanoutProvider([])).toThrow(/at least one source/);
  });

  it('queries every source in parallel rather than in sequence', async () => {
    const order: string[] = [];
    const slow = (name: string): PaperSource => ({
      name,
      search: async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`${name}:end`);
        return [paper({ id: name })];
      },
    });
    const fanout = new PaperFanoutProvider([slow('first'), slow('second')]);

    await fanout.search('q');

    // Both sources must have started before either finished.
    expect(order.slice(0, 2).toSorted()).toEqual(['first:start', 'second:start']);
  });

  it('interleaves sources so the first backend cannot fill the whole answer', async () => {
    const triple = (name: string): PaperSource =>
      source(
        name,
        [1, 2, 3].map((n) => paper({ id: `${name}${String(n)}`, title: `${name} paper ${String(n)} title long enough` })),
      );
    const fanout = new PaperFanoutProvider([triple('a'), triple('b'), triple('c')]);

    const response = await fanout.search('q', { limit: 5 });

    // Concatenation would return a1,a2,a3,b1,b2 and silently drop source c.
    expect(response.results.map((result) => result.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
  });

  it('merges results from all sources and caps them at the limit', async () => {
    const fanout = new PaperFanoutProvider([
      source('a', [paper({ id: 'a1', title: 'First Paper Title Long Enough To Keep' })]),
      source('b', [paper({ id: 'b1', title: 'Second Paper Title Long Enough To Keep' })]),
    ]);

    const response = await fanout.search('q', { limit: 1 });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.id).toBe('a1');
    expect(response.failures).toEqual([]);
  });

  it('collapses duplicates across sources by DOI, arXiv id and long titles', async () => {
    const fanout = new PaperFanoutProvider([
      source('arxiv', [
        paper({ id: 'a1', doi: '10.1000/XYZ', arxivId: '2405.00001v2', title: 'Shared Long Paper Title About Memory' }),
      ]),
      source('openalex', [
        paper({ id: 'o1', doi: 'https://doi.org/10.1000/xyz', title: 'Different Title Long Enough To Not Merge On It' }),
        paper({ id: 'o2', title: 'Shared Long Paper Title About Memory' }),
        paper({ id: 'o3', title: 'A Distinct Enough Paper Title To Survive' }),
      ]),
    ]);

    const response = await fanout.search('q', { limit: 10 });

    expect(response.results.map((result) => result.id)).toEqual(['a1', 'o3']);
  });

  it('lets a failing source degrade the answer instead of erasing it', async () => {
    const fanout = new PaperFanoutProvider([
      source('arxiv', [paper({ id: 'a1' })]),
      failingSource('openalex', 'OpenAlex responded with HTTP 429'),
    ]);

    const response = await fanout.search('q');

    expect(response.results.map((result) => result.id)).toEqual(['a1']);
    expect(response.failures).toEqual([{ source: 'openalex', reason: 'OpenAlex responded with HTTP 429' }]);
  });

  it('throws an aggregated error only when every source fails', async () => {
    const fanout = new PaperFanoutProvider([
      failingSource('arxiv', 'HTTP 503'),
      failingSource('crossref', 'HTTP 500'),
    ]);

    await expect(fanout.search('q')).rejects.toThrow(
      'All paper sources failed — arxiv: HTTP 503; crossref: HTTP 500',
    );
  });

  it('returns an empty result set (not an error) when sources answer with nothing', async () => {
    const fanout = new PaperFanoutProvider([source('arxiv', []), source('crossref', [])]);
    const response = await fanout.search('q');
    expect(response).toEqual({ results: [], failures: [] });
  });

  it('orders by publication date when sort=date, undated records last', async () => {
    const fanout = new PaperFanoutProvider([
      source('arxiv', [
        paper({ id: 'old', published: '2020-01-01', title: 'Old Paper Title Long Enough To Keep' }),
        paper({ id: 'undated', title: 'Undated Paper Title Long Enough To Keep' }),
      ]),
      source('crossref', [paper({ id: 'new', published: '2026-01-01', title: 'New Paper Title Long Enough To Keep' })]),
    ]);

    const response = await fanout.search('q', { sort: 'date', limit: 10 });

    expect(response.results.map((result) => result.id)).toEqual(['new', 'old', 'undated']);
  });

  it('narrows to the requested subset of sources', async () => {
    const arxiv = source('arxiv', [paper({ id: 'a1' })]);
    const crossref = source('crossref', [paper({ id: 'c1' })]);
    const fanout = new PaperFanoutProvider([arxiv, crossref]);

    const response = await fanout.search('q', { sources: ['crossref'] });

    expect(response.results.map((result) => result.id)).toEqual(['c1']);
    expect(arxiv.search).not.toHaveBeenCalled();
  });

  it('rejects unknown source names instead of silently searching nothing', async () => {
    const fanout = new PaperFanoutProvider([source('arxiv', [])]);
    await expect(fanout.search('q', { sources: ['nope'] })).rejects.toThrow(/Unknown paper source/);
  });

  it('refuses queries with no search terms before spending requests on them', async () => {
    const arxiv = source('arxiv', []);
    const fanout = new PaperFanoutProvider([arxiv]);

    await expect(fanout.search('   ')).rejects.toThrow(/non-empty query/);
    // Quotes normalize away to nothing; arXiv would answer `all:""` with the
    // whole corpus and the result would look like a genuine match.
    await expect(fanout.search('""')).rejects.toThrow(/non-empty query/);
    expect(arxiv.search).not.toHaveBeenCalled();
  });

  it('still answers from healthy sources when the shared budget runs out', async () => {
    const hanging: PaperSource = {
      name: 'hanging',
      search: (_query, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
          });
        }),
    };
    const fanout = new PaperFanoutProvider([hanging, source('healthy', [paper({ id: 'h1' })])], {
      totalBudgetMs: 60,
    });

    const response = await fanout.search('q');

    expect(response.results.map((result) => result.id)).toEqual(['h1']);
    expect(response.failures).toHaveLength(1);
    expect(response.failures[0]?.source).toBe('hanging');
    // The error class must survive aggregation, or the tool mislabels it.
    expect(response.failures[0]?.reason).toContain('TimeoutError');
  });

  it('propagates user cancellation instead of reporting a source failure', async () => {
    const controller = new AbortController();
    const hanging: PaperSource = {
      name: 'arxiv',
      search: (_query, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        }),
    };
    const fanout = new PaperFanoutProvider([hanging]);
    const pending = fanout.search('q', { signal: controller.signal });

    controller.abort();

    // Assert the discriminating property: a misreported cancellation would be
    // re-thrown as "All paper sources failed — arxiv: …", which also matches
    // a loose /aborted/ check.
    const failure: unknown = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('This operation was aborted');
    expect((failure as Error).name).toBe('AbortError');
  });

  it('exposes its source names in priority order', () => {
    const fanout = new PaperFanoutProvider([source('arxiv', []), source('crossref', [])]);
    expect(fanout.sourceNames).toEqual(['arxiv', 'crossref']);
  });

  it('keeps short titles out of title-based merging', () => {
    const kept = dedupePaperResults([
      paper({ id: 'one', title: 'Editorial' }),
      paper({ id: 'two', title: 'Editorial' }),
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(['one', 'two']);
  });
});
