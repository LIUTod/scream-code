import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestContent, ingestFile } from '../src/ingest.js';
import { KnowledgeStore } from '../src/store.js';
import type { EmbeddingEngine, LlmCaller } from '../src/types.js';

function makeEngine(): EmbeddingEngine {
  return {
    modelName: 'sync-stub',
    available: true,
    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      return texts.map((t) => {
        const vec = new Float32Array(8);
        for (let i = 0; i < t.length; i++) vec[i % 8]! += ((t.codePointAt(i) ?? 0) % 7) + 1;
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
      return true;
    },
  };
}

function makeLlm(): LlmCaller {
  return {
    async generate(systemPrompt: string) {
      if (systemPrompt.includes('knowledge content extractor')) {
        return JSON.stringify({
          items: [
            {
              title: 'Doc Event',
              summary: 'S',
              content: 'content',
              category: 'definition',
              keywords: ['doc'],
              entities: [{ type: 'subject', name: 'Doc', description: 'the document' }],
            },
          ],
        });
      }
      return '';
    },
  };
}

describe('content fingerprint sync (same-path update)', () => {
  let tmpDir: string;
  let docDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-knowledge-sync-'));
    docDir = await mkdtemp(join(tmpdir(), 'scream-sync-docs-'));
    store = new KnowledgeStore(tmpDir);
    await store.init();
    store.setEmbeddingEngine(makeEngine());
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
    await rm(docDir, { recursive: true, force: true });
  });

  it('first ingest creates; identical content skips without recomputing', async () => {
    const file = join(docDir, 'note.md');
    await writeFile(file, '## Topic\noriginal content here.');

    const first = await ingestFile(store, makeLlm(), file);
    expect(first.outcome).toBe('created');
    const chunkCount = first.chunkCount;
    expect(chunkCount).toBeGreaterThan(0);

    const again = await ingestFile(store, makeLlm(), file);
    expect(again.outcome).toBe('unchanged');
    expect(again.chunkCount).toBe(0);
    // The library must not have grown a second copy.
    expect((await store.listSources()).length).toBe(1);
    expect((await store.stats()).chunks).toBe(chunkCount);
  });

  it('changed content replaces the old version and the new text is searchable', async () => {
    const file = join(docDir, 'note.md');
    await writeFile(file, '## Topic\noriginal content here.');
    await ingestFile(store, makeLlm(), file);

    await writeFile(file, '## Topic\nrewritten with a freshmarker keyword.');
    const second = await ingestFile(store, makeLlm(), file);
    expect(second.outcome).toBe('updated');

    // No leftovers from the old version: still exactly one source.
    expect((await store.listSources()).length).toBe(1);

    // FTS keyword search finds the new marker and no longer the old text.
    const hits = await store.ftsSearchChunks('freshmarker', 10);
    expect(hits.length).toBeGreaterThan(0);
    const old = await store.ftsSearchChunks('original', 10);
    expect(old.length).toBe(0);
  });

  it('legacy rows (content_hash NULL) are backfilled and skipped on the next run', async () => {
    const file = join(docDir, 'legacy.md');
    await writeFile(file, '## Legacy\nbaseline content.');
    await ingestFile(store, makeLlm(), file);

    // Simulate a pre-fingerprint library row.
    const source = (await store.listSources())[0]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db
      .prepare('UPDATE knowledge_sources SET content_hash = NULL WHERE id = ?')
      .run(source.id);

    const again = await ingestFile(store, makeLlm(), file);
    expect(again.outcome).toBe('unchanged');
    expect((await store.listSources())[0]!.contentHash).not.toBeNull();
  });

  it('ingestContent keeps reporting created', async () => {
    const result = await ingestContent(store, makeLlm(), {
      name: 'inline.md',
      content: '## Inline\ninline content.',
    });
    expect(result.outcome).toBe('created');
  });
});
