import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryMemo } from './models.js';

/**
 * Text used to generate embeddings for a memo.
 * Combines the most semantically meaningful fields.
 */
export function buildEmbeddingText(memo: MemoryMemo): string {
  return `${memo.userNeed} ${memo.approach} ${memo.whatWorked}`;
}

export interface EmbeddingEngine {
  /** Whether the model is loaded in memory and ready to embed. */
  readonly available: boolean;

  /**
   * Stable identity of the embedding model producing the vectors (e.g.
   * "bge-small-zh-v1.5"). Persisted alongside stored vectors so consumers can
   * detect a model change instead of silently comparing incompatible spaces.
   */
  readonly modelName: string;

  /** Last load/download error message, if any. */
  readonly lastError?: string;

  /**
   * Generate embeddings for a batch of texts.
   * Returns null if the engine failed to load or the model is unavailable.
   */
  embedBatch(texts: string[]): Promise<Float32Array[] | null>;

  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number;

  /**
   * Proactively trigger model loading (downloads the model on first call).
   * Returns true if the engine is ready for embedding, false on failure.
   * Safe to call multiple times; failed loads can be retried.
   */
  ensureReady(): Promise<boolean>;
}

/** Minimal interface for the fastembed model — avoids importing fastembed at module level. */
interface FastembedModel {
  embed(
    textStrings: string[],
    batchSize?: number,
  ): AsyncGenerator<number[][], void, unknown>;
}

/**
 * Cache of created engines keyed by cacheDir.
 * Guarantees that all callers sharing the same cacheDir reuse the same engine
 * instance and the same in-flight model download/load — avoiding duplicate
 * downloads and file-corruption races when /memory and /knowledge both start
 * before the model is cached.
 */
const engineCache = new Map<string, EmbeddingEngine>();

/**
 * Create an embedding engine backed by fastembed.
 * Lazily loads the model on first use so startup is not blocked.
 * Engines are cached by cacheDir so repeated calls with the same cacheDir
 * return the same instance, sharing model state and download progress.
 * @param cacheDir Absolute path for model cache (e.g. ~/.scream-code/cache/fastembed).
 *                 Defaults to "local_cache" (CWD-relative) if not provided — prefer
 *                 passing an explicit path so the cache doesn't duplicate across CWDs.
 */
export function createFastEmbedEngine(cacheDir?: string): EmbeddingEngine {
  const key = cacheDir ?? '';
  const cached = engineCache.get(key);
  if (cached !== undefined) return cached;
  const engine = createFastEmbedEngineImpl(cacheDir);
  engineCache.set(key, engine);
  return engine;
}

/** Stable identity of the model used by every engine created here. */
export const EMBEDDING_MODEL_NAME = 'bge-small-zh-v1.5';

