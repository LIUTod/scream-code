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

function createFastEmbedEngineImpl(cacheDir?: string): EmbeddingEngine {
  let embedder: FastembedModel | null = null;
  let initPromise: Promise<FastembedModel | null> | null = null;
  let loadFailed = false;
  let lastError: string | undefined;

  return {
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
        loadFailed = true;
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
        initPromise = null;
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
    await ensureFastembedModelSidecars(String(model), cacheDir);
    return await FlagEmbedding.init(initOpts as Parameters<typeof FlagEmbedding.init>[0]);
  }
}

/**
 * Remove any previously downloaded model files for the fixed BGESmallZH model.
 * Called before a manual re-download so that a corrupted/partial cache does not
 * cause fastembed to fail repeatedly.
 */
export function clearEmbeddingModelCache(cacheDir: string): void {
  const modelDir = join(cacheDir, 'fast-bge-small-zh-v1.5');
  if (existsSync(modelDir)) {
    rmSync(modelDir, { recursive: true, force: true });
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
