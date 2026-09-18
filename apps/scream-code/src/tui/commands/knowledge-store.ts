import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { KnowledgeStore } from '@scream-code/knowledge';
import {
  classifyEmbeddingFailure,
  clearEmbeddingModelCache,
  createFastEmbedEngine,
  probeLocalEmbeddingSupport,
  type EmbeddingEngine,
  type EmbeddingFailureKind,
} from '@scream-code/memory';

import { getDataDir } from '#/utils/paths';

export type EmbeddingStatus = 'idle' | 'downloading' | 'ready' | 'failed';
/** Re-exported so callers of this module can name the failure reason they get. */
export type { EmbeddingFailureKind };

let knowledgeStorePromise: Promise<KnowledgeStore> | undefined;
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
 * Any usable cache: the model directory with its weights present.
 *
 * Such a cache can still be missing sidecars, which FlagEmbedding repairs from
 * the Hub while loading — so callers must not treat it as "no model here".
 * Flagging it as missing would block the very path that repairs it, and
 * fastembed itself skips downloading whenever the model directory exists.
 */
export function hasEmbeddingModelCache(): boolean {
  const modelDir = join(getEmbeddingCacheDir(), EMBEDDING_MODEL_DIR);
  return existsSync(modelDir) && existsSync(join(modelDir, 'model_optimized.onnx'));
}

/**
 * The store and its embedding engine are built together and published only once
 * both exist. Publishing the store first meant a single transient failure (a
 * locked knowledge.db, a full disk, a denied directory) left a store with no
 * engine that no later call could repair: every download then failed instantly
 * with "embedding engine not initialized" for the rest of the process.
 *
 * Concurrent callers share one build, and a failed build clears the slot so the
 * next caller retries from scratch.
 */
export function getKnowledgeStore(): Promise<KnowledgeStore> {
  knowledgeStorePromise ??= (async () => {
    const store = new KnowledgeStore(getDataDir());
    await store.init();
    const engine = createFastEmbedEngine(getEmbeddingCacheDir());
    store.setEmbeddingEngine(engine);
    embeddingEngineInstance = engine;
    return store;
  })().catch((error: unknown) => {
    knowledgeStorePromise = undefined;
    throw error;
  });
  return knowledgeStorePromise;
}

export function getEmbeddingStatus(): EmbeddingStatus {
  return embeddingStatus;
}

export interface EmbeddingDownloadResult {
  readonly ok: boolean;
  readonly alreadyReady?: boolean;
  readonly error?: string;
  /** Why it failed, when it failed: the notice picks its hint from this. */
  readonly failureKind?: EmbeddingFailureKind;
}

/**
 * Manually trigger the embedding model download/load.
 * Only mutates embeddingStatus; the actual download is delegated to
 * EmbeddingEngine.ensureReady() and saves the model to the shared cache dir.
 * Concurrent calls join the in-flight download and share its result instead
 * of failing — the startup warm-up and a user-initiated download must never
 * race into a spurious "download already in progress" error.
 */
export async function startManualEmbeddingDownload(): Promise<EmbeddingDownloadResult> {
  if (embeddingEngineInstance === undefined) {
    return failureResult('embedding engine not initialized');
  }

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

let downloadPromise: Promise<EmbeddingDownloadResult> | undefined;

function failureResult(error: string | undefined): EmbeddingDownloadResult {
  return { ok: false, error, failureKind: classifyEmbeddingFailure(error) };
}

async function performDownload(): Promise<EmbeddingDownloadResult> {
  try {
    // The native tokenizer binding loads when fastembed is imported, so a
    // platform without a published binary fails right here — before any
    // download exists to retry, and with a cache that has nothing to do with it.
    const support = await probeLocalEmbeddingSupport();
    if (!support.supported) {
      embeddingStatus = 'failed';
      // The import failed, so this machine cannot load the local model at all —
      // which is the platform case for every shape the native loader emits. An
      // unrecognised message keeps its own hint (retry / report) rather than
      // blaming the operating system.
      return { ok: false, error: support.error, failureKind: classifyEmbeddingFailure(support.error) };
    }

    let ok = await embeddingEngineInstance!.ensureReady();
    let error = ok ? undefined : embeddingEngineInstance!.lastError;

    // If the first attempt failed, wipe any partial/corrupted cache and retry once.
    if (!ok) {
      const kind = classifyEmbeddingFailure(error);
      if (kind !== 'platform') {
        // The staged archive goes too: a failed download leaves a partial one
        // behind, and fastembed skips downloading whenever it exists — the retry
        // would extract the same junk offline instead of fetching the model.
        clearEmbeddingModelCache(getEmbeddingCacheDir());
        ok = await embeddingEngineInstance!.ensureReady();
        error = ok ? undefined : embeddingEngineInstance!.lastError;
      }
    }

    embeddingStatus = ok ? 'ready' : 'failed';
    return ok ? { ok } : failureResult(error);
  } catch (error: unknown) {
    // Never let an unexpected failure (disk, fs permission) escape as an
    // unhandled rejection — surface it as a failed download instead.
    embeddingStatus = 'failed';
    return failureResult(error instanceof Error ? error.message : String(error));
  }
}
