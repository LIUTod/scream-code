/**
 * Covers: PaperSearchTool.
 *
 * A fake PaperSearchProvider isolates tool behaviour — formatting, the partial
 * failure note, error classification — from the network.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PaperSearchInputSchema,
  PaperSearchTool,
  type PaperSearchProvider,
  type PaperSearchResponse,
  type PaperSearchResult,
} from '../../src/tools/builtin/web/paper-search';
import { executeTool } from './fixtures/execute-tool';
import { toolContentString } from './fixtures/fake-jian';

const signal = new AbortController().signal;
const QUERY = 'agent memory';

function paper(overrides: Partial<PaperSearchResult> = {}): PaperSearchResult {
  return {
    id: 'arxiv:2405.00001',
    title: 'Memory Layers for Long-Horizon Agents',
    authors: ['A. Author', 'B. Author'],
    published: '2026-07-14',
    venue: 'arXiv cs.AI',
    url: 'https://arxiv.org/abs/2405.00001',
    pdfUrl: 'https://arxiv.org/pdf/2405.00001',
    arxivId: '2405.00001',
    abstract: 'Agent memory is a systems problem.',
    source: 'arxiv',
    ...overrides,
  };
}

function fakeProvider(response: Partial<PaperSearchResponse> = {}): PaperSearchProvider {
  return { search: vi.fn().mockResolvedValue({ results: [], failures: [], ...response }) };
}

async function run(provider: PaperSearchProvider, args: Record<string, unknown> = {}) {
  const tool = new PaperSearchTool(provider);
  return executeTool(tool, {
    turnId: 'turn-1',
    toolCallId: 'call-1',
    args: { query: QUERY, ...args },
    signal,
  });
}

describe('PaperSearchTool', () => {
  it('has name "PaperSearch" and a non-empty description', () => {
    const tool = new PaperSearchTool(fakeProvider());
    expect(tool.name).toBe('PaperSearch');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('parameters are generated from the input schema', () => {
    const tool = new PaperSearchTool(fakeProvider());
    expect(PaperSearchInputSchema.safeParse({ query: 'x' }).success).toBe(true);
    expect(PaperSearchInputSchema.safeParse({ query: '' }).success).toBe(true);
    expect(PaperSearchInputSchema.safeParse({ query: 'x', limit: 21 }).success).toBe(false);
    expect(PaperSearchInputSchema.safeParse({ query: 'x', sort: 'newest' }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' }, limit: {}, sort: {}, category: {}, sources: {} },
    });
  });

  it('formats every metadata field and labels the source', async () => {
    const result = await run(fakeProvider({ results: [paper({ doi: '10.1000/xyz', citations: 12 })] }));

    expect(result.isError).toBeFalsy();
    const text = toolContentString(result);
    expect(text).toContain('Source: arxiv');
    expect(text).toContain('Title: Memory Layers for Long-Horizon Agents');
    expect(text).toContain('Authors: A. Author, B. Author');
    expect(text).toContain('Published: 2026-07-14');
    expect(text).toContain('Venue: arXiv cs.AI');
    expect(text).toContain('DOI: 10.1000/xyz');
    expect(text).toContain('arXiv: 2405.00001');
    expect(text).toContain('Citations: 12');
    expect(text).toContain('URL: https://arxiv.org/abs/2405.00001');
    expect(text).toContain('PDF: https://arxiv.org/pdf/2405.00001');
    expect(text).toContain('Abstract: Agent memory is a systems problem.');
  });

  it('omits absent optional fields instead of printing empty labels', async () => {
    const minimal = paper({
      authors: [],
      published: undefined,
      venue: undefined,
      pdfUrl: undefined,
      arxivId: undefined,
      abstract: undefined,
      citations: undefined,
      doi: undefined,
    });
    const text = toolContentString(await run(fakeProvider({ results: [minimal] })));

    expect(text).toContain('Title: Memory Layers for Long-Horizon Agents');
    expect(text).not.toContain('Authors:');
    expect(text).not.toContain('Published:');
    expect(text).not.toContain('Venue:');
    expect(text).not.toContain('PDF:');
    expect(text).not.toContain('arXiv:');
    expect(text).not.toContain('Citations:');
    expect(text).not.toContain('DOI:');
    expect(text).not.toContain('Abstract:');
  });

  it('caps the abstract excerpt so one paper cannot flood the context', async () => {
    const long = 'word '.repeat(400);
    const text = toolContentString(await run(fakeProvider({ results: [paper({ abstract: long })] })));
    const line = text.split('\n').find((entry) => entry.startsWith('Abstract: '));

    expect(line).toBeDefined();
    expect(line?.endsWith('…')).toBe(true);
    expect(line?.length).toBeLessThanOrEqual('Abstract: '.length + 601);
  });

  it('caps the printed author list so a mega-collaboration paper cannot flood the context', async () => {
    const many = Array.from({ length: 25 }, (_, index) => `Author ${String(index + 1)}`);
    const text = toolContentString(await run(fakeProvider({ results: [paper({ authors: many })] })));
    const line = text.split('\n').find((entry) => entry.startsWith('Authors: '));

    expect(line).toContain('Author 10');
    expect(line).toContain('et al.');
    expect(line).not.toContain('Author 11');
  });

  it('reports an empty search as "No papers found."', async () => {
    const text = toolContentString(await run(fakeProvider()));
    expect(text).toContain('No papers found.');
  });

  it('surfaces the sources that could not be queried instead of hiding them', async () => {
    const text = toolContentString(
      await run(
        fakeProvider({
          results: [paper()],
          failures: [{ source: 'openalex', reason: 'OpenAlex responded with HTTP 429' }],
        }),
      ),
    );

    expect(text).toContain('Title: Memory Layers for Long-Horizon Agents');
    expect(text).toContain('Note: 1 source(s) could not be queried — openalex: OpenAlex responded with HTTP 429');
  });

  it('forwards every search option to the provider', async () => {
    const provider = fakeProvider();
    await run(provider, { limit: 3, sort: 'date', category: 'cs.AI', year_from: 2024, sources: ['arxiv'] });

    expect(provider.search).toHaveBeenCalledWith(
      QUERY,
      expect.objectContaining({
        limit: 3,
        sort: 'date',
        category: 'cs.AI',
        yearFrom: 2024,
        sources: ['arxiv'],
        signal,
      }),
    );
  });

  it('declares a search display and an approval rule scoped to the query', () => {
    const tool = new PaperSearchTool(fakeProvider());
    const execution = tool.resolveExecution({ query: QUERY });
    if (!('display' in execution)) throw new Error('expected a runnable execution');

    expect(execution.display).toEqual({ kind: 'search', query: QUERY });
    expect(execution.description).toContain('Searching papers');
    expect(execution.accesses).toBeDefined();
    // The permission layer hands matchesRule the rule's argument pattern.
    expect(execution.matchesRule?.(QUERY)).toBe(true);
    expect(execution.matchesRule?.('something else')).toBe(false);
  });

  it('classifies cancellation, timeout, rate limiting and network failures', async () => {
    const cases: { error: Error; expected: string }[] = [
      { error: Object.assign(new Error('aborted by grace timeout'), { name: 'AbortError' }), expected: 'Paper search cancelled' },
      { error: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), expected: 'Paper search timed out' },
      { error: new Error('All paper sources failed — arxiv: TimeoutError: The operation was aborted due to timeout'), expected: 'Paper search timed out' },
      { error: new Error('OpenAlex responded with HTTP 429 — anonymous access is rate limited'), expected: 'Paper search rate limited' },
      { error: new TypeError('fetch failed'), expected: 'Paper search failed (network)' },
      { error: new Error('Crossref responded with HTTP 500'), expected: 'Paper search service error' },
      { error: new Error('All paper sources failed — arxiv: HTTP 503'), expected: 'All paper sources failed' },
    ];

    for (const { error, expected } of cases) {
      const provider: PaperSearchProvider = { search: vi.fn().mockRejectedValue(error) };
      const result = await run(provider);
      expect(result.isError).toBe(true);
      expect(toolContentString(result)).toContain(expected);
    }
  });
});