function createFastEmbedEngineImpl(cacheDir?: string): EmbeddingEngine {
  let embedder: FastembedModel | null = null;
  let initPromise: Promise<FastembedModel | null> | null = null;
  let loadFailed = false;
  let lastError: string | undefined;

  return {
    modelName: EMBEDDING_MODEL_NAME,

    get available(): boolean {
      return embedder !== null && !loadFailed;
    },

    get lastError(): string | undefined {
      return lastError;
    },

    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      if (!this.available) return null;
      if (texts.length === 0) return [];

      try {
        const generator = embedder!.embed(texts);

        const vectors: Float32Array[] = [];
        for await (const batch of generator) {
          for (const vec of batch) {
            vectors.push(new Float32Array(vec));
          }
        }
        return vectors.length > 0 ? vectors : null;
      } catch (error: unknown) {
        // A runtime failure of one batch is NOT a load failure. Marking
        // loadFailed here would permanently degrade this shared engine (and
        // with it both /memory and /knowledge vector search). Keep the error
        // for diagnostics; the caller retries on the next flush.
        lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
    },

    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    },

    async ensureReady(): Promise<boolean> {
      if (embedder !== null) {
        loadFailed = false;
        lastError = undefined;
        return true;
      }
      try {
        // Reuse in-flight load, or start a fresh one. If a previous load
        // resolved to null (loadFailed), clear it first so we actually retry.
        if (loadFailed || initPromise === null) {
          loadFailed = false;
          lastError = undefined;
          initPromise = loadEmbedder(cacheDir);
        }
        embedder = await initPromise;
        if (embedder === null) {
          initPromise = null;
          lastError = 'fastembed returned an empty model';
          return false;
        }
        loadFailed = false;
        lastError = undefined;
        return true;
      } catch (error: unknown) {
        // A MODEL-LOAD failure is a load failure: mark it so `available`
        // reports false and the next ensureReady() actually retries the load
        // (instead of silently recycling a failed embedder). Runtime embed
        // batch failures (embedBatch) intentionally do NOT set this flag —
        // they retry on the next flush.
        initPromise = null;
        loadFailed = true;
        lastError = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
  };
}

async function loadEmbedder(cacheDir?: string): Promise<FastembedModel | null> {
  const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
  if (cacheDir !== undefined) {
    mkdirSync(cacheDir, { recursive: true });
  }
  const model = EmbeddingModel.BGESmallZH;
  const initOpts = cacheDir !== undefined
    ? { model, cacheDir }
    : { model };
  try {
    return await FlagEmbedding.init(initOpts as Parameters<typeof FlagEmbedding.init>[0]);
  } catch (initError: unknown) {
    // If init fails due to missing config/tokenizer sidecars, download them
    // from HuggingFace mirror and retry.
    const msg = initError instanceof Error ? initError.message : '';
    if (!/Config file not found|Tokenizer file not found|Tokens map file not found/ui.test(msg)) {
      throw initError;
    }
    await ensureFastembedModelSidecars(model, cacheDir);
    return FlagEmbedding.init(initOpts as Parameters<typeof FlagEmbedding.init>[0]);
  }
}

/**
 * Cache entry names fastembed uses for the fixed BGESmallZH model: it extracts
 * into `<cacheDir>/<name>/` from the staged archive `<cacheDir>/<name>.tar.gz`.
 */
const BGESMALLZH_CACHE_NAME = 'fast-bge-small-zh-v1.5';

/** Why a local embedding load failed, as far as the message can tell. */
export type EmbeddingFailureKind = 'platform' | 'archive' | 'network' | 'other';

// The shapes these failures arrive in, verified against the real errors:
//   platform → "Cannot find module '@anush008/tokenizers-linux-arm64-gnu'"
//              (the native tokenizer binding loads when fastembed is imported,
//              so an unsupported platform/arch/libc fails before any I/O)
//              …or the binding *is* installed but cannot be loaded: musl hosts
//              loading a glibc build, an older glibc than the prebuilt needs, a
//              wrong-architecture binary — all dlopen failures with these texts.
//   archive  → "TAR_BAD_ARCHIVE: Unrecognized archive format" from a staged
//              archive that is truncated or an HTML error page
//   network  → transport errors, and an HTTP status when the downloader reports
//              one instead of throwing a code (heuristic, but a status never
//              shows up in a cache-path problem)
const PLATFORM_FAILURE =
  /@anush008\/tokenizers|Failed to load native binding|Unsupported (?:OS|platform|architecture)|ERR_DLOPEN_FAILED|invalid ELF header|Exec format error|is not a valid Win32 application|GLIBC_\d+[^"\n]*not found|Error loading shared library|cannot open shared object file/iu;
const ARCHIVE_FAILURE = /\bTAR_[A-Z_]+|incorrect header check|unexpected end of file|invalid tar|zlib/iu;
const NETWORK_FAILURE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|socket hang up|fetch failed)\b|network error|HTTP \d{3}/iu;

/**
 * Classify a load failure so callers can say something true about it: the four
 * causes need four different answers (unsupported platform, corrupt cache,
 * network, unknown), and they used to be reported as one network problem.
 */
export function classifyEmbeddingFailure(message: string | undefined): EmbeddingFailureKind {
  if (message === undefined) return 'other';
  if (PLATFORM_FAILURE.test(message)) return 'platform';
  if (ARCHIVE_FAILURE.test(message)) return 'archive';
  if (NETWORK_FAILURE.test(message)) return 'network';
  return 'other';
}

/**
 * Loads only the module entry point — no model download — so callers can tell
 * "this machine cannot run the local model at all" apart from "the download
 * failed". fastembed imports its native tokenizer binding at module scope, which
 * is exactly the step a platform without a published binary cannot pass.
 */
export async function probeLocalEmbeddingSupport(): Promise<{ supported: boolean; error?: string }> {
  try {
    await import('fastembed');
    return { supported: true };
  } catch (error: unknown) {
    return { supported: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove every trace of a previous BGESmallZH download: the extracted model
 * directory *and* the staged archive it came from.
 *
 * The archive has to go with it. fastembed skips the download whenever
 * `<cacheDir>/<name>.tar.gz` exists, and it only deletes that file after a
 * *successful* extract — its download error paths (response error, file stream
 * error) reject and leave whatever was written behind. So an archive sitting
 * next to a failed attempt is usually a partial leftover, and keeping it makes
 * every retry extract the same junk locally: no network traffic, a few
 * milliseconds, the same failure forever.
 *
 * Never throws: a file locked by another process (on Windows a mapped ONNX file
 * stays locked) must not replace the download error the caller is reporting.
 */
export function clearEmbeddingModelCache(cacheDir: string): void {
  for (const name of [BGESMALLZH_CACHE_NAME, `${BGESMALLZH_CACHE_NAME}.tar.gz`]) {
    const target = join(cacheDir, name);
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // The next attempt retries the wipe; the caller keeps its own error.
    }
  }
}

/**
 * Small config/tokenizer files that fastembed expects alongside model.onnx.
 * If these are missing (e.g. GCS download partially failed), fastembed throws.
 * We download them from HuggingFace so the model can load — this covers the
 * case where the GCS tarball was incomplete but the HF repo is reachable.
 */
const FASTEMBED_SIDECARS = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
] as const;

const FASTEMBED_HF_REPOS: Record<string, string> = {
  'fast-bge-small-zh-v1.5': 'BAAI/bge-small-zh-v1.5',
};

async function ensureFastembedModelSidecars(model: string, cacheDir?: string): Promise<void> {
  const repo = FASTEMBED_HF_REPOS[model];
  if (repo === undefined) return;
  const baseDir = cacheDir ?? 'local_cache';
  const modelDir = join(baseDir, model);
  mkdirSync(modelDir, { recursive: true });

  for (const fileName of FASTEMBED_SIDECARS) {
    const target = join(modelDir, fileName);
    try {
      const { access } = await import('node:fs/promises');
      await access(target);
      continue; // file exists
    } catch {
      // file missing — download from HuggingFace
    }
    const hfUrl = `https://huggingface.co/${repo}/resolve/main/${fileName}`;
    try {
      const response = await fetch(hfUrl);
      if (!response.ok) continue;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
    } catch {
      // best-effort — if HF is also unreachable, just skip
    }
  }
}
