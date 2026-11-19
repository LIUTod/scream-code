import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmbeddingEngine } from '../src/embeddings.js';
import { createMemoryMemo, type MemoryMemo } from '../src/models.js';
import { recallMemos } from '../src/recall.js';
import { MemoryMemoStore } from '../src/store.js';

const PROJECT = '/work/app';

/**
 * A unit vector whose cosine with the query ([1, 0, 0]) is `similarity`;
 * `turn` rotates it around the query, so two memos can be equally close to
 * the query yet different from each other.
 */
function at(similarity: number, turn = 0): number[] {
  const rest = Math.sqrt(1 - similarity * similarity);
  return [similarity, rest * Math.cos(turn), rest * Math.sin(turn)];
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function engine(available = true): EmbeddingEngine & { embedBatch: ReturnType<typeof vi.fn> } {
  return {
    available,
    modelName: 'stub',
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0]))),
    cosineSimilarity: cosine,
    ensureReady: async () => available,
  };
}

let dir: string;
let store: MemoryMemoStore;
let seq = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scream-recall-'));
  store = new MemoryMemoStore(dir);
  await store.init();
  seq = 0;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Store a memo whose vector sits at `similarity` to the query. */
async function memo(similarity: number, overrides: Partial<MemoryMemo> = {}, turn = 0): Promise<MemoryMemo> {
  seq += 1;
  const entry = createMemoryMemo({
    id: `memo-t${String(seq)}-x`,
    userNeed: `need ${String(seq)}`,
    approach: 'approach',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'worked',
    extractionSource: 'compaction',
    sourceSessionId: `session-${String(seq)}`,
    projectDir: PROJECT,
    ...overrides,
  });
  await store.append(entry);
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model, created_at) VALUES (?, ?, ?, ?)').run(
    entry.id,
    JSON.stringify(at(similarity, turn)),
    'stub',
    Date.now() + seq,
  );
  return entry;
}

/** Unrelated memos that set the "nothing fits" baseline around 0.52. */
async function background(count = 8): Promise<void> {
  for (let i = 0; i < count; i++) await memo(0.5 + (i % 5) * 0.01);
}

async function recall(overrides: Partial<Parameters<typeof recallMemos>[1]> = {}) {
  return recallMemos(store, { query: 'fix the flaky login test', projectDir: PROJECT, ...overrides });
}

describe('recallMemos', () => {
  beforeEach(() => {
    store.setEmbeddingEngine(engine());
  });

  it('brings back the one memo that clearly stands out', async () => {
    await background();
    const fits = await memo(0.8);
    const result = await recall();
    expect(result.map((entry) => entry.memo.id)).toEqual([fits.id]);
    expect(result[0]!.similarity).toBeCloseTo(0.8, 5);
    expect(result[0]!.sameProject).toBe(true);
  });

  it('stays silent below the similarity floor, however far above the rest', async () => {
    await background();
    await memo(0.66);
    expect(await recall()).toEqual([]);
  });

  it('stays silent when nothing stands out from the crowd', async () => {
    for (let i = 0; i < 9; i++) await memo(0.7 + (i % 3) * 0.01);
    expect(await recall()).toEqual([]);
  });

  it('drops near-copies but keeps different lessons of one long session', async () => {
    await background();
    const best = await memo(0.86, { sourceSessionId: 'long-session' });
    await memo(0.85, { sourceSessionId: 'long-session' }); // the same lesson again
    await memo(0.84, { sourceSessionId: 'other-session', userNeed: 'need 1' }, 0.05); // a copy from elsewhere
    const different = await memo(0.8, { sourceSessionId: 'long-session' }, Math.PI); // another task, same session
    expect((await recall()).map((entry) => entry.memo.id)).toEqual([best.id, different.id]);
  });

  it('leaves out what the conversation already has', async () => {
    await background();
    await memo(0.9, { sourceSessionId: 'asking' });
    const shown = await memo(0.88);
    await memo(0.87, { tags: ['compaction-fallback'] });
    await memo(0.86, { outcome: '进行中' });
    const ruled = await memo(0.84, { outcome: 'in progress', distilled: 'Run the suite twice before calling it flaky' });
    const result = await recall({ sessionId: 'asking', excludeIds: new Set([shown.id]) });
    expect(result.map((entry) => entry.memo.id)).toEqual([ruled.id]);
  });

  it('holds memos of another project to a higher bar; legacy memos count as this project', async () => {
    await background();
    await memo(0.7, { projectDir: '/work/other' });
    const legacy = await memo(0.69, { projectDir: '' }, Math.PI / 2);
    const elsewhere = await memo(0.75, { projectDir: '/work/other' }, Math.PI);
    const result = await recall();
    expect(result.map((entry) => [entry.memo.id, entry.sameProject])).toEqual([
      [elsewhere.id, false],
      [legacy.id, true],
    ]);
  });

  it('respects the limit', async () => {
    await background();
    for (let i = 0; i < 5; i++) await memo(0.8 + i * 0.01, {}, (i * 2 * Math.PI) / 5);
    expect(await recall({ limit: 2 })).toHaveLength(2);
    expect(await recall()).toHaveLength(3);
  });

  it('judges a small store against the typical unrelated similarity', async () => {
    const only = await memo(0.7);
    expect((await recall()).map((entry) => entry.memo.id)).toEqual([only.id]);
  });

  it('needs a loaded model and a real request', async () => {
    await background();
    await memo(0.9);
    const unloaded = engine(false);
    store.setEmbeddingEngine(unloaded);
    expect(await recall()).toEqual([]);
    expect(unloaded.embedBatch).not.toHaveBeenCalled();
    store.setEmbeddingEngine(engine());
    expect(await recall({ query: ' ok ' })).toEqual([]);
  });
});

