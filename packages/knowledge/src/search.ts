import { extractQueryEntities, rerankEventsWithLlm } from './extractor.js';
import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeSearchStepCallback,
  KnowledgeSearchTrace,
  KnowledgeSearchTraceStep,
  LlmCaller,
} from './types.js';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const SEED_EVENT_LIMIT = 30;
const EXPANDED_EVENT_LIMIT = 100;
const COARSE_RANK_LIMIT = 50;
const ENTITY_VECTOR_THRESHOLD = 0.7;
const TITLE_VECTOR_THRESHOLD = 0.4;

async function timed<T>(
  onStep: KnowledgeSearchStepCallback | undefined,
  step: string,
  detail: string,
  fn: () => Promise<T>,
  payload?: (result: T) => unknown,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const traceStep: KnowledgeSearchTraceStep = {
      step,
      detail,
      durationMs,
      ...(payload !== undefined ? { payload: payload(result) } : {}),
    };
    onStep?.(traceStep);
    return result;
  } catch (error) {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    onStep?.({
      step,
      detail: `${detail} 失败：${error instanceof Error ? error.message : String(error)}`,
      durationMs,
    });
    throw error;
  }
}

/**
 * Multi-hop retrieval:
 * 1. Vectorize query.
 * 2. Entity recall — LLM extracts entities from query → match by name + vector.
 * 3. Seed events — events linked to recalled entities + events by title vector similarity.
 * 4. BFS expand (1 hop) — from seed events, walk to entities, then to other events.
 * 5. Coarse rank — score graph-reachable events by content embedding similarity.
 *    Graph associativity is the gate; content vector orders within it.
 * 6. LLM rerank — pick top-K most relevant.
 * 7. Return corresponding chunks (deduped by chunk_id) with scores and provenance.
 *    If rerank yields fewer than topK chunks, backfill by direct chunk vector search.
 *
 * Optional `onStep` callback receives a trace step at each phase — used by the
 * KnowledgeLookup tool to expose retrieval diagnostics to the agent.
 */
export async function multiSearch(
  store: KnowledgeStore,
  llm: LlmCaller,
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const results = await multiSearchWithTrace(store, llm, query, options);
  return results.results;
}

