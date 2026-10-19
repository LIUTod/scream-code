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
  type EmbeddingProgressListener,
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
 * Any usable cache: every file the embedding runtime needs is on disk.
 *
 * Loading then never downloads. A cache that only looks installed (weights
 * without the tokenizer, for instance) is deliberately *not* counted as ready:
 * the setup flow repairs it through one clean re-download instead of failing
 * halfway through a load, and reporting it as present would block that repair.
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
 *
 * `onProgress` observes the attempt (byte progress, then verify/load phases)
 * so the caller can keep a spinner honest; it is detached when the attempt
 * settles either way.
 */
export async function startManualEmbeddingDownload(
  onProgress?: EmbeddingProgressListener,
): Promise<EmbeddingDownloadResult> {
  if (embeddingEngineInstance === undefined) {
    return failureResult('embedding engine not initialized');
  }

  // If the model is already loaded in this process, nothing to do.
  if (embeddingEngineInstance.available) {
    return { ok: true, alreadyReady: true };
  }

  // Join an in-flight download rather than rejecting concurrent callers.
  if (downloadPromise !== undefined) return downloadPromise;

  embeddingEngineInstance.setProgressListener?.(onProgress);
  downloadPromise = performDownload().finally(() => {
    embeddingEngineInstance?.setProgressListener?.(undefined);
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
    // The runtime is JavaScript plus WebAssembly, so this probe only fails on a
    // broken installation (missing modules), never on an unsupported platform.
    const support = await probeLocalEmbeddingSupport();
    if (!support.supported) {
      lastManualFailed = true;
      return { ok: false, error: support.error, failureKind: classifyEmbeddingFailure(support.error) };
    }

    let ok = await embeddingEngineInstance!.ensureReady();
    let error = ok ? undefined : embeddingEngineInstance!.lastError;

    // Retry once, but only for a corrupt archive: that is the one failure a
    // wipe can cure. A network failure retried here doubles the wait for a
    // user who is already watching a stalled download (the downloader has its
    // own stall guards and reports the failure honestly), and a broken
    // installation will not fix itself by downloading again.
    if (!ok) {
      const kind = classifyEmbeddingFailure(error);
      if (kind === 'archive') {
        // The staged archive goes too: extraction failed, and a partial file
        // left behind would only be re-extracted on the next attempt.
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
