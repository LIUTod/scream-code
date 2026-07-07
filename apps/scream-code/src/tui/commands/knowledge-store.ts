import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createFastEmbedEngine, type EmbeddingEngine } from '@scream-code/memory';
import { KnowledgeStore } from '@scream-code/knowledge';

import { getDataDir } from '#/utils/paths';

export type EmbeddingStatus = 'loading' | 'ready' | 'failed';

let knowledgeStoreInstance: KnowledgeStore | undefined;
let embeddingEngineInstance: EmbeddingEngine | undefined;
let embeddingStatus: EmbeddingStatus = 'loading';
let loadPromise: Promise<void> | undefined;
let embeddingRetryTimer: ReturnType<typeof setInterval> | undefined;

const EMBEDDING_RETRY_MS = 5 * 60 * 1000;

function getEmbeddingCacheDir(): string {
  const dir = join(getDataDir(), 'cache', 'fastembed');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function getKnowledgeStore(): Promise<KnowledgeStore> {
  if (knowledgeStoreInstance === undefined) {
    knowledgeStoreInstance = new KnowledgeStore(getDataDir());
    await knowledgeStoreInstance.init();
    embeddingEngineInstance = createFastEmbedEngine(getEmbeddingCacheDir());
    knowledgeStoreInstance.setEmbeddingEngine(embeddingEngineInstance);
    loadPromise = triggerEmbeddingLoad();
  }
  return knowledgeStoreInstance;
}

export function getEmbeddingEngineInstance(): EmbeddingEngine | undefined {
  return embeddingEngineInstance;
}

export function getEmbeddingStatus(): EmbeddingStatus {
  return embeddingStatus;
}

async function triggerEmbeddingLoad(): Promise<void> {
  if (embeddingEngineInstance === undefined) return;
  embeddingStatus = 'loading';

  const ok = await embeddingEngineInstance.ensureReady();
  if (ok) {
    embeddingStatus = 'ready';
    stopRetryTimer();
    return;
  }

  embeddingStatus = 'failed';
  startRetryTimer();
}

function startRetryTimer(): void {
  if (embeddingRetryTimer !== undefined) return;
  embeddingRetryTimer = setInterval(() => {
    loadPromise = triggerEmbeddingLoad();
  }, EMBEDDING_RETRY_MS);
  embeddingRetryTimer.unref?.();
}

function stopRetryTimer(): void {
  if (embeddingRetryTimer !== undefined) {
    clearInterval(embeddingRetryTimer);
    embeddingRetryTimer = undefined;
  }
}

/**
 * Wait for the embedding model to become ready.
 * Returns the current status. Callers can compare against 'ready'.
 * On failure the cached promise is cleared so subsequent calls retry.
 */
export async function waitForEmbedding(): Promise<EmbeddingStatus> {
  if (loadPromise !== undefined) await loadPromise;
  return embeddingStatus;
}

export function ensureEmbeddingReady(): void {
  if (loadPromise === undefined) {
    loadPromise = getKnowledgeStore().then(() => triggerEmbeddingLoad());
  }
}
