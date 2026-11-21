// The ambient shim must travel with the package entry: consumers that compile
// memory sources into their own program (e.g. the SDK dts build) otherwise
// report TS7016 for the onnxruntime-web dynamic import.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient module shim
/// <reference path="./onnxruntime-web.d.ts" />
export type { MemoryMemo, MemoryMemoRecord, MemoryMemoSummary, MemoryMemoListResult, MemoOrigin, DistilledSource } from './models.js';
export { createMemoryMemo, toSummary } from './models.js';
export { MemoryMemoStore, sharedMemoStore, closeSharedMemoStore, type MemoryMemoStoreLogger, type MemoryUseStats } from './store.js';
export { isSameProjectDir, recallMemos, RECALL_DEFAULT_LIMIT, RECALL_NEAR_COPY, RECALL_MIN_MARGIN, RECALL_MIN_SIMILARITY, RECALL_OTHER_PROJECT_MIN_SIMILARITY, type RecallRequest, type RecalledMemo } from './recall.js';
export { parseMemoryMemos, stripMemoryTags, buildExitExtractionPrompt, EXIT_EXTRACTION_SYSTEM_PROMPT } from './extractor.js';
export { computeRelevanceScore, rankMemos, extractKeywords, buildProjectTagCloud, detectQueryIntent, type ScoredMemo, type QueryIntent } from './scoring.js';
export { normalizeTags, generateTags } from './tags.js';
export {
  buildConsolidationPlan,
  applyConsolidation,
  checkRuleSentence,
  type DuplicateGroup,
  type NearMiss,
  type DistillCandidate,
  type InductionCluster,
  type ConsolidationPlan,
  type ConsolidationApplyInput,
  type ConsolidationApplyResult,
  type ConsolidationMerge,
  type ConsolidationDistillation,
  type ConsolidationInduction,
  type RuleCheck,
} from './consolidator.js';
export { DreamTracker, type DreamState } from './dream.js';
export { EMBEDDING_MODEL_NAME, buildEmbeddingText, createEmbeddingEngine, createFastEmbedEngine, clearEmbeddingModelCache, hasEmbeddingModelCache, classifyEmbeddingFailure, probeLocalEmbeddingSupport, type EmbeddingEngine, type EmbeddingFailureKind, type EmbeddingLoadProgress, type EmbeddingProgressListener } from './embeddings.js';
