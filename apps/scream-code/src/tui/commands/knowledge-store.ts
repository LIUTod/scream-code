import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { KnowledgeStore, sharedKnowledgeStore, sharedKnowledgeStoreReady } from '@scream-code/knowledge';
import {
  classifyEmbeddingFailure,
  clearEmbeddingModelCache,
  hasEmbeddingModelCache as hasModelCache,
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
/** Whether the last manual download attempt failed (drives the 'failed' status). */
let lastManualFailed = false;

function getEmbeddingCacheDir(): string {
  const dir = join(getDataDir(), 'cache', 'fastembed');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Any usable cache: the model directory with its weights present.
 *
 * Such a cache can still be missing sidecars, which FlagEmbedding repairs from
 * the Hub while loading — so callers must not treat it as "no model here".
 * Flagging it as missing would block the very path that repairs it, and
 * fastembed itself skips downloading whenever the model directory exists.
 * The existence check itself lives in @scream-code/memory next to the cache
 * layout it inspects.
 */
export function hasEmbeddingModelCache(): boolean {
  return hasModelCache(getEmbeddingCacheDir());
}

/**
 * Get the singleton KnowledgeStore, initializing it on first access.
 * Delegates to the shared per-homeDir provider in @scream-code/knowledge so
 * this process keeps ONE store handle and ONE engine instance no matter how
 * many hosts (TUI command, agent session) ask for it. Concurrent callers share
 * one build, and a failed build clears the slot so the next caller retries.
 */
export function getKnowledgeStore(): Promise<KnowledgeStore> {
  knowledgeStorePromise ??= sharedKnowledgeStoreReady(getDataDir())
    .then(() => {
      const store = sharedKnowledgeStore(getDataDir());
      embeddingEngineInstance = store.getEmbeddingEngine();
      return store;
    })
    .catch((error: unknown) => {
      knowledgeStorePromise = undefined;
      throw error;
    });
  return knowledgeStorePromise;
}

/**
 * Derived from live facts instead of a mirrored flag: a download in flight,
 * the engine's own availability, and whether the last manual attempt failed.
 * Engine construction failures are reported separately via
 * getEmbeddingFailureKind and are intentionally not collapsed into 'failed'
 * — a missing download is not the only reason the model might not be ready.
 */
export function getEmbeddingStatus(): EmbeddingStatus {
  if (downloadPromise !== undefined) return 'downloading';
  if (embeddingEngineInstance?.available === true) return 'ready';
  if (lastManualFailed) return 'failed';
  return 'idle';
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
 * Only mutates the inputs behind the derived status; the actual download is
 * delegated to EmbeddingEngine.ensureReady() and saves the model to the shared cache dir.
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
    return { ok: true, alreadyReady: true };
  }

  // Join an in-flight download rather than rejecting concurrent callers.
  if (downloadPromise !== undefined) return downloadPromise;

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
      lastManualFailed = true;
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

    lastManualFailed = !ok;
    return ok ? { ok } : failureResult(error);
  } catch (error: unknown) {
    // Never let an unexpected failure (disk, fs permission) escape as an
    // unhandled rejection — surface it as a failed download instead.
    lastManualFailed = true;
    return failureResult(error instanceof Error ? error.message : String(error));
  }
}
