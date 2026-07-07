import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createFastEmbedEngine, clearEmbeddingModelCache, type EmbeddingEngine } from '@scream-code/memory';
import { KnowledgeStore } from '@scream-code/knowledge';

import { getDataDir } from '#/utils/paths';

export type EmbeddingStatus = 'idle' | 'downloading' | 'ready' | 'failed';

let knowledgeStoreInstance: KnowledgeStore | undefined;
let embeddingEngineInstance: EmbeddingEngine | undefined;
let embeddingStatus: EmbeddingStatus = 'idle';

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
  }
  return knowledgeStoreInstance;
}

export function getEmbeddingEngineInstance(): EmbeddingEngine | undefined {
  return embeddingEngineInstance;
}

export function getEmbeddingStatus(): EmbeddingStatus {
  return embeddingStatus;
}

/**
 * Manually trigger the embedding model download/load.
 * Only mutates embeddingStatus; the actual download is delegated to
 * EmbeddingEngine.ensureReady() and saves the model to the shared cache dir.
 * Returns { ok: true } on success, or { ok: false, error } on failure.
 * Concurrent calls while a download is already in flight are ignored.
 */
export async function startManualEmbeddingDownload(): Promise<{ ok: boolean; alreadyReady?: boolean; error?: string }> {
  if (embeddingEngineInstance === undefined) return { ok: false, error: 'embedding engine not initialized' };
  if (embeddingStatus === 'downloading') return { ok: false, error: 'download already in progress' };

  // If the model is already loaded in this process, nothing to do.
  if (embeddingEngineInstance.available) {
    embeddingStatus = 'ready';
    return { ok: true, alreadyReady: true };
  }

  embeddingStatus = 'downloading';
  let ok = await embeddingEngineInstance.ensureReady();
  let error = ok ? undefined : embeddingEngineInstance.lastError;

  // If the first attempt failed, wipe any partial/corrupted cache and retry once.
  if (!ok) {
    clearEmbeddingModelCache(getEmbeddingCacheDir());
    ok = await embeddingEngineInstance.ensureReady();
    error = ok ? undefined : embeddingEngineInstance.lastError;
  }

  embeddingStatus = ok ? 'ready' : 'failed';
  return { ok, error };
}
