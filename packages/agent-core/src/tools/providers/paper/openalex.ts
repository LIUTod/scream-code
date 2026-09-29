/**
 * OpenAlex paper source — the open scholarly catalogue (works endpoint).
 *
 * No key is required, but anonymous search is rate-limited by the service
 * itself (HTTP 429 with a `retryAfter` hint) when its cluster is under load;
 * that case is surfaced as a source failure so the other sources still answer
 * and the reason reaches the user instead of vanishing. Only metadata is read.
 */

import type { PaperSearchOptions, PaperSearchResult } from '../../builtin/web/paper-search';
import { withHardTimeout } from '../search-timeout';
import { PAPER_USER_AGENT } from './arxiv';
import { createSourceThrottle } from './throttle';

const ENDPOINT = 'https://api.openalex.org/works';
export const OPENALEX_SOURCE_NAME = 'openalex';

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function tidy(value: string | undefined): string | undefined {
  const collapsed = value?.replaceAll(/\s+/g, ' ').trim();
  return collapsed !== undefined && collapsed.length > 0 ? collapsed : undefined;
}

/** Rebuild plain text from OpenAlex's `{word: [positions]}` abstract form. */
export function rebuildAbstract(inverted: unknown): string | undefined {
  const index = recordOf(inverted);
  if (index === undefined) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === 'number') words[position] = word;
    }
  }
  const text = words.filter((word) => word !== undefined).join(' ');
  return tidy(text);
}

function bareDoi(doi: string | undefined): string | undefined {
  return doi?.replace(/^https?:\/\/doi\.org\//i, '').trim().toLowerCase();
}

function parseWork(work: Record<string, unknown>): PaperSearchResult | undefined {
  const title = tidy(asText(work['title']) ?? asText(work['display_name']));
  const id = asText(work['id']);
  if (title === undefined || id === undefined) return undefined;

  const authors = (Array.isArray(work['authorships']) ? work['authorships'] : [])
    .map((authorship) => tidy(asText(recordOf(recordOf(authorship)?.['author'])?.['display_name'])))
    .filter((name): name is string => name !== undefined);

  const location = recordOf(work['primary_location']);
  const venue = tidy(asText(recordOf(location?.['source'])?.['display_name']));
  const pdfUrl = tidy(asText(location?.['pdf_url']));
  const doi = bareDoi(asText(work['doi']));
  const landingPage = tidy(asText(location?.['landing_page_url']));
  // Fall back to the DOI resolver — never to a path built from a bare DOI,
  // which would resolve to a nonsense openalex.org URL.
  const url = landingPage ?? (doi !== undefined ? `https://doi.org/${doi}` : id);

  const published = tidy(asText(work['publication_date']))?.slice(0, 10);
  const abstract = rebuildAbstract(work['abstract_inverted_index']);
  const citations = typeof work['cited_by_count'] === 'number' ? work['cited_by_count'] : undefined;

  return {
    id: `openalex:${id}`,
    title,
    authors,
    ...(published !== undefined ? { published } : {}),
    ...(venue !== undefined ? { venue } : {}),
    url,
    ...(pdfUrl !== undefined ? { pdfUrl } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(abstract !== undefined ? { abstract } : {}),
    ...(citations !== undefined ? { citations } : {}),
    source: OPENALEX_SOURCE_NAME,
  };
}

export class OpenAlexPaperSource {
  readonly name = OPENALEX_SOURCE_NAME;

  constructor(
    private readonly throttle: ReturnType<typeof createSourceThrottle> = createSourceThrottle(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Exposed for tests and diagnostics: the exact request URL for a query. */
  buildUrl(query: string, options: PaperSearchOptions = {}): string {
    const params = new URLSearchParams({
      search: query,
      'per-page': String(options.limit ?? 5),
      sort: options.sort === 'date' ? 'publication_date:desc' : 'relevance_score:desc',
    });
    if (options.yearFrom !== undefined) {
      params.set('filter', `from_publication_date:${String(options.yearFrom)}-01-01`);
    }
    return `${ENDPOINT}?${params.toString()}`;
  }

  async search(query: string, options: PaperSearchOptions = {}): Promise<PaperSearchResult[]> {
    await this.throttle.acquire();
    const response = await this.fetchFn(this.buildUrl(query, options), {
      headers: { 'user-agent': PAPER_USER_AGENT, accept: 'application/json' },
      signal: withHardTimeout(options.signal),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const retryAfter = asText(recordOf(body)?.['retryAfter']);
      const hint =
        response.status === 429
          ? ` — anonymous access is rate limited${retryAfter !== undefined ? `, retry in ${retryAfter}s` : ''}; a free API key removes the limit`
          : '';
      throw new Error(`OpenAlex responded with HTTP ${String(response.status)}${hint}`);
    }

    const payload: unknown = await response.json();
    const results = (recordOf(payload)?.['results'] ?? []) as unknown;
    if (!Array.isArray(results)) return [];
    return results
      .map((work) => recordOf(work))
      .filter((work): work is Record<string, unknown> => work !== undefined)
      .map((work) => parseWork(work))
      .filter((work): work is PaperSearchResult => work !== undefined);
  }
}
