import type { MemoryMemo } from './models.js';

/**
 * Text used to generate embeddings for a memo.
 * Combines the most semantically meaningful fields.
 */
export function buildEmbeddingText(memo: MemoryMemo): string {
  return `${memo.userNeed} ${memo.approach} ${memo.whatWorked}`;
}

export interface EmbeddingEngine {
  /** Whether the engine loaded successfully. */
  readonly available: boolean;

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
 * Create an embedding engine backed by fastembed.
 * Lazily loads the model on first use so startup is not blocked.
 */
export function createFastEmbedEngine(): EmbeddingEngine {
  let embedder: FastembedModel | null = null;
  let initPromise: Promise<FastembedModel | null> | null = null;
  let loadFailed = false;

  return {
    get available(): boolean {
      return !loadFailed;
    },

    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      if (loadFailed) return null;
      if (texts.length === 0) return [];

      try {
        if (embedder === null) {
          initPromise ??= loadEmbedder();
          embedder = await initPromise;
          if (embedder === null) {
            loadFailed = true;
            return null;
          }
        }

        const generator = embedder.embed(texts);

        const vectors: Float32Array[] = [];
        for await (const batch of generator) {
          for (const vec of batch) {
            vectors.push(new Float32Array(vec));
          }
        }
        return vectors.length > 0 ? vectors : null;
      } catch {
        loadFailed = true;
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
      if (embedder !== null) return true;
      try {
        initPromise ??= loadEmbedder();
        embedder = await initPromise;
        if (embedder === null) {
          initPromise = null;
          return false;
        }
        loadFailed = false;
        return true;
      } catch {
        initPromise = null;
        return false;
      }
    },
  };
}

async function loadEmbedder(): Promise<FastembedModel | null> {
  try {
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    return await FlagEmbedding.init({ model: EmbeddingModel.BGESmallZH });
  } catch {
    return null;
  }
}