/** Like multiSearch but also returns the retrieval trace for diagnostics. */
export async function multiSearchWithTrace(
  store: KnowledgeStore,
  llm: LlmCaller,
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<{ results: KnowledgeSearchResult[]; trace: KnowledgeSearchTrace }> {
  const topK = Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
  const steps: KnowledgeSearchTraceStep[] = [];
  const onStep: KnowledgeSearchStepCallback = (step) => steps.push(step);
  const rerankedEventTitles: string[] = [];
  let fallbackReason: string | null = null;

  const engine = store.getEmbeddingEngine();
  if (engine === undefined || !engine.available) {
    fallbackReason = 'embedding engine unavailable; used FTS5 keyword fallback';
    const results = await ftsFallback(store, query, topK);
    return { results, trace: { steps, rerankedEventTitles, fallbackReason } };
  }

  const queryEmbeddings = await timed(
    onStep,
    'queryEmbedding',
    '把用户问题转成向量，用于召回相关事件和切片。',
    async () => engine.embedBatch([query]),
  );
  if (queryEmbeddings === null || queryEmbeddings.length === 0) {
    fallbackReason = 'query embedding returned null; used FTS5 fallback';
    const results = await ftsFallback(store, query, topK);
    return { results, trace: { steps, rerankedEventTitles, fallbackReason } };
  }
  const queryVec = queryEmbeddings[0]!;

  // 2. Entity recall
  const recalledEntities = await timed(
    onStep,
    'entityRecall',
    'LLM 抽 query 实体 + 名字精确匹配 + 向量召回。',
    () => recallEntities(store, llm, query, queryVec),
    (entities) => ({ count: entities.length }),
  );

  // 3. Seed events
  const seedEventIds = new Set<string>();
  for (const entity of recalledEntities) {
    const events = await store.findEventsByEntity(entity.id);
    for (const event of events) seedEventIds.add(event.id);
  }
  const titleMatches = await timed(
    onStep,
    'seedEventsByTitle',
    '按查询向量在事件标题向量上召回 seed events。',
    () =>
      store.findEventsByTitleVector(queryVec, {
        limit: SEED_EVENT_LIMIT,
        threshold: TITLE_VECTOR_THRESHOLD,
      }),
    (matches) => ({ count: matches.length }),
  );
  for (const { event } of titleMatches) seedEventIds.add(event.id);

  if (seedEventIds.size === 0) {
    const results = await chunkVectorFallback(store, queryVec, topK);
    if (results.length > 0) {
      fallbackReason = 'no seed events; used direct chunk vector search';
      return { results, trace: { steps, rerankedEventTitles, fallbackReason } };
    }
    fallbackReason =
      'no seed events and direct chunk vector search returned no results; used FTS5 keyword fallback';
    const ftsResults = await ftsFallback(store, query, topK);
    return { results: ftsResults, trace: { steps, rerankedEventTitles, fallbackReason } };
  }

  // 4. BFS expand — 1 hop
  const expandedEventIds = await timed(
    onStep,
    'bfsExpand',
    '从 seed events 沿实体关系 1 跳扩展候选事件。',
    async () => {
      const ids = new Set<string>(seedEventIds);
      let capped = false;
      for (const eventId of seedEventIds) {
        const entities = await store.findEntitiesByEvent(eventId);
        for (const entity of entities) {
          const neighborEvents = await store.findEventsByEntity(entity.id);
          for (const neighbor of neighborEvents) {
            ids.add(neighbor.id);
            if (ids.size >= EXPANDED_EVENT_LIMIT) {
              capped = true;
              break;
            }
          }
          if (ids.size >= EXPANDED_EVENT_LIMIT) break;
        }
        if (ids.size >= EXPANDED_EVENT_LIMIT) break;
      }
      return { ids, capped };
    },
    (result) => ({ expandedCount: result.ids.size, capped: result.capped }),
  );

  // 5. Coarse rank — score graph-reachable events by content similarity.
  const { candidates, topCandidates } = await timed(
    onStep,
    'coarseRank',
    '按 content 向量相似度对候选事件排序，取前 COARSE_RANK_LIMIT 个。',
    async () => {
      const cands: Array<{
        id: string;
        title: string;
        summary: string;
        score: number;
        chunkId: string;
      }> = [];
      for (const eventId of expandedEventIds.ids) {
        const event = await store.getEvent(eventId);
        if (event === undefined) continue;
        const vec = event.contentEmbedding;
        const score = vec === null ? 0 : engine.cosineSimilarity(queryVec, vec);
        cands.push({
          id: event.id,
          title: event.title,
          summary: event.summary ?? '',
          score,
          chunkId: event.chunkId,
        });
      }
      cands.sort((a, b) => b.score - a.score);
      const top = cands.slice(0, COARSE_RANK_LIMIT);
      return { candidates: cands, topCandidates: top };
    },
    (result) => ({
      totalCandidates: result.candidates.length,
      kept: result.topCandidates.length,
      topScore: result.topCandidates[0]?.score ?? 0,
    }),
  );

  if (candidates.length === 0) {
    const results = await chunkVectorFallback(store, queryVec, topK);
    if (results.length > 0) {
      fallbackReason = 'no graph-reachable events with content; used chunk vector fallback';
      return { results, trace: { steps, rerankedEventTitles, fallbackReason } };
    }
    fallbackReason =
      'no graph-reachable events with content and chunk vector search returned no results; used FTS5 keyword fallback';
    const ftsResults = await ftsFallback(store, query, topK);
    return { results: ftsResults, trace: { steps, rerankedEventTitles, fallbackReason } };
  }

  // 6. LLM rerank
  let rankedIds: string[];
  if (options.skipRerank === true) {
    rankedIds = topCandidates.map((c) => c.id);
    onStep({
      step: 'rerank',
      detail: '跳过 LLM rerank（skipRerank=true），直接用 coarse rank 顺序。',
      durationMs: 0,
      payload: { count: rankedIds.length },
    });
  } else if (topCandidates.length <= topK) {
    rankedIds = topCandidates.map((c) => c.id);
    onStep({
      step: 'rerank',
      detail: `候选数 ${topCandidates.length} ≤ topK ${topK}，无需 LLM rerank。`,
      durationMs: 0,
      payload: { count: rankedIds.length },
    });
  } else {
    rankedIds = await timed(
      onStep,
      'rerank',
      `LLM 从 ${topCandidates.length} 个候选中选最相关的 ${topK} 个。`,
      () =>
        rerankEventsWithLlm(
          llm,
          query,
          topCandidates.map((c) => ({ id: c.id, title: c.title, summary: c.summary })),
          topK,
        ),
      (ids) => ({ count: ids.length }),
    );
  }
  // Collect reranked event titles in order.
  for (const id of rankedIds) {
    const c = topCandidates.find((x) => x.id === id);
    if (c !== undefined) rerankedEventTitles.push(c.title);
  }

  // 7. Build results from ranked events → chunks (dedupe by chunk_id).
  const seen = new Set<string>();
  const results: KnowledgeSearchResult[] = [];
  for (const eventId of rankedIds) {
    const candidate = topCandidates.find((c) => c.id === eventId);
    if (candidate === undefined) continue;
    if (seen.has(candidate.chunkId)) continue;
    seen.add(candidate.chunkId);
    const result = await store.buildSearchResult(candidate.chunkId, candidate.score, eventId);
    if (result !== undefined) results.push(result);
    if (results.length >= topK) break;
  }

  // If rerank gave us fewer than topK, fall back to coarse-ranked remaining.
  if (results.length < topK) {
    let supplemented = 0;
    for (const candidate of topCandidates) {
      if (results.length >= topK) break;
      if (rankedIds.includes(candidate.id)) continue;
      if (seen.has(candidate.chunkId)) continue;
      seen.add(candidate.chunkId);
      const result = await store.buildSearchResult(
        candidate.chunkId,
        candidate.score,
        candidate.id,
      );
      if (result !== undefined) {
        results.push(result);
        supplemented += 1;
      }
    }
    if (supplemented > 0) {
      onStep({
        step: 'supplementFromCoarse',
        detail: `rerank 结果不足，从 coarse rank 残余补 ${supplemented} 个。`,
        durationMs: 0,
        payload: { supplemented },
      });
    }
  }

  // Supplemental backfill: still short — find chunks by direct vector
  // similarity. Mirrors SAG's searchChunksByVector backfill when reranked
  // events don't yield enough sections.
  if (results.length < topK) {
    const remaining = topK - results.length;
    const backfill = await timed(
      onStep,
      'backfill',
      `rerank 结果不足，回退到 chunk 向量搜索补 ${remaining} 个。`,
      () =>
        store.searchChunksByVector(queryVec, {
          limit: remaining * 2,
        }),
      (matches) => ({ backfillCandidates: matches.length }),
    );
    for (const { chunk, score } of backfill) {
      if (results.length >= topK) break;
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      const result = await store.buildSearchResult(chunk.id, score);
      if (result !== undefined) results.push(result);
    }
  }

  if (results.length === 0) {
    fallbackReason = 'vector retrieval returned no results; used FTS5 keyword fallback';
    const ftsResults = await ftsFallback(store, query, topK);
    return { results: ftsResults, trace: { steps, rerankedEventTitles, fallbackReason } };
  }

  return { results, trace: { steps, rerankedEventTitles, fallbackReason } };
}

/** Recall entities by name (LLM-extracted) and by vector similarity. */
async function recallEntities(
  store: KnowledgeStore,
  llm: LlmCaller,
  query: string,
  queryVec: Float32Array,
): Promise<Array<{ id: string }>> {
  const out = new Map<string, { id: string }>();
  const queryEntities = await extractQueryEntities(llm, query);
  for (const { name } of queryEntities) {
    const matches = await store.findEntitiesByName(name);
    for (const entity of matches) {
      out.set(entity.id, { id: entity.id });
    }
  }
  const vectorMatches = await store.findEntitiesByVector(queryVec, {
    limit: 20,
    threshold: ENTITY_VECTOR_THRESHOLD,
  });
  for (const { entity } of vectorMatches) {
    out.set(entity.id, { id: entity.id });
  }
  return Array.from(out.values());
}

/** FTS5 keyword fallback when embeddings are unavailable. */
async function ftsFallback(
  store: KnowledgeStore,
  query: string,
  topK: number,
): Promise<KnowledgeSearchResult[]> {
  const chunks = await store.ftsSearchChunks(query, topK * 2);
  const results: KnowledgeSearchResult[] = [];
  for (const chunk of chunks) {
    const result = await store.buildSearchResult(chunk.id, 0);
    if (result !== undefined) results.push(result);
    if (results.length >= topK) break;
  }
  return results;
}

/** Direct chunk vector search fallback. */
async function chunkVectorFallback(
  store: KnowledgeStore,
  queryVec: Float32Array,
  topK: number,
): Promise<KnowledgeSearchResult[]> {
  const matches = await store.searchChunksByVector(queryVec, { limit: topK * 2 });
  const results: KnowledgeSearchResult[] = [];
  for (const { chunk, score } of matches) {
    const result = await store.buildSearchResult(chunk.id, score);
    if (result !== undefined) results.push(result);
    if (results.length >= topK) break;
  }
  return results;
}
