import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { EmbeddingEngine } from '../src/embeddings.js';
import { createMemoryMemo, type MemoryMemo } from '../src/models.js';
import { EMBEDDING_FLUSH_CHUNK_SIZE, MemoryMemoStore } from '../src/store.js';

/** Deterministic engine: one 3-dim vector per text, derived from its length. */
function makeEngine(): EmbeddingEngine {
  return {
    available: true,
    modelName: 'stub-model',
    embedBatch: (texts: string[]) =>
      Promise.resolve(texts.map((text) => Float32Array.from([text.length, 1, 0]))),
    cosineSimilarity: () => 1,
    ensureReady: () => Promise.resolve(true),
  };
}

function makeMemo(overrides: Partial<MemoryMemo> = {}): MemoryMemo {
  return createMemoryMemo({
    userNeed: 'Need',
    approach: 'Approach',
    outcome: 'done',
    whatFailed: 'none',
    whatWorked: 'worked',
    extractionSource: 'compaction',
    sourceSessionId: 'session-1',
    ...overrides,
  });
}

function embeddingRowCount(store: MemoryMemoStore): number {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const row = db.prepare('SELECT COUNT(*) AS count FROM memory_embeddings').get() as {
    count: number;
  };
  return row.count;
}

/** Let the debounced flush fire and its async work settle. */
async function settleFlush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_100);
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('MemoryMemoStore embedding flush (real SQLite)', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;
  let warnings: Array<{ message: string; meta: unknown }>;

  async function openStore(): Promise<MemoryMemoStore> {
    const opened = new MemoryMemoStore(tmpDir, {
      warn: (message: string, meta?: unknown) => {
        warnings.push({ message, meta });
      },
    });
    await opened.init();
    return opened;
  }

  /** A process restart: the in-memory embedding queue is gone, the database stays. */
  async function restartStore(): Promise<void> {
    store.close();
    store = await openStore();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-memory-embed-'));
    warnings = [];
    store = await openStore();
  });

  afterEach(async () => {
    store.close();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('persists a vector for a newly appended memo and reports no failure', async () => {
    store.setEmbeddingEngine(makeEngine());
    const memo = makeMemo();

    await store.append(memo);
    await settleFlush();

    expect(warnings.filter((w) => w.message === 'embedding flush failed')).toEqual([]);
    expect(embeddingRowCount(store)).toBe(1);
    expect(store.hasEmbeddings()).toBe(true);
    expect(store.embeddingStatus().degraded).toBe(false);
  });

  it('does not re-embed a memo that already has a vector', async () => {
    const embedBatch = vi.fn((texts: string[]) =>
      Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0]))),
    );
    store.setEmbeddingEngine({ ...makeEngine(), embedBatch });
    const memo = makeMemo();

    await store.append(memo);
    await settleFlush();
    expect(embedBatch).toHaveBeenCalledTimes(1);

    store.scheduleEmbedding(memo);
    await settleFlush();

    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embeddingRowCount(store)).toBe(1);
  });

  it('backfills memos that were written before any vector could be stored', async () => {
    const first = makeMemo({ userNeed: 'first need' });
    const second = makeMemo({ userNeed: 'second need' });
    await store.append(first);
    await store.append(second);
    await restartStore();
    expect(embeddingRowCount(store)).toBe(0);

    store.setEmbeddingEngine(makeEngine());
    expect(await store.backfillMissingEmbeddings({ loadEngine: true })).toBe(2);
    await settleFlush();

    expect(embeddingRowCount(store)).toBe(2);
    expect(await store.searchByVector(Float32Array.from([1, 1, 0]), { candidateLimit: 5 })).toHaveLength(2);
  });

  it('backfill skips memos that already have a vector and respects the limit', async () => {
    const memos = [makeMemo({ userNeed: 'a' }), makeMemo({ userNeed: 'b' }), makeMemo({ userNeed: 'c' })];
    for (const memo of memos) await store.append(memo);
    await restartStore();

    const embedBatch = vi.fn((texts: string[]) =>
      Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0]))),
    );
    store.setEmbeddingEngine({ ...makeEngine(), embedBatch });
    expect(await store.backfillMissingEmbeddings({ limit: 2 })).toBe(2);
    await settleFlush();
    expect(embeddingRowCount(store)).toBe(2);

    // Only the one memo still without a vector is queued — not all three.
    expect(await store.backfillMissingEmbeddings({ limit: 10 })).toBe(1);
    await settleFlush();
    expect(embeddingRowCount(store)).toBe(3);
    // 2 from the first pass, exactly the 1 missing one from the second.
    const embeddedTexts = embedBatch.mock.calls.flatMap((call) => call[0]);
    expect(embeddedTexts).toHaveLength(3);
  });
});

/** Memos written before an engine existed, then a process restart: a pure backlog. */
async function backlog(
  store: MemoryMemoStore,
  count: number,
  restart: () => Promise<void>,
): Promise<void> {
  for (let i = 0; i < count; i += 1) await store.append(makeMemo({ userNeed: `backlog need ${String(i)}` }));
  await restart();
}

