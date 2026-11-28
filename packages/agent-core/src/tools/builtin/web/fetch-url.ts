/**
 * FetchURLTool — host-injected URL fetcher.
 *
 * scream-core defines the interface; the host provides the real fetch
 * implementation via `UrlFetcher`. If no fetcher is supplied, the tool
 * should not be registered (not exposed to the LLM).
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { persistToolOutput, previewOf, type PersistOutput } from '../../support/persist-output';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './fetch-url.md';

// ── Provider interface (host-injected) ───────────────────────────────

/**
 * How the returned content relates to the original response body.
 *
 * - `passthrough` — the body was already plain text / markdown and is
 *   returned verbatim, in full.
 * - `extracted` — the body was an HTML page; only the main article text
 *   was extracted and returned.
 */
export type UrlFetchKind = 'passthrough' | 'extracted';

export interface UrlFetchResult {
  /** The text handed to the LLM. */
  content: string;
  /** Whether `content` is a verbatim passthrough or extracted main text. */
  kind: UrlFetchKind;
}

export interface UrlFetcher {
  fetch(url: string, options?: { toolCallId?: string }): Promise<UrlFetchResult>;
}

/**
 * Thrown by a `UrlFetcher` when the upstream HTTP request completed but
 * returned a non-success status. The tool branches on this to surface
 * `Status: N` in the error message; non-HTTP failures (DNS, timeout,
 * connection reset, …) keep flowing through as plain `Error`.
 */
export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ── Input schema ─────────────────────────────────────────────────────

export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
  question: z
    .string()
    .optional()
    .describe(
      'What you want to know from the page. When set, a helper model reads the page and only its answer comes back, which keeps a long page out of your context. Omit it to get the page text itself.',
    ),
});

export type FetchURLInput = z.Infer<typeof FetchURLInputSchema>;

/** Answers a question from a page (the agent's helper model). */
export type PageAnswerer = (request: {
  readonly url: string;
  readonly question: string;
  readonly content: string;
  readonly signal?: AbortSignal | undefined;
}) => Promise<string>;

export interface FetchURLOptions {
  /** Answers `question`; without it the question is ignored and the page text comes back. */
  readonly answer?: PageAnswerer | undefined;
  /** Where a long page is saved; defaults to a private temp file. */
  readonly persist?: PersistOutput | undefined;
}

/** A page shorter than this is returned as it is even with a question: asking a helper costs more than it saves. */
export const PAGE_ANSWER_MIN_CHARS = 4_000;
/** Page text beyond this is not put in the context: the whole page is saved and the start comes back with the path. */
export const FETCH_INLINE_CHARS = 30_000;

// ── Implementation ───────────────────────────────────────────────────

export class FetchURLTool implements BuiltinTool<FetchURLInput> {
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);
  private readonly answer: PageAnswerer | undefined;
  private readonly persist: PersistOutput;

  constructor(
    private readonly fetcher: UrlFetcher,
    options: FetchURLOptions = {},
  ) {
    this.answer = options.answer;
    this.persist = options.persist ?? ((text) => persistToolOutput('fetch', text));
  }

  /** Save the page; undefined when it cannot be written (the caller then keeps the old behaviour). */
  private async save(content: string): Promise<string | undefined> {
    try {
      return await this.persist(content);
    } catch {
      return undefined;
    }
  }

  resolveExecution(args: FetchURLInput): ToolExecution {
    const preview = args.url.length > 50 ? `${args.url.slice(0, 50)}…` : args.url;
    return {
      accesses: ToolAccesses.none(),
      description: `Fetching: ${preview}`,
      display: { kind: 'url_fetch', url: args.url },
      approvalRule: literalRulePattern(this.name, args.url),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.url),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: FetchURLInput,
    {
    toolCallId,
    signal,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const { content, kind } = await this.fetcher.fetch(args.url, { toolCallId });

      if (!content) {
        return {
          output: 'The response body is empty.',
          isError: false,
        };
      }

      // A question about a long page: a helper model reads it and only the
      // answer enters the context. The page is saved too, so the model can
      // read on if the answer is not enough. A failed answer falls back to
      // the page text below.
      const question = args.question?.trim();
      if (question !== undefined && question.length > 0 && this.answer !== undefined && content.length >= PAGE_ANSWER_MIN_CHARS) {
        try {
          const answer = await this.answer({ url: args.url, question, content, signal });
          if (answer.length > 0) {
            const path = await this.save(content);
            const where =
              path === undefined
                ? ''
                : ` The full page text (${String(content.length)} characters) is saved to ${path}; read it with the Read tool if you need more.`;
            return { isError: false, output: `${answer}\n\n[Answered from ${args.url} by a helper model that read the page.${where}]` };
          }
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }

      // A long page: the start comes back, the whole page is saved.
      if (content.length > FETCH_INLINE_CHARS) {
        const path = await this.save(content);
        if (path !== undefined) {
          const note =
            kind === 'passthrough' ? 'the full response body' : 'the main text extracted from the page';
          return {
            isError: false,
            output:
              `${previewOf(content, FETCH_INLINE_CHARS)}\n\n[This is the first ${String(FETCH_INLINE_CHARS)} of ` +
              `${String(content.length)} characters of ${note}. The whole text is saved to ${path}; read the rest ` +
              `with the Read tool (line_offset / n_lines), or fetch again with a question to get just the answer.]`,
          };
        }
      }

      const builder = new ToolResultBuilder({ maxLineBytes: null });
      builder.write(content);
      // Tell the LLM whether it received the whole body or only the
      // extracted article text, so it can judge how complete the
      // content is.
      const message =
        kind === 'passthrough'
          ? 'The returned content is the full response body, returned verbatim.'
          : 'The returned content is the main text extracted from the page.';
      return await builder.ok(message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpFetchError) {
        return {
          isError: true,
          output: `Failed to fetch URL. Status: ${String(error.status)}. ${msg}`,
        };
      }
      return {
        isError: true,
        output: `Failed to fetch URL due to network error: ${args.url}. ${msg}`,
      };
    }
  }

}
