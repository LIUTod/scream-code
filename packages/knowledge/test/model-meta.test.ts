import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestContent } from '../src/ingest.js';
import { multiSearchWithTrace } from '../src/search.js';
import { EMBEDDING_MODEL_META_KEY, KnowledgeStore } from '../src/store.js';
import type { EmbeddingEngine, LlmCaller } from '../src/types.js';

/** Minimal deterministic engine stub with a configurable model identity. */
function makeEngine(modelName: string, available = true): EmbeddingEngine {
  return {
    modelName,
    available,
    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      if (!available) return null;
      return texts.map((t) => {
        const vec = new Float32Array(8);
        for (let i = 0; i < t.length; i++) vec[i % 8]! += (t.codePointAt(i) % 7) + 1;
        return vec;
      });
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
      return available;
    },
  };
}

/** Stub LLM returning a canned extraction — enough for ingestContent. */
function makeLlm(): LlmCaller {
  return {
    async generate(systemPrompt: string) {
      if (systemPrompt.includes('knowledge content extractor')) {
        return JSON.stringify({
          items: [
            {
              title: 'Rust Language',
              summary: 'About Rust',
              content: 'Rust is a systems programming language focused on safety.',
              category: 'definition',
              keywords: ['rust'],
              entities: [{ type: 'subject', name: 'Rust', description: 'Rust language' }],
            },
          ],
        });
      }
      return '';
    },
  };
}

const DOC_CONTENT = '## Rust Language\nRust is a systems programming language focused on safety.';

describe('embedding model meta (version key)', () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-knowledge-meta-'));
    store = new KnowledgeStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('getMeta returns null for missing keys and round-trips values', async () => {
    expect(await store.getMeta('nope')).toBeNull();
    await store.setMeta('k', 'v');
    expect(await store.getMeta('k')).toBe('v');
    await store.setMeta('k', 'v2');
    expect(await store.getMeta('k')).toBe('v2');
  });

  it('first ingest stamps the embedding model meta', async () => {
    store.setEmbeddingEngine(makeEngine('m1'));
    await ingestContent(store, makeLlm(), { name: 'a.md', content: DOC_CONTENT });
    expect(await store.getMeta(EMBEDDING_MODEL_META_KEY)).toBe('m1');
  });

  it('ingest with a different model is blocked with a clear error', async () => {
    store.setEmbeddingEngine(makeEngine('m1'));
    await ingestContent(store, makeLlm(), { name: 'a.md', content: DOC_CONTENT });

    store.setEmbeddingEngine(makeEngine('m2'));
    await expect(
      ingestContent(store, makeLlm(), { name: 'b.md', content: DOC_CONTENT }),
    ).rejects.toThrow(/m1.*m2|嵌入/u);
    // The mismatched ingest must not leave a partial source behind.
    expect((await store.listSources()).length).toBe(1);
  });

  it('search with a mismatched model falls back to FTS and reports why', async () => {
    store.setEmbeddingEngine(makeEngine('m1'));
    await ingestContent(store, makeLlm(), { name: 'a.md', content: DOC_CONTENT });

    store.setEmbeddingEngine(makeEngine('m2'));
    const { results, trace } = await multiSearchWithTrace(store, makeLlm(), 'Rust', { topK: 3 });
    expect(trace.fallbackReason).toContain('mismatch');
    // Keyword fallback still finds the literal token.
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content.toLowerCase()).toContain('rust');
  });

  it('reembedSource fills missing vectors and stamps the meta', async () => {
    // Ingest while the engine is unavailable → all vectors NULL (legacy
    // broken state).
    store.setEmbeddingEngine(makeEngine('m1', false));
    await ingestContent(store, makeLlm(), { name: 'a.md', content: DOC_CONTENT });

    let coverage = await store.embeddingCoverage();
    expect(coverage.total).toBeGreaterThan(0);
    expect(coverage.embedded).toBe(0);

    const source = (await store.listSources())[0]!;
    const counts = await store.reembedSource(source.id, makeEngine('m1'));
    expect(counts.chunks).toBe(coverage.total);
    expect(counts.events).toBeGreaterThan(0);
    expect(counts.entities).toBeGreaterThan(0);

    coverage = await store.embeddingCoverage();
    expect(coverage.embedded).toBe(coverage.total);
    expect(await store.getMeta(EMBEDDING_MODEL_META_KEY)).toBe('m1');
  });

  it('reembedSource on an unavailable engine throws without writing', async () => {
    store.setEmbeddingEngine(makeEngine('m1', false));
    await ingestContent(store, makeLlm(), { name: 'a.md', content: DOC_CONTENT });
    const source = (await store.listSources())[0]!;
    await expect(store.reembedSource(source.id, makeEngine('m1', false))).rejects.toThrow(
      /unavailable/i,
    );
    expect((await store.embeddingCoverage()).embedded).toBe(0);
  });

  it('embeddingCoverage is zero on an empty store', async () => {
    expect(await store.embeddingCoverage()).toEqual({ total: 0, embedded: 0 });
  });
});
