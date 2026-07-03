import { extractQueryEntities, rerankEventsWithLlm } from './extractor.js';
import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeSearchResult,
  KnowledgeSearchOptions,
  LlmCaller,
} from './types.js';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const SEED_EVENT_LIMIT = 30;
const EXPANDED_EVENT_LIMIT = 100;
const COARSE_RANK_LIMIT = 50;
const ENTITY_VECTOR_THRESHOLD = 0.7;
const TITLE_VECTOR_THRESHOLD = 0.4;

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
 */
export async function multiSearch(
  store: KnowledgeStore,
  llm: LlmCaller,
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const topK = Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K);

  const engine = store.getEmbeddingEngine();
  if (engine === undefined || !engine.available) {
    return ftsFallback(store, query, topK);
  }

  const queryEmbeddings = await engine.embedBatch([query]);
  if (queryEmbeddings === null || queryEmbeddings.length === 0) {
    return ftsFallback(store, query, topK);
  }
  const queryVec = queryEmbeddings[0]!;

  // 2. Entity recall
  const recalledEntities = await recallEntities(store, llm, query, queryVec);

  // 3. Seed events
  const seedEventIds = new Set<string>();
  for (const entity of recalledEntities) {
    const events = await store.findEventsByEntity(entity.id);
    for (const event of events) seedEventIds.add(event.id);
  }
  const titleMatches = await store.findEventsByTitleVector(queryVec, {
    limit: SEED_EVENT_LIMIT,
    threshold: TITLE_VECTOR_THRESHOLD,
  });
  for (const { event } of titleMatches) seedEventIds.add(event.id);

  // 4. BFS expand — 1 hop
  const expandedEventIds = new Set<string>(seedEventIds);
  for (const eventId of seedEventIds) {
    const entities = await store.findEntitiesByEvent(eventId);
    for (const entity of entities) {
      const neighborEvents = await store.findEventsByEntity(entity.id);
      for (const neighbor of neighborEvents) {
        expandedEventIds.add(neighbor.id);
        if (expandedEventIds.size >= EXPANDED_EVENT_LIMIT) break;
      }
      if (expandedEventIds.size >= EXPANDED_EVENT_LIMIT) break;
    }
    if (expandedEventIds.size >= EXPANDED_EVENT_LIMIT) break;
  }

  // 5. Coarse rank — score graph-reachable events by content similarity.
  //    Graph associativity is the primary gate (entity recall + BFS expand);
  //    content vector orders within that gate, not as a global recall path.
  //    Mirrors SAG's coarse rank which only considers graph-reachable events.
  const candidates: Array<{
    id: string;
    title: string;
    summary: string;
    score: number;
    chunkId: string;
  }> = [];
  for (const eventId of expandedEventIds) {
    const event = await store.getEvent(eventId);
    if (event === undefined) continue;
    const vec = event.contentEmbedding;
    const score = vec === null ? 0 : engine.cosineSimilarity(queryVec, vec);
    candidates.push({
      id: event.id,
      title: event.title,
      summary: event.summary ?? '',
      score,
      chunkId: event.chunkId,
    });
  }

  if (candidates.length === 0) {
    // No graph-reachable events — fall back to direct chunk vector search.
    return chunkVectorFallback(store, queryVec, topK);
  }

  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, COARSE_RANK_LIMIT);

  // 6. LLM rerank
  let rankedIds: string[];
  if (options.skipRerank === true || topCandidates.length <= topK) {
    rankedIds = topCandidates.map((c) => c.id);
  } else {
    rankedIds = await rerankEventsWithLlm(
      llm,
      query,
      topCandidates.map((c) => ({ id: c.id, title: c.title, summary: c.summary })),
      topK,
    );
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
      if (result !== undefined) results.push(result);
    }
  }

  // Supplemental backfill: still short — find chunks by direct vector
  // similarity. Mirrors SAG's searchChunksByVector backfill when reranked
  // events don't yield enough sections.
  if (results.length < topK) {
    const remaining = topK - results.length;
    const backfill = await store.searchChunksByVector(queryVec, {
      limit: remaining * 2,
    });
    for (const { chunk, score } of backfill) {
      if (results.length >= topK) break;
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      const result = await store.buildSearchResult(chunk.id, score);
      if (result !== undefined) results.push(result);
    }
  }

  return results;
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
