/**
 * Europe PMC paper source — life-sciences literature (MEDLINE/PubMed,
 * PMC full text, Agricola, and preprints) behind one search endpoint.
 *
 * Chosen over calling PubMed's E-utilities directly: one request returns the
 * abstract and citation count, where PubMed needs an esearch + esummary round
 * trip for the same data, and Europe PMC additionally indexes preprints and
 * patents. No key required, polite use assumed; metadata only.
 */

import type { PaperSearchOptions, PaperSearchResult } from '../../builtin/web/paper-search';
import { withHardTimeout } from '../search-timeout';
import { PAPER_USER_AGENT } from './arxiv';
import { createSourceThrottle } from './throttle';

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
export const EUROPEPMC_SOURCE_NAME = 'europepmc';

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

/** `"Smith A, Doe B."` → `["Smith A", "Doe B"]` (Europe PMC has no author list here). */
export function splitAuthorString(value: string | undefined): string[] {
  // The trailing full stop belongs to the sentence, not to the last author.
  const text = tidy(value)?.replace(/\.$/, '');
  if (text === undefined) return [];
  return text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function parseResult(result: Record<string, unknown>): PaperSearchResult | undefined {
  const title = tidy(asText(result['title']));
  const id = tidy(asText(result['id']));
  if (title === undefined || id === undefined) return undefined;

  const source = tidy(asText(result['source'])) ?? 'MED';
  const doi = tidy(asText(result['doi']))?.toLowerCase();
  const urls = (recordOf(result['fullTextUrlList'])?.['fullTextUrl'] ?? []) as unknown;
  const urlList = (Array.isArray(urls) ? urls : []).map((entry) => recordOf(entry)).filter((e) => e !== undefined);
  const pdfUrl = urlList
    .map((entry) => ({ style: tidy(asText(entry['documentStyle'])), url: tidy(asText(entry['url'])) }))
    .find((entry) => entry.url !== undefined && (entry.style === 'pdf' || /\.pdf($|\?)/i.test(entry.url)))?.url;

  const url = doi !== undefined ? `https://doi.org/${doi}` : `https://europepmc.org/article/${source}/${id}`;
  const published = tidy(asText(result['firstPublicationDate']))?.slice(0, 10);
  const venue = tidy(asText(result['journalTitle']));
  const abstract = tidy(asText(result['abstractText']));
  const citations = typeof result['citedByCount'] === 'number' ? result['citedByCount'] : undefined;

  return {
    id: `europepmc:${id}`,
    title,
    authors: splitAuthorString(asText(result['authorString'])),
    ...(published !== undefined ? { published } : {}),
    ...(venue !== undefined ? { venue } : {}),
    url,
    ...(pdfUrl !== undefined ? { pdfUrl } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(abstract !== undefined ? { abstract } : {}),
    ...(citations !== undefined ? { citations } : {}),
    source: EUROPEPMC_SOURCE_NAME,
  };
}

export class EuropePmcPaperSource {
  readonly name = EUROPEPMC_SOURCE_NAME;

  constructor(
    private readonly throttle: ReturnType<typeof createSourceThrottle> = createSourceThrottle(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Exposed for tests and diagnostics: the exact request URL for a query. */
  buildUrl(query: string, options: PaperSearchOptions = {}): string {
    const terms = [`(${query.trim()})`];
    if (options.yearFrom !== undefined) terms.push(`(PUB_YEAR:[${String(options.yearFrom)} TO 3000])`);
    const params = new URLSearchParams({
      query: terms.join(' AND '),
      format: 'json',
      pageSize: String(options.limit ?? 5),
      resultType: 'core',
      sort: options.sort === 'date' ? 'P_PDATE_D desc' : 'CITED desc',
    });
    return `${ENDPOINT}?${params.toString()}`;
  }

  async search(query: string, options: PaperSearchOptions = {}): Promise<PaperSearchResult[]> {
    await this.throttle.acquire();
    const response = await this.fetchFn(this.buildUrl(query, options), {
      headers: { 'user-agent': PAPER_USER_AGENT, accept: 'application/json' },
      signal: withHardTimeout(options.signal),
    });
    if (!response.ok) {
      throw new Error(`Europe PMC responded with HTTP ${String(response.status)}`);
    }

    const payload: unknown = await response.json();
    const results = recordOf(recordOf(payload)?.['resultList'])?.['result'];
    if (!Array.isArray(results)) return [];
    return results
      .map((result) => recordOf(result))
      .filter((result): result is Record<string, unknown> => result !== undefined)
      .map((result) => parseResult(result))
      .filter((result): result is PaperSearchResult => result !== undefined);
  }
}