describe('MemoryMemoStore embedding flush: a backlog must not freeze the process', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;
  const open = async (): Promise<MemoryMemoStore> => {
    const opened = new MemoryMemoStore(tmpDir);
    await opened.init();
    return opened;
  };
  const restart = async (): Promise<void> => {
    store.close();
    store = await open();
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-memory-embed-chunk-'));
    store = await open();
  });

  afterEach(async () => {
    store.close();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('embeds in small chunks and lets the event loop run between them', async () => {
    const total = EMBEDDING_FLUSH_CHUNK_SIZE * 3 + 1;
    await backlog(store, total, restart);

    // Real embedding runs on the main thread: 106 memos blocked it for 14 s in
    // one stretch. A turn of the event loop between chunks is what keeps the
    // UI alive, so count turns that happen between consecutive embedBatch calls.
    let ticks = 0;
    let running = true;
    const tick = (): void => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const batches: Array<{ size: number; ticksAtStart: number }> = [];
    store.setEmbeddingEngine({
      ...makeEngine(),
      embedBatch: (texts: string[]) => {
        batches.push({ size: texts.length, ticksAtStart: ticks });
        return Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0])));
      },
    });

    await store.backfillMissingEmbeddings({ loadEngine: true });
    await settleFlush();
    running = false;

    expect(embeddingRowCount(store)).toBe(total);
    expect(Math.max(...batches.map((batch) => batch.size))).toBeLessThanOrEqual(
      EMBEDDING_FLUSH_CHUNK_SIZE,
    );
    expect(batches.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < batches.length; i += 1) {
      expect(batches[i]!.ticksAtStart).toBeGreaterThan(batches[i - 1]!.ticksAtStart);
    }
  });

  it('a failing chunk keeps what was stored and re-queues only the rest', async () => {
    const total = EMBEDDING_FLUSH_CHUNK_SIZE * 3;
    await backlog(store, total, restart);
    let call = 0;
    store.setEmbeddingEngine({
      ...makeEngine(),
      embedBatch: (texts: string[]) => {
        call += 1;
        // Calls 2 and 3: chunk 2 and its one immediate retry (tryEmbedBatch).
        const broken = call === 2 || call === 3;
        return Promise.resolve(broken ? null : texts.map(() => Float32Array.from([1, 0, 0])));
      },
    });

    await store.backfillMissingEmbeddings({ loadEngine: true });
    await settleFlush();

    // Chunk 1 is stored for good; chunk 2 failed; chunk 3 was never tried.
    expect(embeddingRowCount(store)).toBe(EMBEDDING_FLUSH_CHUNK_SIZE);
    expect(store.embeddingStatus().degraded).toBe(true);
    // Only the memos that still need a vector are owed — not the stored chunk.
    const owedQueue = (store as unknown as { embeddingQueue: Set<string> }).embeddingQueue;
    expect(owedQueue.size).toBe(total - EMBEDDING_FLUSH_CHUNK_SIZE);

    // The failed chunk and everything after it are still owed, nothing else.
    store.setEmbeddingEngine(makeEngine());
    expect(await store.backfillMissingEmbeddings({ loadEngine: true })).toBe(
      total - EMBEDDING_FLUSH_CHUNK_SIZE,
    );
    await settleFlush();
    expect(embeddingRowCount(store)).toBe(total);
  });

  it('does not retry a broken engine on a timer: one failed flush is not a retry storm', async () => {
    await backlog(store, 3, restart);
    const embedBatch = vi.fn((_texts: string[]) => Promise.resolve(null));
    store.setEmbeddingEngine({ ...makeEngine(), embedBatch });

    await store.backfillMissingEmbeddings({ loadEngine: true });
    await settleFlush();
    const afterFirst = embedBatch.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Nothing new was written; a retry would have to come from the flush itself.
    await settleFlush();
    await settleFlush();

    expect(embedBatch.mock.calls.length).toBe(afterFirst);
  });

  it('flushes a memo written while an earlier flush is still running', async () => {
    await backlog(store, 1, restart);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    store.setEmbeddingEngine({
      ...makeEngine(),
      embedBatch: async (texts: string[]) => {
        if (first) {
          first = false;
          await gate;
        }
        return texts.map(() => Float32Array.from([1, 0, 0]));
      },
    });
    await store.backfillMissingEmbeddings({ loadEngine: true });
    await vi.advanceTimersByTimeAsync(2_100); // the first flush starts and parks on the gate

    const late = makeMemo({ userNeed: 'written mid-flush' });
    await store.append(late);
    // The debounce for the late memo fires while the first flush is STILL
    // running and is ignored (one flush at a time). Only a re-arm when the
    // running flush ends can pick the memo up; nothing else will trigger it.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(embeddingRowCount(store)).toBe(0);
    release?.();
    await settleFlush();
    await settleFlush();

    expect(embeddingRowCount(store)).toBe(2);
  });
});

describe('MemoryMemoStore backfill never wakes a model that is not there', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-memory-embed-gate-'));
    store = new MemoryMemoStore(tmpDir);
    await store.init();
    await store.append(makeMemo());
    store.close();
    store = new MemoryMemoStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  function coldEngine(ensureReady: () => Promise<boolean>): EmbeddingEngine {
    return { ...makeEngine(), available: false, ensureReady };
  }

  it('does nothing by default when the engine is not loaded: no load, so no model download', async () => {
    const ensureReady = vi.fn(() => Promise.resolve(true));
    store.setEmbeddingEngine(coldEngine(ensureReady));

    expect(await store.backfillMissingEmbeddings()).toBe(0);
    await settleFlush();

    expect(ensureReady).not.toHaveBeenCalled();
  });

  it('loads the engine only when the caller says the model is already on disk', async () => {
    const ensureReady = vi.fn(() => Promise.resolve(true));
    store.setEmbeddingEngine(coldEngine(ensureReady));

    expect(await store.backfillMissingEmbeddings({ loadEngine: true })).toBe(1);

    expect(ensureReady).toHaveBeenCalledTimes(1);
  });
});
