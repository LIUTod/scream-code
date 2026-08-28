import { existsSync, mkdirSync } from 'node:fs';
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

/** Subdirectory fastembed uses for the BGESmallZH model inside the cache dir. */
const EMBEDDING_MODEL_DIR = 'fast-bge-small-zh-v1.5';

/**
 * Whether the embedding model has been downloaded to the local cache.
 * Checks the ONNX weights plus a config sidecar — both required for
 * FlagEmbedding.init to load without network access.
 */
export function isEmbeddingModelCached(): boolean {
  const modelDir = join(getEmbeddingCacheDir(), EMBEDDING_MODEL_DIR);
  return (
    existsSync(join(modelDir, 'model_optimized.onnx')) &&
    existsSync(join(modelDir, 'config.json'))
  );
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

export function getEmbeddingStatus(): EmbeddingStatus {
  return embeddingStatus;
}

/**
 * Manually trigger the embedding model download/load.
 * Only mutates embeddingStatus; the actual download is delegated to
 * EmbeddingEngine.ensureReady() and saves the model to the shared cache dir.
 * Returns { ok: true } on success, or { ok: false, error } on failure.
 * Concurrent calls join the in-flight download and share its result instead
 * of failing — the startup warm-up and a user-initiated download must never
 * race into a spurious "download already in progress" error.
 */
export async function startManualEmbeddingDownload(): Promise<{ ok: boolean; alreadyReady?: boolean; error?: string }> {
  if (embeddingEngineInstance === undefined) return { ok: false, error: 'embedding engine not initialized' };

  // If the model is already loaded in this process, nothing to do.
  if (embeddingEngineInstance.available) {
    embeddingStatus = 'ready';
    return { ok: true, alreadyReady: true };
  }

  // Join an in-flight download rather than rejecting concurrent callers.
  if (downloadPromise !== undefined) return downloadPromise;

  embeddingStatus = 'downloading';
  downloadPromise = performDownload().finally(() => {
    downloadPromise = undefined;
  });
  return downloadPromise;
}

let downloadPromise: Promise<{ ok: boolean; alreadyReady?: boolean; error?: string }> | undefined;

async function performDownload(): Promise<{ ok: boolean; alreadyReady?: boolean; error?: string }> {
  try {
    let ok = await embeddingEngineInstance!.ensureReady();
    let error = ok ? undefined : embeddingEngineInstance!.lastError;

    // If the first attempt failed, wipe any partial/corrupted cache and retry once.
    if (!ok) {
      clearEmbeddingModelCache(getEmbeddingCacheDir());
      ok = await embeddingEngineInstance!.ensureReady();
      error = ok ? undefined : embeddingEngineInstance!.lastError;
    }

    embeddingStatus = ok ? 'ready' : 'failed';
    return { ok, error };
  } catch (error: unknown) {
    // Never let an unexpected failure (disk, fs permission) escape as an
    // unhandled rejection — surface it as a failed download instead.
    embeddingStatus = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
