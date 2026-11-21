/**
 * Automatic recall: which stored experiences to bring back for the request
 * the person just made.
 *
 * Precision over reach. A memory that does not fit makes the agent look
 * confused, so recall stays silent unless one memo clearly stands out:
 *
 * - **Vectors only.** Keyword overlap cannot tell a related request from an
 *   unrelated one (measured on 400 real prompts against 106 memos: the top
 *   keyword score sat at 0.25-0.31 either way), while the vector picked a memo
 *   from the prompt's own session as its first result 56% of the time against
 *   34% for keywords. Without a loaded model nothing is recalled; an explicit
 *   lookup still works on keywords.
 * - **An absolute floor and a margin.** bge-small-zh similarities are
 *   compressed (unrelated pairs ~0.50-0.64, related ~0.59-0.80), so a memo must
 *   reach {@link RECALL_MIN_SIMILARITY} AND stand {@link RECALL_MIN_MARGIN}
 *   above the median of all memos for this query. On the same data that gate
 *   fired for 24% of prompts in sessions that had memos, 82% of them from the
 *   prompt's own session, and for none of the 64 prompts in sessions without.
 *   Prompts under 16 characters ("继续", "好的") almost never pass it.
 * - **No near-copies.** A memo almost identical to one already kept
 *   ({@link RECALL_NEAR_COPY} or more, or the same need from the same session)
 *   is dropped. Not "one per session": 70 of the 106 memos came from one long
 *   session, but 65 of them are different finished tasks (memos of one session
 *   sit around 0.65 to each other; copies sit above 0.9), so a long session
 *   may well hold two lessons that both fit.
 * - **What the conversation already has is left out:** memos from the asking
 *   session itself, memos already shown, low-confidence compaction fallbacks
 *   and in-progress snapshots without a distilled rule.
 * - **This project first.** A memo from another project needs
 *   {@link RECALL_OTHER_PROJECT_MIN_SIMILARITY}. "This project" is the git root
 *   of the working directory ({@link isSameProject}), falling back to the
 *   directory comparison for memos written before roots were recorded: stamping
 *   the bare cwd meant 84 of 87 real memos claimed the same home directory, which
 *   made every memo look like the current project.
 */

import { isSameProject } from './project.js';

import type { MemoryMemo } from './models.js';
import type { MemoryMemoStore } from './store.js';

export const RECALL_MIN_SIMILARITY = 0.68;
export const RECALL_MIN_MARGIN = 0.08;
export const RECALL_OTHER_PROJECT_MIN_SIMILARITY = 0.72;
export const RECALL_DEFAULT_LIMIT = 3;
/** Two memos this similar to each other say the same thing. */
export const RECALL_NEAR_COPY = 0.92;
/**
 * With only a handful of memos the median is no picture of "unrelated"; use
 * the typical unrelated similarity instead (the measured median top score for
 * prompts with no related memo was 0.56).
 */
const SMALL_STORE_BASELINE = 0.58;
const SMALL_STORE = 8;
const QUERY_MAX_CHARS = 500;
const MIN_QUERY_CHARS = 4;
const IN_PROGRESS_OUTCOME = /进行中|in[ -]?progress|ongoing|unfinished/i;
const FALLBACK_TAG = 'compaction-fallback';

export interface RecallRequest {
  /** The person's request, as written. */
  readonly query: string;
  /** Working directory of the conversation asking. */
  readonly projectDir: string;
  /** Project (git root) of the working directory, when it is inside a checkout. */
  readonly projectRoot?: string | undefined;
  /** Memos already shown in this conversation. */
  readonly excludeIds?: ReadonlySet<string>;
  /** The conversation asking: what it wrote itself is already in its context. */
  readonly sessionId?: string;
  readonly limit?: number;
}

export interface RecalledMemo {
  readonly memo: MemoryMemo;
  readonly similarity: number;
  /** False for a memo from another project (held to the higher bar). */
  readonly sameProject: boolean;
}

/**
 * The memos worth bringing back for this request, best first; empty when
 * none clearly fits or no vector model is loaded. Never loads the model.
 */
export async function recallMemos(store: MemoryMemoStore, request: RecallRequest): Promise<RecalledMemo[]> {
  const engine = store.getEmbeddingEngine();
  if (engine === undefined || !engine.available) return [];
  const query = request.query.trim().slice(0, QUERY_MAX_CHARS);
  if (query.length < MIN_QUERY_CHARS) return [];
  const vectors = await engine.embedBatch([query]);
  const queryVector = vectors?.[0];
  if (queryVector === undefined) return [];

  // Two tiers, so an old memo of this project can never be crowded out by a
  // recency window: every memo of this project is scored, cross-project memos
  // are capped newest-first.
  const scored = await store.scoreByVector(queryVector, {
    project: {
      projectDir: request.projectDir,
      ...(request.projectRoot === undefined ? {} : { projectRoot: request.projectRoot }),
    },
  });
  if (scored.length === 0) return [];
  const median = scored[Math.floor(scored.length / 2)]!.score;
  const baseline = scored.length < SMALL_STORE ? Math.min(median, SMALL_STORE_BASELINE) : median;

  const limit = request.limit ?? RECALL_DEFAULT_LIMIT;
  const kept: RecalledMemo[] = [];
  const keptVectors: Float32Array[] = [];
  for (const { id, score } of scored) {
    if (kept.length >= limit) break;
    // Sorted highest first: once one falls below the gate, all the rest do.
    if (score < RECALL_MIN_SIMILARITY || score - baseline < RECALL_MIN_MARGIN) break;
    if (request.excludeIds?.has(id) === true) continue;
    const memo = await store.get(id);
    if (memo === undefined) continue;
    if (request.sessionId !== undefined && request.sessionId !== '' && memo.sourceSessionId === request.sessionId) {
      continue;
    }
    if (memo.tags?.includes(FALLBACK_TAG) === true) continue;
    if (IN_PROGRESS_OUTCOME.test(memo.outcome) && (memo.distilled ?? '') === '') continue;
    const sameProject = isSameProject(memo, request);
    if (!sameProject && score < RECALL_OTHER_PROJECT_MIN_SIMILARITY) continue;
    if (kept.some((entry) => entry.memo.userNeed === memo.userNeed && entry.memo.sourceSessionId === memo.sourceSessionId)) {
      continue;
    }
    const vector = store.vectorOf(id);
    if (vector !== undefined && keptVectors.some((other) => engine.cosineSimilarity(other, vector) >= RECALL_NEAR_COPY)) {
      continue;
    }
    kept.push({ memo, similarity: score, sameProject });
    if (vector !== undefined) keptVectors.push(vector);
  }
  return kept;
}