describe('MemoryMemoStore recall bookkeeping', () => {
  it('counts recalls without touching the content, and update() keeps the count', async () => {
    store.setEmbeddingEngine(engine());
    const entry = await memo(0.8);
    await store.markRecalled([entry.id, entry.id], 1_000);
    await store.markRecalled([entry.id], 2_000);
    let stored = await store.get(entry.id);
    expect(stored?.recallCount).toBe(2);
    expect(stored?.lastRecalledAt).toBe(2_000);
    await store.update(entry.id, { note: 'edited' });
    stored = await store.get(entry.id);
    expect(stored?.note).toBe('edited');
    expect(stored?.recallCount).toBe(2);
    expect((await store.list()).memos[0]?.recallCount).toBe(2);
  });

  it('adds the counters to a store created before they existed', async () => {
    store.close();
    const legacyDir = await mkdtemp(join(tmpdir(), 'scream-recall-legacy-'));
    try {
      const first = new MemoryMemoStore(legacyDir);
      await first.init();
      const db = (first as unknown as { db: DatabaseSync }).db;
      db.exec('ALTER TABLE memos DROP COLUMN recall_count');
      db.exec('ALTER TABLE memos DROP COLUMN last_recalled_at');
      await first.append(createMemoryMemo({ id: 'memo-old-1', userNeed: 'n', approach: 'a', outcome: 'o', whatFailed: 'none', whatWorked: 'w', extractionSource: 'manual', sourceSessionId: 's' }));
      first.close();
      const reopened = new MemoryMemoStore(legacyDir);
      await reopened.init();
      await reopened.markRecalled(['memo-old-1'], 5);
      expect((await reopened.get('memo-old-1'))?.recallCount).toBe(1);
      reopened.close();
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
    store = new MemoryMemoStore(dir);
    await store.init();
  });

  it('reports how memories were used, as numbers', async () => {
    store.setEmbeddingEngine(engine());
    const old = await memo(0.5, { recordedAt: 100 });
    await memo(0.5, { recordedAt: 200 });
    const fresh = await memo(0.5, { recordedAt: 10_000 });
    await store.markRecalled([fresh.id], 9_000);
    await store.markRecalled([fresh.id], 9_500);
    await store.markRecalled([old.id], 50);
    expect(await store.useStats(5_000, 1_000)).toEqual({
      total: 3,
      added: 1,
      recalled: 1,
      neverRecalledOld: 1,
      topRecalled: [{ id: fresh.id, count: 2 }],
    });
  });

  it('reuses parsed vectors, but sees a re-embedded or deleted memo at once', async () => {
    store.setEmbeddingEngine(engine());
    const entry = await memo(0.8);
    const query = Float32Array.from([1, 0, 0]);
    expect((await store.scoreByVector(query))[0]?.score).toBeCloseTo(0.8, 5);
    const db = (store as unknown as { db: DatabaseSync }).db;
    // Re-embedding writes a new vector with a new time.
    db.prepare('UPDATE memory_embeddings SET embedding_json = ?, created_at = ? WHERE memory_id = ?').run(
      JSON.stringify(at(0.6)),
      Date.now() + 10_000,
      entry.id,
    );
    expect((await store.scoreByVector(query))[0]?.score).toBeCloseTo(0.6, 5);
    await store.delete(entry.id);
    expect(await store.scoreByVector(query)).toEqual([]);
  });

  it('scores vectors of the query length only', async () => {
    store.setEmbeddingEngine(engine());
    const entry = await memo(0.8);
    const otherModel = await memo(0.5);
    const db = (store as unknown as { db: DatabaseSync }).db;
    // A vector from a model with another dimension cannot be compared.
    db.prepare('UPDATE memory_embeddings SET embedding_json = ? WHERE memory_id = ?').run(JSON.stringify([1, 0]), otherModel.id);
    const scored = await store.scoreByVector(Float32Array.from([1, 0, 0]));
    expect(scored.map((row) => row.id)).toEqual([entry.id]);
  });
});

describe('isSameProjectDir', () => {
  it('matches the same folder and one inside the other; home or no folder belongs to every project', async () => {
    const { isSameProjectDir } = await import('../src/recall.js');
    const home = '/Users/me';
    expect(isSameProjectDir('/Users/me/repo', '/Users/me/repo', home)).toBe(true);
    expect(isSameProjectDir('/Users/me/repo/apps/cli', '/Users/me/repo', home)).toBe(true);
    expect(isSameProjectDir('/Users/me/repo', '/Users/me/repo/apps/cli/', home)).toBe(true);
    expect(isSameProjectDir('/Users/me', '/Users/me/repo', home)).toBe(true);
    // A memo made in the home folder belongs to a project outside it too.
    expect(isSameProjectDir('/Users/me', '/opt/work/repo', home)).toBe(true);
    expect(isSameProjectDir('/Users/other', '/opt/work/repo', home)).toBe(false);
    expect(isSameProjectDir('', '/Users/me/repo', home)).toBe(true);
    expect(isSameProjectDir('/Users/me/other', '/Users/me/repo', home)).toBe(false);
    expect(isSameProjectDir('/Users/me/repo-old', '/Users/me/repo', home)).toBe(false);
  });
});
