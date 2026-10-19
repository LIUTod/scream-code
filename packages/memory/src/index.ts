// The ambient shim must travel with the package entry: consumers that compile
// memory sources into their own program (e.g. the SDK dts build) otherwise
// report TS7016 for the onnxruntime-web dynamic import.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient module shim
/// <reference path="./onnxruntime-web.d.ts" />
export type { MemoryMemo, MemoryMemoRecord, MemoryMemoSummary, MemoryMemoListResult } from './models.js';
export { createMemoryMemo, toSummary } from './models.js';
export { MemoryMemoStore, sharedMemoStore, closeSharedMemoStore, type MemoryMemoStoreLogger } from './store.js';
export { parseMemoryMemos, stripMemoryTags, buildExitExtractionPrompt, EXIT_EXTRACTION_SYSTEM_PROMPT } from './extractor.js';
export { computeRelevanceScore, rankMemos, extractKeywords, buildProjectTagCloud, detectQueryIntent, type ScoredMemo, type QueryIntent } from './scoring.js';
export { normalizeTags, generateTags } from './tags.js';
export {
  buildConsolidationPlan,
  applyConsolidation,
  type DuplicateGroup,
  type RelatedGroup,
  type ConsolidationPlan,
} from './consolidator.js';
export { DreamTracker, type DreamState } from './dream.js';
export { EMBEDDING_MODEL_NAME, buildEmbeddingText, createEmbeddingEngine, createFastEmbedEngine, clearEmbeddingModelCache, hasEmbeddingModelCache, classifyEmbeddingFailure, probeLocalEmbeddingSupport, type EmbeddingEngine, type EmbeddingFailureKind, type EmbeddingLoadProgress, type EmbeddingProgressListener } from './embeddings.js';
