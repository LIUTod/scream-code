/**
 * Crossref paper source — the DOI registration agency's works index.
 *
 * Covers formally published records across every discipline (journals, books,
 * proceedings, preprints), which is exactly the half arXiv is weak at. No key
 * is required; the API is documented as polite-use, so the shared throttle
 * keeps requests at one per second. Only metadata is read.
 */

import type { PaperSearchOptions, PaperSearchResult } from '../../builtin/web/paper-search';
import { withHardTimeout } from '../search-timeout';
import { PAPER_USER_AGENT } from './arxiv';
import { createSourceThrottle } from './throttle';

const ENDPOINT = 'https://api.crossref.org/works';
export const CROSSREF_SOURCE_NAME = 'crossref';

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

/** Crossref abstracts are JATS fragments; strip tags and collapse whitespace. */
export function stripJats(xml: string | undefined): string | undefined {
  return tidy(xml?.replaceAll(/<[^>]*>/g, ' '));
}

/** `{date-parts: [[2026, 7, 14]]}` → `2026-07-14`; partial dates keep what is known. */
export function formatDateParts(value: unknown): string | undefined {
  const parts = recordOf(value)?.['date-parts'];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const [year, month, day] = parts[0] as unknown[];
  if (typeof year !== 'number') return undefined;
  const pad = (part: unknown): string | undefined =>
    typeof part === 'number' ? String(part).padStart(2, '0') : undefined;
  // Never invent month/day: a year-only record prints `2026`, not `2026-00-00`.
  return [String(year), pad(month), pad(day)].filter((piece): piece is string => piece !== undefined).join('-');
}

function parseItem(item: Record<string, unknown>): PaperSearchResult | undefined {
  const title = tidy(Array.isArray(item['title']) ? asText(item['title'][0]) : asText(item['title']));
  const doi = tidy(asText(item['DOI']))?.toLowerCase();
  if (title === undefined && doi === undefined) return undefined;

  const authors = (Array.isArray(item['author']) ? item['author'] : [])
    .map((author) => {
      const record = recordOf(author);
      const given = tidy(asText(record?.['given']));
      const family = tidy(asText(record?.['family']));
      return tidy([given, family].filter((part) => part !== undefined).join(' ')) ?? tidy(asText(record?.['name']));
    })
    .filter((name): name is string => name !== undefined);

  const venue = tidy(Array.isArray(item['container-title']) ? asText(item['container-title'][0]) : undefined);
  const published = formatDateParts(item['published']) ?? formatDateParts(item['issued']);
  const abstract = stripJats(asText(item['abstract']));
  const citations = typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : undefined;
  const pdfLink = (Array.isArray(item['link']) ? item['link'] : [])
    .map((link) => tidy(asText(recordOf(link)?.['URL'])))
    .find((url) => url !== undefined && /\.pdf($|\?)/i.test(url));
  const url = tidy(asText(item['URL'])) ?? (doi !== undefined ? `https://doi.org/${doi}` : undefined);
  if (url === undefined) return undefined;

  return {
    id: doi !== undefined ? `doi:${doi}` : `crossref:${url}`,
    title: title ?? doi ?? 'Untitled',
    authors,
    ...(published !== undefined ? { published } : {}),
    ...(venue !== undefined ? { venue } : {}),
    url,
    ...(pdfLink !== undefined ? { pdfUrl: pdfLink } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(abstract !== undefined ? { abstract } : {}),
    ...(citations !== undefined ? { citations } : {}),
    source: CROSSREF_SOURCE_NAME,
  };
}

export class CrossrefPaperSource {
  readonly name = CROSSREF_SOURCE_NAME;

  constructor(
    private readonly throttle: ReturnType<typeof createSourceThrottle> = createSourceThrottle(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Exposed for tests and diagnostics: the exact request URL for a query. */
  buildUrl(query: string, options: PaperSearchOptions = {}): string {
    const params = new URLSearchParams({
      query,
      rows: String(options.limit ?? 5),
      sort: options.sort === 'date' ? 'published' : 'relevance',
      order: 'desc',
    });
    if (options.yearFrom !== undefined) {
      params.set('filter', `from-pub-date:${String(options.yearFrom)}-01-01`);
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
      throw new Error(`Crossref responded with HTTP ${String(response.status)}`);
    }

    const payload: unknown = await response.json();
    const items = recordOf(recordOf(payload)?.['message'])?.['items'];
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => recordOf(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => parseItem(item))
      .filter((item): item is PaperSearchResult => item !== undefined);
  }
}
