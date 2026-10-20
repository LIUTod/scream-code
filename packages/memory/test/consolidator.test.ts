import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo, toSummary, type MemoryDigest, type MemoryMemo } from '../src/models.js';
import { buildDreamPlan, applyDreamPlan } from '../src/consolidator.js';
import type { EmbeddingEngine } from '../src/embeddings.js';

const DAY = 24 * 60 * 60 * 1000;

function makeMemo(id: string, overrides: Partial<Omit<MemoryMemo, 'id'>> = {}): MemoryMemo {
  return createMemoryMemo({
    sourceSessionId: 's1',
    sourceSessionTitle: 'Session',
    userNeed: 'Need',
    approach: 'Approach',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'exit',
    recordedAt: Date.now(),
    projectDir: '',
    ...overrides,
    id,
  });
}

async function allMemos(store: MemoryMemoStore): Promise<MemoryMemo[]> {
  const memos: MemoryMemo[] = [];
  for await (const memo of store.read()) memos.push(memo);
  return memos;
}

/** Engine whose similarity math is real; only the vectors are supplied by the test. */
function cosineEngine(): EmbeddingEngine {
  return {
    available: true,
    modelName: 'fake-embed',
    embedBatch: async () => null,
    ensureReady: async () => true,
    cosineSimilarity(a, b) {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
      }
      return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
    },
  };
}

/** Minimal plan-facing store: candidates, embeddings, engine and digests. */
function planStore(
  memos: MemoryMemo[],
  options: {
    vectors?: Array<{ memoId: string; vector: number[] }>;
    engine?: EmbeddingEngine;
    digests?: MemoryDigest[];
  } = {},
): MemoryMemoStore {
  const active = memos
    .filter((memo) => (memo.status ?? 'active') === 'active')
    .toSorted((a, b) => b.recordedAt - a.recordedAt);
  return {
    list: async (opts?: { limit?: number }) => ({
      memos: active.slice(0, opts?.limit ?? 50).map(toSummary),
      total: active.length,
    }),
    read: async function* () {
      for (const memo of memos) yield memo;
    },
    listMemoEmbeddings: async () => options.vectors ?? [],
    getEmbeddingEngine: () => options.engine,
    listDigests: async () => options.digests ?? [],
  } as unknown as MemoryMemoStore;
}

function digestRecord(overrides: Partial<MemoryDigest> & Pick<MemoryDigest, 'id' | 'topic'>): MemoryDigest {
  const now = Date.now();
  return {
    kind: 'fact',
    statement: 'statement',
    confidence: 'medium',
    evidence: [],
    evidenceFrom: 0,
    evidenceTo: 0,
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,
    hitCount: 0,
    status: 'active',
    ...overrides,
  };
}

