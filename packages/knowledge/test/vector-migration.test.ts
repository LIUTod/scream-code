import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KnowledgeStore } from '../src/store.js';
import type { EmbeddingEngine } from '../src/types.js';

function stubEngine(): EmbeddingEngine {
  return {
    available: true,
    modelName: 'stub',
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1])),
    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    },
    ensureReady: async () => true,
  } as EmbeddingEngine;
}

async function seedChunkWithEmbedding(dir: string): Promise<{
  chunkId: string;
  vec: Float32Array;
}> {
  const store = new KnowledgeStore(dir);
  await store.init();
  const source = await store.createSource({ name: 'doc.md' });
  const doc = await store.createDocument({ sourceId: source.id, title: 'Doc' });
  const vec = new Float32Array([0.25, -0.5, 0.75, 1]);
  const chunk = await store.insertChunk({
    sourceId: source.id,
    documentId: doc.id,
    rank: 0,
    heading: 'H',
    content: 'vectorized content',
    rawContent: 'vectorized content',
    embedding: vec,
  });
  store.close();
  return { chunkId: chunk.id, vec };
}

describe('vector storage migration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scream-vector-migration-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rewrites legacy JSON vectors to BLOBs (user_version 2) and search still matches', async () => {
    const { chunkId, vec } = await seedChunkWithEmbedding(dir);

    // Downgrade the stored value to legacy JSON text, exactly as v1 wrote it.
    const legacy = new DatabaseSync(join(dir, 'knowledge', 'knowledge.db'));
    legacy
      .prepare('UPDATE knowledge_chunks SET embedding_json = ? WHERE id = ?')
      .run(JSON.stringify(Array.from(vec)), chunkId);
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();

    // Re-open: migrateVectorsToBlob must convert text → blob and bump to 2.
    const store = new KnowledgeStore(dir);
    await store.init();

    const probe = new DatabaseSync(join(dir, 'knowledge', 'knowledge.db'));
    const userVersion = (
      probe.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version;
    const storedType = (
      probe
        .prepare('SELECT typeof(embedding_json) AS t FROM knowledge_chunks WHERE id = ?')
        .get(chunkId) as { t: string }
    ).t;
    probe.close();
    expect(userVersion).toBe(2);
    expect(storedType).toBe('blob');

    // The scan path must decode the BLOB and return the same score as before.
    store.setEmbeddingEngine(stubEngine());
    const hits = await store.searchChunksByVector(vec, { threshold: 0.9 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunk.id).toBe(chunkId);
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    store.close();
  });

  it('reads legacy JSON text even when the migration gate says it is done (dual-format)', async () => {
    const { chunkId, vec } = await seedChunkWithEmbedding(dir);

    // user_version 2 skips the migration, but the row still holds JSON text —
    // the exact half-migrated shape a crash between passes could leave behind.
    const legacy = new DatabaseSync(join(dir, 'knowledge', 'knowledge.db'));
    legacy
      .prepare('UPDATE knowledge_chunks SET embedding_json = ? WHERE id = ?')
      .run(JSON.stringify(Array.from(vec)), chunkId);
    legacy.exec('PRAGMA user_version = 2');
    legacy.close();

    const store = new KnowledgeStore(dir);
    await store.init();
    store.setEmbeddingEngine(stubEngine());
    const hits = await store.searchChunksByVector(vec, { threshold: 0.9 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunk.id).toBe(chunkId);
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    store.close();
  });
});
