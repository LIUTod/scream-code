/**
 * PaperSearchTool — host-injected academic literature search.
 *
 * scream-core defines the interface; the host supplies the implementation
 * (the default runtime fans out across arXiv, OpenAlex, Crossref and Europe
 * PMC). If no provider is supplied the tool is not registered.
 *
 * The tool returns metadata and links only: full texts are never downloaded,
 * cached or redistributed here — the caller opens a paper with `FetchURL`
 * when it actually needs the body.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './paper-search.md';

// ── Provider interface (host-injected) ───────────────────────────────

export interface PaperSearchResult {
  /** Source-scoped stable id, e.g. `arxiv:2405.00001` or `doi:10.1145/…`. */
  id: string;
  title: string;
  authors: string[];
  /** Publication date as `YYYY-MM-DD` (partial dates keep the known part). */
  published?: string | undefined;
  /** Journal, conference or repository label. */
  venue?: string | undefined;
  /** Landing page to hand to `FetchURL`. */
  url: string;
  pdfUrl?: string | undefined;
  doi?: string | undefined;
  arxivId?: string | undefined;
  abstract?: string | undefined;
  citations?: number | undefined;
  /** Which source produced this record. */
  source: string;
}

export interface PaperSearchFailure {
  source: string;
  reason: string;
}

export interface PaperSearchResponse {
  results: PaperSearchResult[];
  /** Sources that could not be queried — reported, never fatal on their own. */
  failures: PaperSearchFailure[];
}

export interface PaperSearchOptions {
  limit?: number;
  sort?: 'relevance' | 'date';
  /** arXiv category filter (e.g. `cs.AI`); other sources ignore it. */
  category?: string;
  yearFrom?: number;
  /** Restrict the query to a subset of sources, by name. */
  sources?: readonly string[];
  signal?: AbortSignal;
}

/** A single literature backend (arXiv, OpenAlex, …). Throws on transport failure. */
export interface PaperSource {
  readonly name: string;
  search(query: string, options?: PaperSearchOptions): Promise<PaperSearchResult[]>;
}

/** The search facade the tool talks to — the runtime supplies the fan-out. */
export interface PaperSearchProvider {
  /** Short identifier used in failure summaries. */
  readonly name?: string | undefined;
  search(query: string, options?: PaperSearchOptions): Promise<PaperSearchResponse>;
}

// ── Input schema ─────────────────────────────────────────────────────

export const PaperSearchInputSchema = z.object({
  query: z.string().describe('The research topic to search for, phrased with the field\'s own vocabulary.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe(
      'Number of papers to return after merging all sources. Raise it when you need breadth, then refine the query rather than paging.',
    )
    .optional(),
  sort: z
    .enum(['relevance', 'date'])
    .default('relevance')
    .describe("'relevance' (default) keeps each source's ranking; 'date' puts the newest work first.")
    .optional(),
  category: z
    .string()
    .describe('Optional arXiv category filter such as cs.AI, cs.CL or stat.ML. Other sources ignore it.')
    .optional(),
  year_from: z.number().int().min(1900).describe('Only return work published in this year or later.').optional(),
  sources: z
    .array(z.enum(['arxiv', 'openalex', 'crossref', 'europepmc']))
    .describe('Optional subset of sources to query. Omit unless a source keeps failing and you want it excluded.')
    .optional(),
});

export type PaperSearchInput = z.Infer<typeof PaperSearchInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

/** Abstract excerpt ceiling — enough to judge relevance without flooding tokens. */
const ABSTRACT_LIMIT = 600;

/**
 * Author ceiling. Mega-collaboration papers carry author strings of tens of
 * thousands of characters (measured live), which would dwarf the abstract the
 * excerpt cap exists to protect.
 */
const AUTHOR_LIMIT = 10;