describe('buildDreamPlan', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-plan-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('reports an empty store', async () => {
    const plan = await buildDreamPlan(store);
    expect(plan.summary).toEqual({ totalMemos: 0, clusters: 0, estimatedLlmCalls: 0 });
    expect(plan.clusters).toEqual([]);
    expect(plan.existingDigests).toEqual([]);
  });

  it('merges paraphrases when the vectors say they share a topic', async () => {
    const now = Date.now();
    const a = makeMemo('a', {
      userNeed: '发版前需要先构建产物',
      approach: '执行构建脚本',
      recordedAt: now - 30 * DAY,
    });
    const b = makeMemo('b', {
      userNeed: '发布之前要打包',
      approach: '运行打包命令',
      recordedAt: now - 20 * DAY,
    });
    const c = makeMemo('c', {
      userNeed: '调整暗色主题配色',
      approach: '修改 CSS 变量',
      recordedAt: now - 10 * DAY,
    });
    const stub = planStore([a, b, c], {
      engine: cosineEngine(),
      vectors: [
        { memoId: 'a', vector: [1, 0, 0] },
        { memoId: 'b', vector: [0.99, 0.05, 0] },
        { memoId: 'c', vector: [0, 1, 0] },
      ],
    });

    const plan = await buildDreamPlan(stub);
    expect(plan.summary.totalMemos).toBe(3);
    expect(plan.clusters).toHaveLength(1);
    const cluster = plan.clusters[0]!;
    expect(cluster.memoIds).toEqual(['b', 'a']);
    expect(cluster.sample.map((sample) => sample.id)).toEqual(['b', 'a']);
    expect(cluster.topicHint.length).toBeGreaterThan(0);
    expect(cluster.kindGuess).toBeDefined();
    expect(plan.summary.estimatedLlmCalls).toBe(1);
  });

  it('keeps near-but-different memos apart below the vector threshold', async () => {
    const a = makeMemo('a', { userNeed: 'Configure redis cache', recordedAt: Date.now() - 2000 });
    const b = makeMemo('b', { userNeed: 'Configure redis persistence', recordedAt: Date.now() - 1000 });
    const stub = planStore([a, b], {
      engine: cosineEngine(),
      vectors: [
        { memoId: 'a', vector: [1, 0, 0] },
        // cosine ≈ 0.58 — related domain, different fact
        { memoId: 'b', vector: [0.5, 0.7, 0] },
      ],
    });

    const plan = await buildDreamPlan(stub);
    expect(plan.clusters).toEqual([]);
  });

  it('falls back to keyword similarity without an engine', async () => {
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        recordedAt: Date.now() - 9 * DAY,
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        recordedAt: Date.now() - 7 * DAY,
      }),
    );
    await store.append(
      makeMemo('m3', { userNeed: 'Add dark mode', approach: 'CSS variables' }),
    );

    const plan = await buildDreamPlan(store);
    expect(plan.summary.totalMemos).toBe(3);
    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0]!.memoIds).toEqual(['m2', 'm1']);
  });

  it('reports clusters, existing digests and maintenance counts without deleting', async () => {
    const now = Date.now();
    await store.append(makeMemo('pair-a', { userNeed: 'Fix login token refresh', approach: 'Add axios interceptor' }));
    await store.append(makeMemo('pair-b', { userNeed: 'Fix login token refresh bug', approach: 'axios interceptor refresh' }));
    await store.append(
      makeMemo('expired', { userNeed: 'Old folded task', extractionSource: 'exit' }),
    );
    await store.append(makeMemo('recent-digested', { userNeed: 'New folded task' }));
    await store.append(
      makeMemo('episodic', {
        userNeed: 'Ancient one-off chore',
        extractionSource: 'exit',
        recordedAt: now - 100 * DAY,
      }),
    );
    await store.append(
      makeMemo('manual', {
        userNeed: 'Hand written note about deployment',
        extractionSource: 'manual',
        recordedAt: now - 100 * DAY,
      }),
    );
    await store.markMemosDigested(['expired'], 'digest-old', now - 20 * DAY);
    await store.markMemosDigested(['recent-digested'], 'digest-old', now - 3 * DAY);
    await store.upsertDigest(digestRecord({ id: 'digest-live', topic: 'live topic' }));
    await store.upsertDigest(
      digestRecord({
        id: 'digest-drowsy',
        topic: 'drowsy topic',
        lastConfirmedAt: now - 200 * DAY,
      }),
    );

    const plan = await buildDreamPlan(store);

    // Digested memos are hidden from the candidate list but still counted:
    // "empty" must mean the table is empty, not that everything sits in its
    // grace window.
    expect(plan.summary.totalMemos).toBe(6);
    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0]!.memoIds.toSorted()).toEqual(['pair-a', 'pair-b']);
    expect(plan.existingDigests.map((digest) => digest.id).toSorted()).toEqual([
      'digest-drowsy',
      'digest-live',
    ]);
    expect(plan.maintenance).toEqual({
      expiredDigested: 1,
      expiredEpisodic: 1,
      overCap: 0,
      dormant: 1,
    });

    const stored = await allMemos(store);
    expect(stored).toHaveLength(6);
    expect(stored.filter((memo) => memo.status === 'digested')).toHaveLength(2);
  });

  it('honours the candidate cap', async () => {
    const memos = Array.from({ length: 205 }, (_, i) =>
      makeMemo(`m${i}`, { userNeed: `unique task ${i}`, recordedAt: Date.now() - i * 1000 }),
    );
    // All vectors are orthogonal to each other, so nothing clusters; the point
    // here is how many candidates the plan asks for.
    const stub = planStore(memos, {
      engine: { ...cosineEngine(), cosineSimilarity: () => 0 },
      vectors: memos.map((memo) => ({ memoId: memo.id, vector: [1, 0, 0] })),
    });
    const list = stub.list.bind(stub);
    let requestedLimit = 0;
    stub.list = async (opts) => {
      requestedLimit = Math.max(requestedLimit, opts?.limit ?? 0);
      return list(opts);
    };

    const plan = await buildDreamPlan(stub);
    expect(requestedLimit).toBe(200);
    expect(plan.summary.totalMemos).toBe(205);
    expect(plan.clusters).toEqual([]);
  });
});

