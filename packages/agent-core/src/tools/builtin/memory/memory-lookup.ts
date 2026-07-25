import { buildProjectTagCloud, rankMemos, toSummary } from '@scream-code/memory';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const QUERY_EMBEDDING_CACHE_MAX_SIZE = 50;
const QUERY_EMBEDDING_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  vec: Float32Array;
  expiresAt: number;
}

const queryEmbeddingCache = new Map<string, CacheEntry>();

function getCachedQueryEmbedding(key: string): Float32Array | undefined {
  const entry = queryEmbeddingCache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() > entry.expiresAt) {
    queryEmbeddingCache.delete(key);
    return undefined;
  }
  return entry.vec;
}

function setCachedQueryEmbedding(key: string, vec: Float32Array): void {
  if (queryEmbeddingCache.size >= QUERY_EMBEDDING_CACHE_MAX_SIZE) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest !== undefined) {
      queryEmbeddingCache.delete(oldest);
    }
  }
  queryEmbeddingCache.set(key, { vec, expiresAt: Date.now() + QUERY_EMBEDDING_CACHE_TTL_MS });
}

const DEFAULT_MIN_SCORE = 0.2;

export const MemoryLookupInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Search query describing the current task, error, approach, or keywords to look up in the memory memo store.',
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
  scope: z
    .enum(['project', 'global'])
    .optional()
    .describe(
      `Search scope: 'global' (default) searches across all projects; 'project' limits results to the current working directory.`,
    ),
});

export type MemoryLookupInput = z.infer<typeof MemoryLookupInputSchema>;

/**
 * Lets the model actively search the memory memo store for historical
 * task experiences. Returns ranked memos with what failed and what worked so
 * the model can avoid repeating past mistakes or rediscovering known solutions.
 */
export class MemoryLookupTool implements BuiltinTool<MemoryLookupInput> {
  readonly name = 'MemoryLookup' as const;
  readonly description =
    'Search the memory memo store for historical experiences from past user tasks. ' +
    'Call this when the current task may benefit from prior work, when you encounter a ' +
    'repeating error or pattern, or when you are unsure of the best approach. ' +
    'Returns memos ranked by relevance, including the approach taken, the outcome, ' +
    'what failed, what worked, project, and tags.';
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
        const scope = args.scope ?? 'global';
        const projectDir = scope === 'project' ? this.agent.config.cwd : undefined;

        const candidateLimit = Math.max((args.limit ?? DEFAULT_LIMIT) * 10, 200);
        let candidates = await store.search(query, { candidateLimit, projectDir });

        // Fallback: if FTS5 returns nothing, scan the full store so memos that
        // use wording not captured by the index are still considered.
        if (candidates.length === 0) {
          for await (const memo of store.read({ projectDir })) {
            candidates.push(memo);
          }
        }

        const all = candidates.map(toSummary);

        // Try vector search as a supplementary signal. Only runs if embeddings
        // exist and the engine loaded successfully.
        let vectorScores: Map<string, number> | undefined;
        const engine = store.getEmbeddingEngine();
        if (engine?.available && store.hasEmbeddings()) {
          try {
            const cachedVec = getCachedQueryEmbedding(query);
            let queryVec: Float32Array | undefined = cachedVec;
            if (queryVec === undefined) {
              const queryVecs = await engine.embedBatch([query]);
              if (queryVecs !== null && queryVecs.length > 0) {
                queryVec = queryVecs[0]!;
                setCachedQueryEmbedding(query, queryVec);
              }
            }
            if (queryVec !== undefined) {
              const vectorResults = await store.searchByVector(queryVec, {
                candidateLimit,
                projectDir,
                recencyCutoffDays: 90,
              });
              if (vectorResults.length > 0) {
                vectorScores = new Map(
                  vectorResults.map((r) => [r.memo.id, r.score]),
                );
              }
            }
          } catch {
            // Vector search is best-effort — gracefully fall back to keyword only.
          }
        }

        if (all.length === 0) {
          if (vectorScores === undefined || vectorScores.size === 0) {
            return { isError: false, output: 'No memory memos found. The experience store is empty.' };
          }
        }

        const currentProjectDir = this.agent.config.cwd;
        const projectTagCloud =
          scope === 'global' ? buildProjectTagCloud(all, currentProjectDir) : undefined;
        const ranked = rankMemos(all, query, {
          minScore,
          maxResults: limit,
          currentProjectDir,
          projectTagCloud,
          vectorScores,
        });

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
          const project = memo.projectDir.length > 0 ? `Project: ${memo.projectDir}` : undefined;
          const tags = memo.tags !== undefined && memo.tags.length > 0
            ? `Tags: ${memo.tags.join(', ')}`
            : undefined;
          lines.push(
            `**${i + 1}. ${memo.userNeed}${source}**`,
            `  Score: ${score.toFixed(3)}`,
            ...(project !== undefined ? [`  ${project}`] : []),
            ...(tags !== undefined ? [`  ${tags}`] : []),
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