export class PaperSearchTool implements BuiltinTool<PaperSearchInput> {
  readonly name = 'PaperSearch' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PaperSearchInputSchema);
  constructor(private readonly provider: PaperSearchProvider) {}

  resolveExecution(args: PaperSearchInput): ToolExecution {
    const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
    return {
      accesses: ToolAccesses.none(),
      description: `Searching papers: ${preview}`,
      display: { kind: 'search', query: args.query },
      approvalRule: literalRulePattern(this.name, args.query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.query),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: PaperSearchInput,
    { signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const options: PaperSearchOptions = { signal };
      if (args.limit !== undefined) options.limit = args.limit;
      if (args.sort !== undefined) options.sort = args.sort;
      if (args.category !== undefined) options.category = args.category;
      if (args.year_from !== undefined) options.yearFrom = args.year_from;
      if (args.sources !== undefined) options.sources = args.sources;

      const { results, failures } = await this.provider.search(args.query, options);
      const builder = new ToolResultBuilder({ maxLineLength: null });

      if (results.length === 0) {
        builder.write('No papers found.');
      } else {
        let first = true;
        for (const result of results) {
          if (!first) builder.write('---\n\n');
          first = false;
          builder.write(`Source: ${result.source}\n`);
          builder.write(`Title: ${result.title}\n`);
          if (result.authors.length > 0) {
            const suffix = result.authors.length > AUTHOR_LIMIT ? ', et al.' : '';
            builder.write(`Authors: ${result.authors.slice(0, AUTHOR_LIMIT).join(', ')}${suffix}\n`);
          }
          if (result.published !== undefined) builder.write(`Published: ${result.published}\n`);
          if (result.venue !== undefined) builder.write(`Venue: ${result.venue}\n`);
          if (result.doi !== undefined) builder.write(`DOI: ${result.doi}\n`);
          if (result.arxivId !== undefined) builder.write(`arXiv: ${result.arxivId}\n`);
          if (result.citations !== undefined) builder.write(`Citations: ${String(result.citations)}\n`);
          builder.write(`URL: ${result.url}\n`);
          if (result.pdfUrl !== undefined) builder.write(`PDF: ${result.pdfUrl}\n`);
          if (result.abstract !== undefined) {
            const excerpt =
              result.abstract.length > ABSTRACT_LIMIT
                ? `${result.abstract.slice(0, ABSTRACT_LIMIT)}…`
                : result.abstract;
            builder.write(`Abstract: ${excerpt}\n`);
          }
          builder.write('\n');
        }
      }

      // A partial answer is normal: say which sources did not answer so the
      // gap is visible instead of silently shrinking the result set.
      if (failures.length > 0) {
        const notes = failures.map((failure) => `${failure.source}: ${failure.reason}`).join('; ');
        builder.write(`\nNote: ${String(failures.length)} source(s) could not be queried — ${notes}\n`);
      }

      return await builder.ok();
    } catch (error) {
      return {
        isError: true,
        output: classifyPaperSearchError(error),
      };
    }
  }
}

// ── Error classification ─────────────────────────────────────────────

/**
 * Maps a thrown search error to a categorised, human-readable message. The
 * original text is preserved so the underlying detail is never lost; the prefix
 * only adds a category the model can act on (retry vs. report vs. reconfigure).
 */
function classifyPaperSearchError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // The error *class* is the reliable discriminator and must win over wording:
  // `AbortSignal.timeout()` reports TimeoutError, a user cancellation reports
  // AbortError, and an upstream grace-timeout cancellation reports AbortError
  // with "timeout" in its message. Message heuristics only apply without a name.
  if (name === 'TimeoutError') {
    return `Paper search timed out: ${message}`;
  }
  if (name === 'AbortError') {
    return `Paper search cancelled: ${message}`;
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return `Paper search timed out: ${message}`;
  }
  if (lower.includes('abort')) {
    return `Paper search cancelled: ${message}`;
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return `Paper search rate limited: ${message}`;
  }
  if (/\bhttp \d{3}\b/.test(lower)) {
    // The service answered — this is its error, not a connectivity problem.
    return `Paper search service error: ${message}`;
  }
  if (lower.includes('network') || lower.includes('fetch') || name === 'TypeError') {
    return `Paper search failed (network): ${message}`;
  }
  return `Paper search failed: ${message}`;
}
