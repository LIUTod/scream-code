import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
import { EMBEDDING_TEXT_VERSION, type EmbeddingEngine } from '../src/embeddings.js';

/**
 * The bookkeeping a dream pass depends on: vectors that can be re-derived after
 * the embedded text changes, a per-memo "already looked at" stamp, and a merge
 * journal that makes a merge reversible.
 */

function fakeEngine(): EmbeddingEngine {
  return {
    available: true,
    modelName: 'fake',
    embedBatch: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
    cosineSimilarity: () => 1,
    ensureReady: async () => true,
  };
}

/** The backfill queues work behind a 2s debounce; let it run for real (the
 * flush uses timers, so fake ones would need to be pumped by hand too). */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 2_200));
}

function memo(id: string) {
  return createMemoryMemo({
    id,
    sourceSessionId: 's1',
    sourceSessionTitle: 'Session',
    userNeed: '需要一件事',
    approach: '做法',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: '有效',
    extractionSource: 'exit',
    recordedAt: Date.now(),
    projectDir: '',
  });
}

describe('memory store — dream bookkeeping', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-reindex-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('backfills vectors that were written before an engine existed', async () => {
    // No engine attached: the memo is stored but has no vector, which used to
    // make it invisible to recall forever.
    await store.append(memo('m1'));
    expect(EMBEDDING_TEXT_VERSION).toBe(2);
    // Without an engine (and without letting the backfill load one), there is
    // nothing to embed yet.
    const filled = await store.backfillMissingEmbeddings({ limit: 10, loadEngine: false });
    expect(filled).toBe(0);

    store.setEmbeddingEngine(fakeEngine());
    await expect(store.backfillMissingEmbeddings({ limit: 10 })).resolves.toBe(1);
    await settle();
    expect((await store.allVectors()).has('m1')).toBe(true);
    // A second call has nothing left to do — the row carries the current text
    // version, so it is neither missing nor stale.
    await expect(store.backfillMissingEmbeddings({ limit: 10 })).resolves.toBe(0);
  });

  it('marks memos as looked at, which is what makes a later pass incremental', async () => {
    await store.append(memo('seen'));
    let found = 0;
    for await (const entry of store.read()) {
      expect(entry.dreamedAt).toBeUndefined();
      found += 1;
    }
    expect(found).toBe(1);

    const at = Date.now();
    await store.markDreamed(['seen'], at);
    for await (const entry of store.read()) {
      expect(entry.dreamedAt).toBe(at);
    }
  });

  it('records a merge and restores the sources on undo', async () => {
    await store.append(memo('a'));
    await store.append(memo('b'));
    await store.append(
      createMemoryMemo({
        ...memo('merged'),
        distilled: '当遇到需要一件事时，直接用做法做完',
        origin: 'dream',
      }),
    );
    const sources = [await store.get('a'), await store.get('b')];
    await store.recordMerge('merged', sources.filter((entry) => entry !== undefined));
    await store.delete('a');
    await store.delete('b');

    expect(await store.revertMerge('merged')).toBe(true);
    expect(await store.get('a')).toBeDefined();
    expect(await store.get('b')).toBeDefined();
    expect(await store.get('merged')).toBeUndefined();
    // A second undo has nothing to do.
    expect(await store.revertMerge('merged')).toBe(false);
  });
});
