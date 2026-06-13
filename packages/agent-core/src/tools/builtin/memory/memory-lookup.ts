import { rankMemos, toSummary, type MemoryMemoSummary } from '@scream-code/memory';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_MIN_SCORE = 0.2;

export const MemoryLookupInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Search query describing the current task, error, approach, or keywords to look up in the global memory memo store.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum number of memos to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(`Minimum relevance score threshold from 0 to 1 (default ${DEFAULT_MIN_SCORE}).`),
});

export type MemoryLookupInput = z.infer<typeof MemoryLookupInputSchema>;

/**
 * Lets the model actively search the global memory memo store for historical
 * task experiences. Returns ranked memos with what failed and what worked so
 * the model can avoid repeating past mistakes or rediscovering known solutions.
 */
export class MemoryLookupTool implements BuiltinTool<MemoryLookupInput> {
  readonly name = 'MemoryLookup' as const;
  readonly description =
    'Search the global memory memo store for historical experiences from past user tasks. ' +
    'Call this when the current task may benefit from prior work, when you encounter a ' +
    'repeating error or pattern, or when you are unsure of the best approach. ' +
    'Returns memos ranked by relevance, including the approach taken, the outcome, ' +
    'what failed, and what worked.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryLookupInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MemoryLookupInput): ToolExecution {
    return {
      description: 'Searching memory memos',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        const query = args.query.trim();
        if (query.length === 0) {
          return { isError: true, output: 'Query cannot be empty.' };
        }

        const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
        const minScore = args.min_score ?? DEFAULT_MIN_SCORE;

        const all: MemoryMemoSummary[] = [];
        for await (const memo of store.read()) {
          all.push(toSummary(memo));
        }

        if (all.length === 0) {
          return { isError: false, output: 'No memory memos found. The experience store is empty.' };
        }

        const ranked = rankMemos(all, query, minScore, limit);
        if (ranked.length === 0) {
          return {
            isError: false,
            output: `No relevant memory memos found for query "${query}".`,
          };
        }

        const lines = [
          `Found ${ranked.length} relevant memory memo${ranked.length === 1 ? '' : 's'} for query "${query}":`,
          '',
        ];

        for (const [i, { memo, score }] of ranked.entries()) {
          const source = memo.sourceSessionTitle?.length
            ? ` (from: ${memo.sourceSessionTitle})`
            : '';
          lines.push(
            `**${i + 1}. ${memo.userNeed}${source}**`,
            `  Score: ${score.toFixed(3)}`,
            `  Approach: ${memo.approach}`,
            `  Outcome: ${memo.outcome}`,
            ...(memo.whatFailed !== 'none' ? [`  What failed: ${memo.whatFailed}`] : []),
            ...(memo.whatWorked !== 'none' ? [`  What worked: ${memo.whatWorked}`] : []),
            '',
          );
        }

        return { isError: false, output: lines.join('\n') };
      },
    };
  }
}