describe('applyDreamPlan', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-apply-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('creates a digest and marks memos digested instead of deleting them', async () => {
    const now = Date.now();
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        projectDir: '/repo/app',
        recordedAt: now - 10 * DAY,
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Login token refresh fix',
        approach: 'interceptor',
        projectDir: '/repo/app',
        recordedAt: now - 2 * DAY,
      }),
    );

    const result = await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['m1', 'm2'],
          digest: {
            topic: 'Token 刷新',
            kind: 'procedure',
            statement: '在 axios 拦截器里统一刷新 token。',
            confidence: 'high',
            evidenceIds: ['m1', 'm2'],
          },
        },
      ],
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.archived).toBe(2);
    // Folded memos are still on disk during the grace window, so the total
    // counts them; only `status` hides them from lists.
    expect(result.totalMemos).toBe(2);
    expect(result.totalDigests).toBe(1);

    const digests = await store.listDigests();
    expect(digests).toHaveLength(1);
    const digest = digests[0]!;
    expect(digest.topic).toBe('Token 刷新');
    expect(digest.kind).toBe('procedure');
    expect(digest.confidence).toBe('high');
    expect(digest.appliesTo).toBe('/repo/app');
    expect(digest.evidence.map((entry) => entry.id)).toEqual(['m1', 'm2']);
    expect(digest.evidenceFrom).toBe(now - 10 * DAY);
    expect(digest.evidenceTo).toBe(now - 2 * DAY);
    expect(digest.evidence[0]!.title).toBe('Fix login token refresh');

    // Not deleted: the grace window is what reclaims them.
    const stored = await allMemos(store);
    expect(stored).toHaveLength(2);
    for (const memo of stored) {
      expect(memo.status).toBe('digested');
      expect(memo.digestId).toBe(digest.id);
      expect(memo.digestedAt).toBeDefined();
    }
  });

  it('leaves appliesTo undefined when the cluster spans projects', async () => {
    await store.append(makeMemo('m1', { projectDir: '/repo/a' }));
    await store.append(makeMemo('m2', { projectDir: '/repo/b' }));

    await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['m1', 'm2'],
          digest: {
            topic: 'shared rule',
            kind: 'fact',
            statement: 'Applies everywhere.',
            confidence: 'medium',
            evidenceIds: ['m1', 'm2'],
          },
        },
      ],
    });

    expect((await store.listDigests())[0]!.appliesTo).toBeUndefined();
  });

  it('rejects evidence ids outside the cluster without writing anything', async () => {
    await store.append(makeMemo('m1', { extractionSource: 'exit' }));
    await store.append(makeMemo('m2', { extractionSource: 'exit' }));

    await expect(
      applyDreamPlan(store, {
        clusters: [
          {
            memoIds: ['m1'],
            digest: {
              topic: 'bad',
              kind: 'fact',
              statement: 'cites a memo from another cluster',
              confidence: 'low',
              evidenceIds: ['m2'],
            },
          },
          {
            memoIds: ['m2'],
            digest: {
              topic: 'good',
              kind: 'fact',
              statement: 'would have been fine',
              confidence: 'low',
              evidenceIds: ['m2'],
            },
          },
        ],
      }),
    ).rejects.toThrow(/outside/);

    expect(await store.listDigests()).toHaveLength(0);
    const stored = await allMemos(store);
    expect(stored.every((memo) => (memo.status ?? 'active') === 'active')).toBe(true);
  });

  it('updates an existing topic and records the superseded statement', async () => {
    const now = Date.now();
    await store.append(makeMemo('a1', { userNeed: '发布前构建', recordedAt: now - 5000 }));
    const first = await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['a1'],
          digest: {
            topic: 'Release process',
            kind: 'procedure',
            statement: '先构建再发布。',
            confidence: 'high',
            evidenceIds: ['a1'],
          },
        },
      ],
    });
    expect(first.created).toBe(1);
    const before = (await store.listDigests())[0]!;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.append(makeMemo('a2', { userNeed: '发布前跑测试', recordedAt: now - 1000 }));
    const second = await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['a2'],
          digest: {
            topic: '  release   PROCESS ',
            kind: 'procedure',
            statement: '先构建、跑测试，再发布。',
            confidence: 'high',
            evidenceIds: ['a2'],
          },
        },
      ],
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.archived).toBe(1);

    const after = (await store.listDigests())[0]!;
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.topic).toBe('release PROCESS');
    expect(after.statement).toBe('先构建、跑测试，再发布。');
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(after.lastConfirmedAt).toBeGreaterThan(before.lastConfirmedAt);
    expect(after.superseded).toEqual([
      { statement: '先构建再发布。', at: before.updatedAt },
    ]);
    expect(after.evidence.map((entry) => entry.id).toSorted()).toEqual(['a1', 'a2']);
    expect(after.evidenceFrom).toBe(now - 5000);
    expect(after.evidenceTo).toBe(now - 1000);

    // Same statement again: confirmation only, no new history entry.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.append(makeMemo('a3', { userNeed: '再次发布', recordedAt: now }));
    const third = await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['a3'],
          digest: {
            topic: 'release process',
            kind: 'procedure',
            statement: '先构建、跑测试，再发布。',
            confidence: 'high',
            evidenceIds: ['a3'],
          },
        },
      ],
    });
    expect(third.updated).toBe(1);
    const confirmed = (await store.listDigests())[0]!;
    expect(confirmed.updatedAt).toBe(after.updatedAt);
    expect(confirmed.lastConfirmedAt).toBeGreaterThan(after.lastConfirmedAt);
    expect(confirmed.superseded).toHaveLength(1);
  });

  it('caps superseded history at ten entries', async () => {
    const now = Date.now();
    await store.upsertDigest(
      digestRecord({
        id: 'digest-seed',
        topic: 'Cap topic',
        statement: 'old statement',
        updatedAt: now - 1000,
        superseded: Array.from({ length: 10 }, (_, index) => ({
          statement: `s${index}`,
          at: index,
        })),
      }),
    );
    await store.append(makeMemo('cap-1'));

    const result = await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['cap-1'],
          digest: {
            topic: 'cap topic',
            kind: 'fact',
            statement: 'new statement',
            confidence: 'low',
            evidenceIds: ['cap-1'],
          },
        },
      ],
    });

    expect(result.updated).toBe(1);
    const seeded = (await store.listDigests()).find((digest) => digest.id === 'digest-seed')!;
    expect(seeded.superseded).toHaveLength(10);
    expect(seeded.superseded!.at(-1)).toEqual({ statement: 'old statement', at: now - 1000 });
  });

  it('skips memos that were already folded before apply', async () => {
    await store.append(makeMemo('m1'));
    await store.append(makeMemo('m2'));
    await store.markMemosDigested(['m2'], 'digest-other', Date.now());

    const result = await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['m1', 'm2'],
          digest: {
            topic: 'only fresh memos',
            kind: 'fact',
            statement: 'Fold what is still active.',
            confidence: 'medium',
            evidenceIds: ['m1', 'm2'],
          },
        },
      ],
    });

    expect(result.created).toBe(1);
    expect(result.archived).toBe(1);
    const digest = (await store.listDigests()).find((d) => d.topic === 'only fresh memos')!;
    expect(digest.evidence.map((entry) => entry.id)).toEqual(['m1']);
  });

  it('deletes digested memos only after the grace window', async () => {
    const now = Date.now();
    await store.append(makeMemo('expired', { recordedAt: now - 40 * DAY }));
    await store.append(makeMemo('fresh', { recordedAt: now - 2 * DAY }));
    await store.markMemosDigested(['expired'], 'digest-x', now - 20 * DAY);
    await store.markMemosDigested(['fresh'], 'digest-x', now - 1 * DAY);

    const result = await applyDreamPlan(store, { clusters: [] });

    expect(result.deletedExpired).toBe(1);
    const remaining = (await allMemos(store)).map((memo) => memo.id);
    expect(remaining).toEqual(['fresh']);
  });

  it('evicts dormant digests first when over the cap', async () => {
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      await store.upsertDigest(digestRecord({ id: `keep-${i}`, topic: `keep ${i}` }));
    }
    await store.upsertDigest(
      digestRecord({
        id: 'dormant-one',
        topic: 'dormant one',
        status: 'dormant',
        lastConfirmedAt: now,
      }),
    );

    const result = await applyDreamPlan(store, { clusters: [] });

    expect(result.evicted).toBe(1);
    expect(result.totalDigests).toBe(200);
    const remaining = await store.listDigests({ limit: 1000 });
    expect(remaining.some((digest) => digest.id === 'dormant-one')).toBe(false);
  });

  it('evicts never-hit digests before digests that were used', async () => {
    const now = Date.now();
    for (let i = 0; i < 199; i++) {
      await store.upsertDigest(
        digestRecord({
          id: `used-${i}`,
          topic: `used ${i}`,
          hitCount: 1,
          lastHitAt: now - DAY,
        }),
      );
    }
    await store.upsertDigest(digestRecord({ id: 'never-hit', topic: 'never hit' }));
    await store.upsertDigest(
      digestRecord({
        id: 'used-once',
        topic: 'used once',
        hitCount: 3,
        lastHitAt: now - 2 * DAY,
      }),
    );

    const result = await applyDreamPlan(store, { clusters: [] });

    expect(result.evicted).toBe(1);
    const remaining = await store.listDigests({ limit: 1000 });
    const ids = remaining.map((digest) => digest.id);
    expect(ids).not.toContain('never-hit');
    expect(ids).toContain('used-once');
  });

  it('marks stale unconfirmed digests dormant without deleting them', async () => {
    const now = Date.now();
    await store.upsertDigest(
      digestRecord({ id: 'stale-card', topic: 'stale topic', lastConfirmedAt: now - 200 * DAY }),
    );

    const result = await applyDreamPlan(store, { clusters: [] });

    expect(result.dormant).toBe(1);
    const digest = await store.getDigest('stale-card');
    expect(digest?.status).toBe('dormant');
    expect(result.totalDigests).toBe(1);
  });

  it('is idempotent when the same clusters are applied twice', async () => {
    await store.append(makeMemo('m1'));
    await store.append(makeMemo('m2'));
    const input = {
      clusters: [
        {
          memoIds: ['m1', 'm2'],
          digest: {
            topic: 'idempotent topic',
            kind: 'fact' as const,
            statement: 'Applying twice changes nothing.',
            confidence: 'high' as const,
            evidenceIds: ['m1', 'm2'],
          },
        },
      ],
    };

    const first = await applyDreamPlan(store, input);
    const second = await applyDreamPlan(store, input);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.archived).toBe(0);
    const digests = await store.listDigests();
    expect(digests).toHaveLength(1);
    expect(digests[0]!.superseded).toBeUndefined();
  });

  it('persists a digest embedding when an engine is available', async () => {
    await store.append(makeMemo('m1'));
    store.setEmbeddingEngine({
      available: true,
      modelName: 'fake-embed',
      embedBatch: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
      cosineSimilarity: () => 1,
      ensureReady: async () => true,
    });

    await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['m1'],
          digest: {
            topic: 'embedded',
            kind: 'fact',
            statement: 'Stored with a vector.',
            confidence: 'medium',
            evidenceIds: ['m1'],
          },
        },
      ],
    });

    const embeddings = await store.listDigestEmbeddings();
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]!.vector).toEqual([1, 0, 0]);
  });
});

