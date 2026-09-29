/**
 * arXiv paper source — the preprint server's public Atom API.
 *
 * Terms of use (https://info.arxiv.org/help/api/tou.html): at most one request
 * every 3 seconds from a single client, metadata is CC0. We only ever read
 * metadata and hand back links — the full text is never downloaded, cached, or
 * redistributed here. The client identifies itself with a contact URL in the
 * User-Agent, which arXiv asks for and uses to reach out instead of blocking.
 */

import { XMLParser } from 'fast-xml-parser';

import type { PaperSearchOptions, PaperSearchResult } from '../../builtin/web/paper-search';
import { withHardTimeout } from '../search-timeout';
import { ARXIV_SOURCE_INTERVAL_MS, createSourceThrottle } from './throttle';

const ENDPOINT = 'https://export.arxiv.org/api/query';

/** Identifies this client to the public APIs (arXiv asks for a contact URL). */
export const PAPER_USER_AGENT = 'scream-code (+https://github.com/LIUTod/scream-code)';

export const ARXIV_SOURCE_NAME = 'arxiv';

// Old-style ids contain a slash (`hep-th/9901001v3`), so the id capture must
// allow one; a `[^/\s]+` class silently fell back to the whole entry URL.
const ARXIV_ID_PATTERN = /abs\/(.+?)(?:v\d+)?$/;

/** How many leading words form the primary (precise) phrase. */
const HEADLINE_WORDS = 3;

function queryWords(query: string): string[] {
  return query
    .replaceAll('"', ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Shared category/year narrowing for both the strict and the broad form. */
function filtersFor(options: PaperSearchOptions): string[] {
  const filters: string[] = [];
  const category = options.category?.trim();
  if (category !== undefined && category.length > 0) filters.push(`cat:${category}`);
  if (options.yearFrom !== undefined) {
    filters.push(`submittedDate:[${String(options.yearFrom)}01010000 TO 999912312359]`);
  }
  return filters;
}

/**
 * Primary `search_query`: the leading phrase.
 *
 * Measured against the live API: a whole long query as one phrase, and an AND
 * of every term, both return **zero** hits for realistic six-word queries
 * ("long-term memory for autonomous agents"), while the leading phrase returns
 * results. Precision first — {@link buildArxivBroadQuery} is the safety net.
 */
export function buildArxivQuery(query: string, options: PaperSearchOptions = {}): string {
  const words = queryWords(query);
  const headline = words.slice(0, HEADLINE_WORDS).join(' ');
  const terms = [`all:"${headline}"`, ...filtersFor(options)];
  return terms.join(' AND ');
}

/**
 * Fallback `search_query`: OR of every term, used only when the primary phrase
 * found nothing. Keeps recall available without spending it on every query.
 *
 * The OR group is parenthesised on purpose: arXiv binds AND tighter than OR,
 * so `all:a OR all:b AND cat:cs.AI` would be read as `a OR (b AND cs.AI)` and
 * the category filter would leak — verified against the live API (10 results,
 * 2 of them `physics.*` without the parentheses, none with them).
 */
export function buildArxivBroadQuery(query: string, options: PaperSearchOptions = {}): string {
  const words = queryWords(query);
  const group = words.length > 0 ? words.map((word) => `all:${word}`).join(' OR ') : 'all:""';
  return [`(${group})`, ...filtersFor(options)].join(' AND ');
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

/** Collapse the newline-heavy whitespace arXiv wraps titles/summaries in. */
function tidy(value: string | undefined): string | undefined {
  const collapsed = value?.replaceAll(/\s+/g, ' ').trim();
  return collapsed !== undefined && collapsed.length > 0 ? collapsed : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseEntry(entry: Record<string, unknown>): PaperSearchResult | undefined {
  const title = tidy(asText(entry['title']));
  const rawId = asText(entry['id']);
  if (title === undefined || rawId === undefined) return undefined;

  const arxivId = ARXIV_ID_PATTERN.exec(rawId)?.[1] ?? rawId;
  const links = asRecords(entry['link']);
  const href = (predicate: (link: Record<string, unknown>) => boolean): string | undefined =>
    asText(links.find(predicate)?.['@_href']);

  const url = href((link) => link['@_rel'] === 'alternate') ?? `https://arxiv.org/abs/${arxivId}`;
  const pdfUrl =
    href((link) => link['@_title'] === 'pdf') ??
    href((link) => asText(link['@_type']) === 'application/pdf');

  const authors = asRecords(entry['author'])
    .map((author) => tidy(asText(author['name'])))
    .filter((name): name is string => name !== undefined);

  const primary =
    asText(recordOf(entry['arxiv:primary_category'])?.['@_term']) ??
    asRecords(entry['category']).map((category) => asText(category['@_term'])).find((term) => term !== undefined);

  const published = tidy(asText(entry['published']))?.slice(0, 10);
  const abstract = tidy(asText(entry['summary']));

  return {
    id: `arxiv:${arxivId}`,
    title,
    authors,
    ...(published !== undefined ? { published } : {}),
    venue: primary !== undefined ? `arXiv ${primary}` : 'arXiv',
    url,
    ...(pdfUrl !== undefined ? { pdfUrl } : {}),
    arxivId,
    ...(abstract !== undefined ? { abstract } : {}),
    source: ARXIV_SOURCE_NAME,
  };
}

export class ArxivPaperSource {
  readonly name = ARXIV_SOURCE_NAME;

  constructor(
    private readonly throttle: ReturnType<typeof createSourceThrottle> = createSourceThrottle(
      ARXIV_SOURCE_INTERVAL_MS,
    ),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Exposed for tests and diagnostics: the exact request URL for a query. */
  buildUrl(query: string, options: PaperSearchOptions = {}, broad = false): string {
    const params = new URLSearchParams({
      search_query: broad ? buildArxivBroadQuery(query, options) : buildArxivQuery(query, options),
      start: '0',
      max_results: String(options.limit ?? 5),
      sortBy: options.sort === 'date' ? 'submittedDate' : 'relevance',
      sortOrder: 'descending',
    });
    return `${ENDPOINT}?${params.toString()}`;
  }

  async search(query: string, options: PaperSearchOptions = {}): Promise<PaperSearchResult[]> {
    // A query with no searchable terms would be sent as `all:""`, which arXiv
    // answers with the whole corpus instead of an error.
    if (queryWords(query).length === 0) return [];

    const strict = await this.request(this.buildUrl(query, options), options);
    if (strict.length > 0) return strict;
    // Nothing matched the precise phrase — buy recall with one broad request
    // (throttled to 3s apart, so it only ever costs that when it is needed).
    return this.request(this.buildUrl(query, options, true), options);
  }

  private async request(url: string, options: PaperSearchOptions): Promise<PaperSearchResult[]> {
    await this.throttle.acquire();
    const response = await this.fetchFn(url, {
      headers: { 'user-agent': PAPER_USER_AGENT, accept: 'application/atom+xml' },
      signal: withHardTimeout(options.signal),
    });
    if (!response.ok) {
      throw new Error(`arXiv responded with HTTP ${String(response.status)}`);
    }

    const xml = await response.text();
    const parsed: unknown = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
      isArray: (name) => name === 'entry' || name === 'author' || name === 'link' || name === 'category',
    }).parse(xml);

    const feed = recordOf((parsed as { feed?: unknown }).feed);
    return asRecords(feed?.['entry'])
      .map((entry) => parseEntry(entry))
      .filter((entry): entry is PaperSearchResult => entry !== undefined);
  }
}
