/**
 * Covers: the four paper sources (arXiv, OpenAlex, Crossref, Europe PMC) and
 * the per-source throttle.
 *
 * Fixtures mirror the real wire shapes (verified against live responses):
 * arXiv Atom entries, OpenAlex `results[]`, Crossref `message.items[]` and
 * Europe PMC `resultList.result[]`.
 */

import { describe, expect, it, vi } from 'vitest';

import { ArxivPaperSource } from '../../src/tools/providers/paper/arxiv';
import { CrossrefPaperSource, formatDateParts, stripJats } from '../../src/tools/providers/paper/crossref';
import { EuropePmcPaperSource, splitAuthorString } from '../../src/tools/providers/paper/europepmc';
import { OpenAlexPaperSource, rebuildAbstract } from '../../src/tools/providers/paper/openalex';
import { createSourceThrottle } from '../../src/tools/providers/paper/throttle';

// ── Fixtures ─────────────────────────────────────────────────────────

const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query: search_query=all:"agent memory"</title>
  <entry>
    <id>http://arxiv.org/abs/2405.00001v2</id>
    <title>Memory Layers for
  Long-Horizon Agents</title>
    <updated>2026-07-14T18:06:53Z</updated>
    <published>2026-07-14T18:06:53Z</published>
    <summary>Agent memory is a systems problem.</summary>
    <link href="https://arxiv.org/abs/2405.00001v2" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2405.00001v2" rel="related" type="application/pdf" title="pdf"/>
    <arxiv:primary_category term="cs.AI"/>
    <arxiv:comment>23 pages</arxiv:comment>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <author><name>A. Author</name></author>
    <author><name>B. Author</name></author>
  </entry>
