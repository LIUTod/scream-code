import type { EmbeddingEngine } from '@scream-code/memory';

/** A document source — typically one ingested file. */
export interface KnowledgeSource {
  id: string;
  name: string;
  filePath: string | null;
  description: string | null;
  createdAt: number;
}

/** A document within a source — one file maps to one document. */
export interface KnowledgeDocument {
  id: string;
  sourceId: string;
  title: string;
  content: string | null;
  status: 'pending' | 'completed' | 'failed';
  chunkCount: number;
  createdAt: number;
}

/** A section chunk from heading_strict splitting. */
export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  documentId: string;
  rank: number;
  heading: string | null;
  content: string;
  rawContent: string | null;
  embedding: Float32Array | null;
  createdAt: number;
}

export type KnowledgeEntityType =
  | 'person'
  | 'organization'
  | 'location'
  | 'time'
  | 'product'
  | 'metric'
  | 'action'
  | 'work'
  | 'group'
  | 'subject'
  | 'tags';

/** An entity extracted from chunks. */
export interface KnowledgeEntity {
  id: string;
  sourceId: string;
  type: KnowledgeEntityType;
  name: string;
  normalizedName: string;
  description: string | null;
  embedding: Float32Array | null;
  createdAt: number;
}

/** An event extracted from a chunk — one chunk = one fused event. */
export interface KnowledgeEvent {
  id: string;
  sourceId: string;
  documentId: string;
  chunkId: string;
  rank: number;
  title: string;
  summary: string | null;
  content: string;
  category: string | null;
  keywords: string[];
  titleEmbedding: Float32Array | null;
  contentEmbedding: Float32Array | null;
  createdAt: number;
}

/** Edge between an event and an entity. */
export interface KnowledgeEventEntity {
  id: string;
  eventId: string;
  entityId: string;
  weight: number;
  description: string | null;
  embedding: Float32Array | null;
}

/** Raw chunk section produced by the chunker. */
export interface ChunkSection {
  heading: string | null;
  headingLevel: number | null;
  content: string;
  rawContent: string;
  rank: number;
}

/** Raw extraction result from the LLM. */
export interface ExtractedEvent {
  title: string;
  summary: string;
  content: string;
  category: string;
  keywords: string[];
  entities: ExtractedEntity[];
}

export interface ExtractedEntity {
  type: KnowledgeEntityType;
  name: string;
  description: string;
}

/** A search result item — a chunk with provenance and score. */
export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  sourceId: string;
  sourceName: string;
  heading: string | null;
  content: string;
  score: number;
  eventId: string | null;
  eventTitle: string | null;
}

export interface KnowledgeSearchOptions {
  topK?: number;
  /** Skip the LLM rerank step (coarse rank only). */
  skipRerank?: boolean;
}

/** One step in the multi-hop retrieval trace. */
export interface KnowledgeSearchTraceStep {
  step: string;
  detail: string;
  durationMs: number;
  payload?: unknown;
}

/** Aggregated trace from multiSearch — exposed for debugging / agent context. */
export interface KnowledgeSearchTrace {
  steps: KnowledgeSearchTraceStep[];
  /** Titles of events the LLM reranker selected (most relevant first). */
  rerankedEventTitles: string[];
  /** Final fallback reason if the multi-hop path was bypassed. */
  fallbackReason: string | null;
}

/** Callback invoked at each retrieval step. Optional — used for trace collection. */
export type KnowledgeSearchStepCallback = (step: KnowledgeSearchTraceStep) => void;

/** Progress callback for ingest operations. */
export type IngestProgress =
  | { stage: 'chunking'; message: string }
  | { stage: 'embedding-chunks'; chunkIndex: number; totalChunks: number; message: string }
  | { stage: 'extracting'; chunkIndex: number; totalChunks: number; message: string }
  | { stage: 'embedding-events'; chunkIndex: number; totalChunks: number; message: string }
  | { stage: 'embedding-entities'; message: string }
  | { stage: 'embedding-relations'; message: string }
  | { stage: 'completed'; message: string }
  | { stage: 'error'; message: string };

/** Callback type for ingest progress reporting. */
export type IngestProgressCallback = (progress: IngestProgress) => void;

/** LLM caller abstraction — wraps Agent.generate so the knowledge package stays decoupled. */
export interface LlmCaller {
  /** Call LLM with a system prompt and single user message, return text response. */
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** Re-export the embedding engine type for convenience. */
export type { EmbeddingEngine };

/** Graph data payload for the /knowledge web visualization. */
export interface KnowledgeGraphData {
  entities: Array<{
    id: string;
    sourceId: string;
    type: string;
    name: string;
    normalizedName: string;
    eventCount: number;
  }>;
  events: Array<{
    id: string;
    sourceId: string;
    documentId: string;
    title: string;
    rank: number;
    entityIds: string[];
  }>;
  edges: Array<{ entityId: string; eventId: string }>;
  sources: Array<{ id: string; name: string }>;
}
