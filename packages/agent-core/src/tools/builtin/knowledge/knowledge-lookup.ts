import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

export const KnowledgeLookupInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Search query describing concepts, definitions, or background knowledge to look up in the local knowledge base.',
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_K)
    .optional()
    .describe(`Maximum number of chunks to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`),
});

export type KnowledgeLookupInput = z.infer<typeof KnowledgeLookupInputSchema>;

/**
 * Search the local knowledge base (library) for relevant information. Use when
 * the user asks about concepts, definitions, or background knowledge that may
 * be in the knowledge library — distinct from /memory which is task experience.
 */
export class KnowledgeLookupTool implements BuiltinTool<KnowledgeLookupInput> {
  readonly name = 'KnowledgeLookup' as const;
  readonly description =
    'Search the local knowledge library — a reference collection of documents the user ingested via /knowledge. ' +
    'Use when the user asks about a concept, definition, or background topic that may be in the library, OR when the user explicitly asks to "查知识库" / "search the knowledge base". ' +
    'Returns ranked chunks with source document and section heading. ' +
    'Do NOT use for personal task experience (use MemoryLookup) or current code (use Read/Grep). ' +
    'Prefer this over web search when the topic is likely covered by ingested docs — local sources are faster and more relevant.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(KnowledgeLookupInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: KnowledgeLookupInput): ToolExecution {
    return {
      description: 'Searching knowledge base',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.knowledgeStore;
        if (!store) {
          return { isError: true, output: 'Knowledge store is not available.' };
        }

        const query = args.query.trim();
        if (query.length === 0) {
          return { isError: true, output: 'Query cannot be empty.' };
        }

        const stats = await store.stats();
        if (stats.chunks === 0) {
          return {
            isError: false,
            output: '知识库为空，请先用 /knowledge 摄入文档后再使用 KnowledgeLookup。',
          };
        }

        const topK = Math.min(args.top_k ?? DEFAULT_TOP_K, MAX_TOP_K);
        const llm = {
          generate: async (systemPrompt: string, userPrompt: string): Promise<string> => {
            return this.agent.generateText(systemPrompt, userPrompt);
          },
        };
        const { multiSearch } = await import('@scream-code/knowledge');
        const results = await multiSearch(store, llm, query, { topK });

        if (results.length === 0) {
          return {
            isError: false,
            output: `No knowledge base entries found for query "${query}".`,
          };
        }

        const lines = [
          `Found ${results.length} relevant knowledge chunk${results.length === 1 ? '' : 's'} for query "${query}":`,
          '',
        ];

        for (const [i, result] of results.entries()) {
          const heading = result.heading ?? '(untitled)';
          const eventLine = result.eventTitle !== null ? `  Event: ${result.eventTitle}` : undefined;
          lines.push(
            `**${i + 1}. ${heading}** (from: ${result.sourceName})`,
            `  Score: ${result.score.toFixed(3)}`,
            ...(eventLine !== undefined ? [eventLine] : []),
            `  ${result.content}`,
            '',
          );
        }

        return { isError: false, output: lines.join('\n') };
      },
    };
  }
}
