/**
 * PaperFanoutProvider — queries every paper source in parallel and merges.
 *
 * Why fan-out instead of the web search's serial fallback chain: literature
 * backends are complementary rather than redundant (arXiv holds preprints,
 * Crossref the published record, OpenAlex the cross-discipline catalogue,
 * Europe PMC the life sciences), so the union is more useful than the first
 * non-empty answer — and running them concurrently costs the slowest source
 * (measured ~1.6s) instead of the sum.
 *
 * Failure policy: a source that throws is recorded, not fatal. The caller gets
 * whatever the healthy sources returned plus the reasons the others are
 * missing, so a rate-limited or blocked backend degrades the answer instead of
 * erasing it. Only when *every* source fails does the call throw — with all
 * reasons aggregated, so "nothing happened" is never indistinguishable from
 * "everything broke".
 *
 * User cancellation (`options.signal`) aborts the whole fan-out immediately and
 * is never reported as a source failure.
 */

import type {
  PaperSearchFailure,
  PaperSearchOptions,
  PaperSearchProvider,
  PaperSearchResponse,
  PaperSearchResult,
  PaperSource,
} from '../../builtin/web/paper-search';

/** Total wall-clock budget shared by all sources in one search. */
export const PAPER_CHAIN_BUDGET_MS = 20_000;

/** Minimum normalized title length before it may act as a dedupe key. */
const TITLE_DEDUPE_MIN_LENGTH = 24;

export interface PaperFanoutOptions {
  /** Override the shared budget (tests, advanced tuning). */
  totalBudgetMs?: number;
}

/** `10.1145/…` and `https://doi.org/10.1145/…` must collapse to one key. */
function normalizeDoi(doi: string): string {
  return doi.replace(/^https?:\/\/doi\.org\//i, '').trim().toLowerCase();
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Dedupe keys for one record, strongest first. Short titles are deliberately
 * excluded from title-based merging: a two-word title ("Editorial") matches too
 * much, and showing a duplicate is cheaper than dropping a real paper.
 */
function dedupeKeys(result: PaperSearchResult): string[] {
  const keys: string[] = [];
  if (result.doi !== undefined) keys.push(`doi:${normalizeDoi(result.doi)}`);
  if (result.arxivId !== undefined) keys.push(`arxiv:${result.arxivId.replace(/v\d+$/, '')}`);
  const title = normalizeTitle(result.title);
  if (title.length >= TITLE_DEDUPE_MIN_LENGTH) keys.push(`title:${title}`);
  return keys;
}

/** Keep the first record per identity, preserving the incoming order. */
export function dedupePaperResults(results: readonly PaperSearchResult[]): PaperSearchResult[] {
  const seen = new Set<string>();
  const kept: PaperSearchResult[] = [];
  for (const result of results) {
    const keys = dedupeKeys(result);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    kept.push(result);
  }
  return kept;
}

/** Newest first; records without a date sort last. */
function sortByDateDesc(results: readonly PaperSearchResult[]): PaperSearchResult[] {
  return results.toSorted((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
}

/**
 * Round-robin the per-source lists.
 *
 * Concatenating in source order and then slicing would let the first source
 * fill the whole answer — with default `relevance`, arXiv returning `limit`
 * records would silently discard every Crossref/OpenAlex/Europe PMC result that
 * was already fetched. Interleaving keeps the slice representative of every
 * backend that answered.
 */
export function interleaveSources(lists: readonly (readonly PaperSearchResult[])[]): PaperSearchResult[] {
  const interleaved: PaperSearchResult[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const result = list[index];
      if (result !== undefined) interleaved.push(result);
    }
  }
  return interleaved;
}

/** Keep the error class visible: aggregation must not erase TimeoutError vs AbortError. */
function describeFailure(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.name === 'Error' ? reason.message : `${reason.name}: ${reason.message}`;
  }
  return typeof reason === 'string' ? reason : 'Unknown failure';
}

export class PaperFanoutProvider implements PaperSearchProvider {
  private readonly sources: readonly PaperSource[];
  private readonly totalBudgetMs: number;

  constructor(sources: readonly PaperSource[], options: PaperFanoutOptions = {}) {
    if (sources.length === 0) {
      throw new Error('PaperFanoutProvider requires at least one source');
    }
    this.sources = sources;
    this.totalBudgetMs = options.totalBudgetMs ?? PAPER_CHAIN_BUDGET_MS;
  }

  /** Names of the configured sources, in priority order (tests/diagnostics). */
  get sourceNames(): string[] {
    return this.sources.map((source) => source.name);
  }

  async search(query: string, options: PaperSearchOptions = {}): Promise<PaperSearchResponse> {
    // Quotes/whitespace normalize away to no search terms at all, and arXiv
    // answers `all:""` with the entire corpus — which then looks like a real
    // match. Refuse before spending a request on it.
    if (query.replaceAll(/["\s]/g, '').length === 0) {
      throw new Error('Paper search requires a non-empty query');
    }
    const selected =
      options.sources === undefined || options.sources.length === 0
        ? this.sources
        : this.sources.filter((source) => options.sources?.includes(source.name));
    if (selected.length === 0) {
      throw new Error(
        `Unknown paper source(s): ${options.sources?.join(', ') ?? ''} — known sources: ${this.sourceNames.join(', ')}`,
      );
    }

    const deadline = Date.now() + this.totalBudgetMs;
    options.signal?.throwIfAborted();

    const outcomes = await Promise.allSettled(
      selected.map((source) => {
        // Each attempt is bounded by the remaining shared budget, composed with
        // the caller's signal, so one stalled source cannot outlive the call.
        const remaining = Math.max(deadline - Date.now(), 1);
        const attemptSignal =
          options.signal !== undefined
            ? AbortSignal.any([options.signal, AbortSignal.timeout(remaining)])
            : AbortSignal.timeout(remaining);
        return source.search(query, { ...options, signal: attemptSignal });
      }),
    );

    const failures: PaperSearchFailure[] = [];
    const perSource: PaperSearchResult[][] = [];
    for (const [index, outcome] of outcomes.entries()) {
      const source = selected[index];
      if (source === undefined) continue;
      if (outcome.status === 'fulfilled') {
        perSource.push(outcome.value);
        continue;
      }
      // Esc during the request: surface cancellation, never a fake failure.
      options.signal?.throwIfAborted();
      failures.push({ source: source.name, reason: describeFailure(outcome.reason) });
    }

    if (failures.length === selected.length) {
      const summary = failures.map((failure) => `${failure.source}: ${failure.reason}`).join('; ');
      throw new Error(`All paper sources failed — ${summary}`);
    }

    const deduped = dedupePaperResults(interleaveSources(perSource));
    const ordered = options.sort === 'date' ? sortByDateDesc(deduped) : deduped;
    const limit = options.limit ?? 5;
    return { results: ordered.slice(0, limit), failures };
  }
}