describe('dream apply: undo and project scoping', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-undo-'));
    store = new MemoryMemoStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  async function addMemo(id: string, projectDir: string): Promise<void> {
    await store.append(
      makeMemo(id, {
        userNeed: `task ${id}`,
        approach: `approach ${id}`,
        projectDir,
      }),
    );
  }

  it('restores folded memos and drops the card when undoDigestId is passed', async () => {
    await addMemo('u1', '/repo/app');
    await addMemo('u2', '/repo/app');

    await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['u1', 'u2'],
          digest: {
            topic: '撤销测试',
            kind: 'procedure',
            statement: '先做 A 再做 B。',
            confidence: 'high',
            evidenceIds: ['u1', 'u2'],
          },
        },
      ],
    });
    const [digest] = await store.listDigests();
    expect(digest).toBeDefined();

    const undo = await applyDreamPlan(store, {
      clusters: [],
      undoDigestId: digest!.id,
    });

    expect(undo.restored).toBe(2);
    expect(await store.listDigests()).toHaveLength(0);
    const restored = await store.list({ includeDigested: true });
    expect(restored.total).toBe(2);
    expect(restored.memos.every((memo) => memo.status !== 'digested')).toBe(true);
  });

  it('keeps the same topic in two projects as two separate cards', async () => {
    await addMemo('p1', '/repo/a');
    await addMemo('p2', '/repo/a');
    await addMemo('q1', '/repo/b');
    await addMemo('q2', '/repo/b');

    const result = await applyDreamPlan(store, {
      clusters: [
        {
          memoIds: ['p1', 'p2'],
          digest: {
            topic: '发布流程',
            kind: 'procedure',
            statement: 'A 项目先跑测试。',
            confidence: 'high',
            evidenceIds: ['p1', 'p2'],
          },
        },
        {
          memoIds: ['q1', 'q2'],
          digest: {
            topic: '发布流程',
            kind: 'procedure',
            statement: 'B 项目先跑 lint。',
            confidence: 'high',
            evidenceIds: ['q1', 'q2'],
          },
        },
      ],
    });

    expect(result.created).toBe(2);
    const digests = await store.listDigests();
    expect(digests).toHaveLength(2);
    expect(digests.map((digest) => digest.appliesTo).toSorted()).toEqual(['/repo/a', '/repo/b']);
  });
});