</feed>`;

const OPENALEX_JSON = {
  meta: { count: 1 },
  results: [
    {
      id: 'https://openalex.org/W123',
      doi: 'https://doi.org/10.1000/XYZ',
      title: 'Agent Memory Systems',
      publication_date: '2026-05-01',
      authorships: [{ author: { display_name: 'C. Author' } }],
      primary_location: {
        source: { display_name: 'Journal of Agents' },
        landing_page_url: 'https://example.org/paper',
        pdf_url: 'https://example.org/paper.pdf',
      },
      cited_by_count: 12,
      abstract_inverted_index: { Agent: [0], memory: [1], matters: [2] },
    },
  ],
};

const CROSSREF_JSON = {
  status: 'ok',
  message: {
    items: [
      {
        DOI: '10.1000/XYZ',
        URL: 'https://doi.org/10.1000/xyz',
        title: ['Agent Memory Systems'],
        author: [{ given: 'C.', family: 'Author' }],
        published: { 'date-parts': [[2026, 5, 1]] },
        'container-title': ['Journal of Agents'],
        abstract: '<jats:p>Agent memory is a systems problem.</jats:p>',
        'is-referenced-by-count': 12,
        type: 'journal-article',
      },
    ],
  },
};

const EUROPEPMC_JSON = {
  version: '6.9',
  hitCount: 1,
  resultList: {
    result: [
      {
        id: 'PPR1274152',
        source: 'PPR',
        doi: '10.21203/rs.3.rs-9801639/v1',
        title: 'Agent Memory: A Survey',
        authorString: 'Smith A, Doe B.',
        firstPublicationDate: '2026-07-07',
        journalTitle: 'Nature Preprints',
        abstractText: 'Agent memory is a systems problem.',
        citedByCount: 3,
        fullTextUrlList: {
          fullTextUrl: [{ documentStyle: 'pdf', site: 'Publisher', url: 'https://example.org/survey.pdf' }],
        },
      },
    ],
  },
};

function responseBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchStub(response: Response) {
  // Clone per call: a Response body can only be consumed once, and the sources
  // legitimately issue a second (broadened) request against the same stub.
  return vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(response.clone()));
}

function noWaitThrottle() {
  return createSourceThrottle(0);
}

// ── arXiv ────────────────────────────────────────────────────────────

describe('ArxivPaperSource', () => {
  it('parses an Atom entry into a paper record', async () => {
    const source = new ArxivPaperSource(
      noWaitThrottle(),
      fetchStub(new Response(ARXIV_XML, { status: 200, headers: { 'content-type': 'application/atom+xml' } })),
    );

    const [paper] = await source.search('agent memory');

    expect(paper).toMatchObject({
      id: 'arxiv:2405.00001',
      title: 'Memory Layers for Long-Horizon Agents',
      authors: ['A. Author', 'B. Author'],
      published: '2026-07-14',
      venue: 'arXiv cs.AI',
      url: 'https://arxiv.org/abs/2405.00001v2',
      pdfUrl: 'https://arxiv.org/pdf/2405.00001v2',
      arxivId: '2405.00001',
      abstract: 'Agent memory is a systems problem.',
      source: 'arxiv',
    });
  });

  it('collapses the newlines arXiv wraps titles and summaries in', async () => {
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response(ARXIV_XML, { status: 200 })));
    const [paper] = await source.search('agent memory');
    expect(paper?.title).not.toContain('\n');
  });

  it('sends the identifying User-Agent and a phrase query', async () => {
    const fetchFn = fetchStub(new Response(ARXIV_XML, { status: 200 }));
    const source = new ArxivPaperSource(noWaitThrottle(), fetchFn);

    await source.search('agent memory');

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(params.get('search_query')).toBe('all:"agent memory"');
    expect(params.get('max_results')).toBe('5');
    expect(params.get('sortBy')).toBe('relevance');
    expect((init.headers as Record<string, string>)['user-agent']).toContain('scream-code');
  });

  it('narrows by category, year and date sort server-side', async () => {
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response(ARXIV_XML, { status: 200 })));
    const params = new URL(
      source.buildUrl('agent memory', { category: 'cs.AI', yearFrom: 2024, sort: 'date', limit: 3 }),
    ).searchParams;

    expect(params.get('search_query')).toBe(
      'all:"agent memory" AND cat:cs.AI AND submittedDate:[202401010000 TO 999912312359]',
    );
    expect(params.get('sortBy')).toBe('submittedDate');
    expect(params.get('max_results')).toBe('3');
  });

  it('searches the leading phrase first and only broadens when nothing is found', async () => {
    const longQuery = 'long-term memory for autonomous agents';
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response(ARXIV_XML, { status: 200 })));

    // A six-word query is reduced to its leading phrase (measured: whole-phrase
    // and all-term AND forms return zero hits for queries like this).
    expect(new URL(source.buildUrl(longQuery)).searchParams.get('search_query')).toBe('all:"long-term memory for"');
    expect(new URL(source.buildUrl(longQuery, {}, true)).searchParams.get('search_query')).toBe(
      '(all:long-term OR all:memory OR all:for OR all:autonomous OR all:agents)',
    );
  });

  it('parenthesises the OR group so category filters cannot leak', () => {
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response(ARXIV_XML, { status: 200 })));
    const broad = new URL(
      source.buildUrl('long-term memory', { category: 'cs.AI', yearFrom: 2024 }, true),
    ).searchParams.get('search_query');

    // Measured: without the parentheses arXiv reads this as `a OR (b AND cat)`
    // and returns results from other categories.
    expect(broad).toBe(
      '(all:long-term OR all:memory) AND cat:cs.AI AND submittedDate:[202401010000 TO 999912312359]',
    );
  });

  it('retries with the broad query when the precise phrase finds nothing', async () => {
    const empty = '<feed><title>no results</title></feed>';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(empty, { status: 200 }))
      .mockResolvedValueOnce(new Response(ARXIV_XML, { status: 200 }));
    const source = new ArxivPaperSource(noWaitThrottle(), fetchFn);

    const results = await source.search('long-term memory for autonomous agents');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(fetchFn.mock.calls[1]?.[0] as string).searchParams.get('search_query')).toContain(' OR ');
    expect(results).toHaveLength(1);
  });

  it('does not spend a second request when the phrase already answered', async () => {
    const fetchFn = fetchStub(new Response(ARXIV_XML, { status: 200 }));
    const source = new ArxivPaperSource(noWaitThrottle(), fetchFn);

    await source.search('long-term memory for autonomous agents');

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('broadens a short query too when its phrase found nothing', async () => {
    const empty = '<feed><title>no results</title></feed>';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(empty, { status: 200 }))
      .mockResolvedValueOnce(new Response(ARXIV_XML, { status: 200 }));
    const source = new ArxivPaperSource(noWaitThrottle(), fetchFn);

    const results = await source.search('agent memory');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
  });

  it('parses pre-2007 identifiers that contain a slash', async () => {
    const xml = `<feed><entry>
      <id>http://arxiv.org/abs/hep-th/9901001v3</id>
      <title>Old Style Identifier</title>
      <link href="http://arxiv.org/abs/hep-th/9901001v3" rel="alternate" type="text/html"/>
    </entry></feed>`;
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response(xml, { status: 200 })));

    const [entry] = await source.search('q');

    expect(entry?.arxivId).toBe('hep-th/9901001');
    expect(entry?.id).toBe('arxiv:hep-th/9901001');
  });

  it('sends nothing for a query with no searchable terms', async () => {
    const fetchFn = fetchStub(new Response(ARXIV_XML, { status: 200 }));
    const source = new ArxivPaperSource(noWaitThrottle(), fetchFn);

    expect(await source.search(' "" ')).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('escapes quotes so a query cannot break out of the phrase', () => {
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response(ARXIV_XML, { status: 200 })));
    const params = new URL(source.buildUrl('say "hi" now')).searchParams;
    expect(params.get('search_query')).toBe('all:"say hi now"');
  });

  it('fails loudly on a non-2xx response', async () => {
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response('nope', { status: 503 })));
    await expect(source.search('q')).rejects.toThrow('arXiv responded with HTTP 503');
  });

  it('drops malformed entries instead of emitting empty records', async () => {
    const xml = '<feed><entry><summary>no id or title</summary></entry></feed>';
    const source = new ArxivPaperSource(noWaitThrottle(), fetchStub(new Response(xml, { status: 200 })));
    expect(await source.search('q')).toEqual([]);
  });
});

// ── OpenAlex ─────────────────────────────────────────────────────────

describe('OpenAlexPaperSource', () => {
  it('parses a work, rebuilding the abstract from the inverted index', async () => {
    const source = new OpenAlexPaperSource(noWaitThrottle(), fetchStub(responseBody(OPENALEX_JSON)));

    const [paper] = await source.search('agent memory');

    expect(paper).toMatchObject({
      id: 'openalex:https://openalex.org/W123',
      title: 'Agent Memory Systems',
      authors: ['C. Author'],
      published: '2026-05-01',
      venue: 'Journal of Agents',
      url: 'https://example.org/paper',
      pdfUrl: 'https://example.org/paper.pdf',
      doi: '10.1000/xyz',
      abstract: 'Agent memory matters',
      citations: 12,
      source: 'openalex',
    });
  });

  it('resolves the DOI when a work has no landing page', async () => {
    const payload = {
      results: [{ id: 'https://openalex.org/W9', doi: 'https://doi.org/10.1000/Only', title: 'DOI Only Paper' }],
    };
    const source = new OpenAlexPaperSource(noWaitThrottle(), fetchStub(responseBody(payload)));

    const [paper] = await source.search('q');

    // Never a path built from a bare DOI (that produced a nonsense openalex.org URL).
    expect(paper?.url).toBe('https://doi.org/10.1000/only');
  });

  it('reports the anonymous rate limit with the retry hint', async () => {
    const stub = fetchStub(
      responseBody({ error: 'rate_limited', message: 'too many requests', retryAfter: 37 }, 429),
    );
    const source = new OpenAlexPaperSource(noWaitThrottle(), stub);

    await expect(source.search('q')).rejects.toThrow(/HTTP 429.*retry in 37s.*free API key/s);
  });

  it('builds a polite query with sort and year filter', () => {
    const source = new OpenAlexPaperSource(noWaitThrottle(), fetchStub(responseBody(OPENALEX_JSON)));
    const params = new URL(source.buildUrl('agent memory', { limit: 7, sort: 'date', yearFrom: 2024 })).searchParams;

    expect(params.get('search')).toBe('agent memory');
    expect(params.get('per-page')).toBe('7');
    expect(params.get('sort')).toBe('publication_date:desc');
    expect(params.get('filter')).toBe('from_publication_date:2024-01-01');
  });
});

// ── Crossref ─────────────────────────────────────────────────────────

describe('CrossrefPaperSource', () => {
  it('parses a work item, stripping JATS markup from the abstract', async () => {
    const source = new CrossrefPaperSource(noWaitThrottle(), fetchStub(responseBody(CROSSREF_JSON)));

    const [paper] = await source.search('agent memory');

    expect(paper).toMatchObject({
      id: 'doi:10.1000/xyz',
      title: 'Agent Memory Systems',
      authors: ['C. Author'],
      published: '2026-05-01',
      venue: 'Journal of Agents',
      url: 'https://doi.org/10.1000/xyz',
      doi: '10.1000/xyz',
      abstract: 'Agent memory is a systems problem.',
      citations: 12,
      source: 'crossref',
    });
    expect(paper?.abstract).not.toContain('<jats:p>');
  });

  it('builds a relevance query with rows and date filter', () => {
    const source = new CrossrefPaperSource(noWaitThrottle(), fetchStub(responseBody(CROSSREF_JSON)));
    const params = new URL(source.buildUrl('agent memory', { limit: 4, yearFrom: 2023 })).searchParams;

    expect(params.get('query')).toBe('agent memory');
    expect(params.get('rows')).toBe('4');
    expect(params.get('sort')).toBe('relevance');
    expect(params.get('filter')).toBe('from-pub-date:2023-01-01');
  });

  it('fails loudly on a non-2xx response', async () => {
    const source = new CrossrefPaperSource(noWaitThrottle(), fetchStub(responseBody({}, 500)));
    await expect(source.search('q')).rejects.toThrow('Crossref responded with HTTP 500');
  });
});

// ── Europe PMC ───────────────────────────────────────────────────────

describe('EuropePmcPaperSource', () => {
  it('parses a result with authors, venue, links and citations', async () => {
    const source = new EuropePmcPaperSource(noWaitThrottle(), fetchStub(responseBody(EUROPEPMC_JSON)));

    const [paper] = await source.search('agent memory');

    expect(paper).toMatchObject({
      id: 'europepmc:PPR1274152',
      title: 'Agent Memory: A Survey',
      authors: ['Smith A', 'Doe B'],
      published: '2026-07-07',
      venue: 'Nature Preprints',
      url: 'https://doi.org/10.21203/rs.3.rs-9801639/v1',
      pdfUrl: 'https://example.org/survey.pdf',
      doi: '10.21203/rs.3.rs-9801639/v1',
      citations: 3,
      source: 'europepmc',
    });
  });

  it('asks for the core result shape with the citation sort', () => {
    const source = new EuropePmcPaperSource(noWaitThrottle(), fetchStub(responseBody(EUROPEPMC_JSON)));
    const params = new URL(source.buildUrl('agent memory', { limit: 6, yearFrom: 2020 })).searchParams;

    expect(params.get('resultType')).toBe('core');
    expect(params.get('pageSize')).toBe('6');
    expect(params.get('sort')).toBe('CITED desc');
    expect(params.get('query')).toBe('(agent memory) AND (PUB_YEAR:[2020 TO 3000])');
  });

  it('falls back to the repository link when no DOI exists', async () => {
    const payload = { resultList: { result: [{ id: 'MED1', source: 'MED', title: 'No DOI Paper' }] } };
    const source = new EuropePmcPaperSource(noWaitThrottle(), fetchStub(responseBody(payload)));
    const [paper] = await source.search('q');
    expect(paper?.url).toBe('https://europepmc.org/article/MED/MED1');
  });
});

// ── Throttle ─────────────────────────────────────────────────────────

describe('createSourceThrottle', () => {
  it('separates consecutive requests by the minimum interval', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const throttle = createSourceThrottle(3_000, {
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await throttle.acquire();
    await throttle.acquire();
    await throttle.acquire();

    expect(sleeps).toEqual([3_000, 3_000]);
    // Third acquire started at t=6000, so the next slot opens one interval later.
    expect(throttle.nextAllowedAt()).toBe(9_000);
  });

  it('serialises overlapping callers instead of racing them', async () => {
    const order: string[] = [];
    let now = 0;
    const throttle = createSourceThrottle(1_000, {
      clock: () => now,
      sleep: async (ms) => {
        order.push(`sleep:${String(ms)}`);
        now += ms;
      },
    });

    await Promise.all([
      throttle.acquire().then(() => order.push('first')),
      throttle.acquire().then(() => order.push('second')),
    ]);

    expect(order).toEqual(['first', 'sleep:1000', 'second']);
  });

  it('does not wait when the interval has already elapsed', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const throttle = createSourceThrottle(1_000, {
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await throttle.acquire();
    now += 5_000;
    await throttle.acquire();

    expect(sleeps).toEqual([]);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────

describe('source helpers', () => {
  it('rebuildAbstract reconstructs word order from positions', () => {
    expect(rebuildAbstract({ second: [1], first: [0] })).toBe('first second');
    expect(rebuildAbstract(undefined)).toBeUndefined();
  });

  it('stripJats removes markup and collapses whitespace', () => {
    expect(stripJats('<jats:p>line  one</jats:p>\n<jats:p>line two</jats:p>')).toBe('line one line two');
  });

  it('formatDateParts renders partial dates without inventing missing parts', () => {
    expect(formatDateParts({ 'date-parts': [[2026, 5, 1]] })).toBe('2026-05-01');
    expect(formatDateParts({ 'date-parts': [[2026]] })).toBe('2026');
    expect(formatDateParts({ 'date-parts': [[2026, 5]] })).toBe('2026-05');
    expect(formatDateParts({})).toBeUndefined();
  });

  it('splitAuthorString turns Europe PMC author strings into a list', () => {
    expect(splitAuthorString('Smith A, Doe B.')).toEqual(['Smith A', 'Doe B']);
    expect(splitAuthorString(undefined)).toEqual([]);
  });
});
