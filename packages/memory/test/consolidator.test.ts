import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo, type MemoryMemo } from '../src/models.js';
import { buildConsolidationPlan, applyConsolidation } from '../src/consolidator.js';

function makeMemo(
  id: string,
  overrides: Partial<Omit<MemoryMemo, 'id'>> = {},
): MemoryMemo {
  return {
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
  };
}

describe('buildConsolidationPlan', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-consolidator-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('detects duplicate groups and tracks counts', async () => {
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '完成',
        recordedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '完成',
        recordedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.summary.totalMemos).toBe(2);
    expect(plan.duplicateGroups.length).toBeGreaterThan(0);
    expect(plan.summary.relatedGroupsFound).toBe(0);
    expect(plan.summary.memosAfterConsolidation).toBeLessThan(2);
  });

  it('groups memos sharing a compound identifier as related but not duplicates', async () => {
    await store.append(
      makeMemo('r1', {
        userNeed: 'Install and use sample-tool',
        approach: 'curl install then run',
        outcome: '完成',
      }),
    );
    await store.append(
      makeMemo('r2', {
        userNeed: 'Delete sample-tool without asking',
        approach: 'rm -rf the folder silently',
        outcome: '完成',
      }),
    );
    await store.append(
      makeMemo('r3', {
        userNeed: 'Delete sample-tool cleanly',
        approach: 'remove config and binaries',
        outcome: '完成',
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.summary.totalMemos).toBe(3);
    expect(plan.duplicateGroups.length).toBe(0);
    expect(plan.relatedGroups.length).toBeGreaterThan(0);
    const relatedGroup = plan.relatedGroups.find((g) => g.topic === 'sample-tool');
    expect(relatedGroup).toBeDefined();
    expect(relatedGroup!.memos.length).toBe(3);
  });

  it('does not place the same memo in both duplicate and related groups', async () => {
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '完成',
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '完成',
      }),
    );

    const plan = await buildConsolidationPlan(store);
    const duplicateIds = new Set(
      plan.duplicateGroups.flatMap((g) => g.memos.map((m) => m.id)),
    );
    const relatedIds = new Set(
      plan.relatedGroups.flatMap((g) => g.memos.map((m) => m.id)),
    );

    for (const id of duplicateIds) {
      expect(relatedIds.has(id)).toBe(false);
    }
  });

  it('reports zero groups for an empty store', async () => {
    const plan = await buildConsolidationPlan(store);
    expect(plan.summary.totalMemos).toBe(0);
    expect(plan.duplicateGroups.length).toBe(0);
    expect(plan.relatedGroups.length).toBe(0);
    expect(plan.resolved.length).toBe(0);
    expect(plan.stale.length).toBe(0);
  });
});

describe('applyConsolidation', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-consolidator-apply-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('does not delete memos in related groups', async () => {
    await store.append(
      makeMemo('r1', {
        userNeed: 'Install and use sample-tool',
        approach: 'curl install then run',
        outcome: '完成',
      }),
    );
    await store.append(
      makeMemo('r2', {
        userNeed: 'Delete sample-tool without asking',
        approach: 'rm -rf the folder silently',
        outcome: '完成',
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.relatedGroups.length).toBeGreaterThan(0);

    const result = await applyConsolidation(store, plan);
    expect(result.deleted).toBe(0);
    expect(result.created).toBe(0);

    const remaining: MemoryMemo[] = [];
    for await (const memo of store.read()) {
      remaining.push(memo);
    }
    expect(remaining.length).toBe(2);
  });

  it('persists the plan distilled conclusion on the merged memo', async () => {
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '完成',
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '完成',
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.duplicateGroups.length).toBeGreaterThan(0);
    const distilledText = '刷新令牌统一走 axios 拦截器，不要在页面里手动重试';
    plan.duplicateGroups[0]!.merged.distilled = distilledText;

    await applyConsolidation(store, plan);

    const remaining: MemoryMemo[] = [];
    for await (const memo of store.read()) {
      remaining.push(memo);
    }
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.distilled).toBe(distilledText);
  });

  it('preserves source notes on the merged memo', async () => {
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '完成',
        note: '先看网关日志',
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '完成',
        note: '再跑令牌测试',
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.duplicateGroups.length).toBeGreaterThan(0);
    await applyConsolidation(store, plan);

    const remaining: MemoryMemo[] = [];
    for await (const memo of store.read()) {
      remaining.push(memo);
    }
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.note).toContain('先看网关日志');
    expect(remaining[0]!.note).toContain('再跑令牌测试');
  });

  it('stores undefined when the plan leaves distilled empty', async () => {
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '完成',
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '完成',
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.duplicateGroups.length).toBeGreaterThan(0);
    expect(plan.duplicateGroups[0]!.merged.distilled).toBe('');

    await applyConsolidation(store, plan);

    const remaining: MemoryMemo[] = [];
    for await (const memo of store.read()) {
      remaining.push(memo);
    }
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.distilled).toBeUndefined();
  });
});

describe('distillation provenance', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-provenance-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  async function readAll(): Promise<MemoryMemo[]> {
    const memos: MemoryMemo[] = [];
    for await (const memo of store.read()) memos.push(memo);
    return memos;
  }

  it('records origin, distilledAt and source lineage on the merged memo', async () => {
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '部分完成',
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '部分完成',
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.duplicateGroups.length).toBe(1);
    const sourceIds = plan.duplicateGroups[0]!.memos.map((memo) => memo.id).toSorted();
    plan.duplicateGroups[0]!.merged.distilled = '令牌刷新统一走拦截器';
    const before = Date.now();
    await applyConsolidation(store, plan);

    const remaining = await readAll();
    expect(remaining.length).toBe(1);
    const merged = remaining[0]!;
    expect(merged.distilled).toBe('令牌刷新统一走拦截器');
    expect(merged.origin).toBe('dream');
    expect(merged.distilledAt).toBeGreaterThanOrEqual(before);
    expect(merged.distilledFrom?.map((source) => source.id).toSorted()).toEqual(sourceIds);
    expect(merged.distilledFrom?.every((source) => source.title.length > 0 && source.at > 0)).toBe(
      true,
    );
  });

  it('carries a previous generation lineage into the next distillation', async () => {
    const base = Date.now() - 60_000;
    await store.append(
      makeMemo('m1', {
        userNeed: '修复登录令牌刷新',
        approach: '加 axios 拦截器',
        outcome: '部分完成',
        recordedAt: base,
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: '修复登录令牌刷新问题',
        approach: '用 axios 拦截器刷新',
        outcome: '部分完成',
        recordedAt: base + 1000,
      }),
    );

    const firstPlan = await buildConsolidationPlan(store);
    expect(firstPlan.duplicateGroups.length).toBe(1);
    firstPlan.duplicateGroups[0]!.merged.distilled = '令牌刷新统一走拦截器';
    await applyConsolidation(store, firstPlan);

    const [firstGen] = await readAll();
    expect(firstGen!.origin).toBe('dream');
    expect(firstGen!.distilledFrom?.map((source) => source.id).toSorted()).toEqual(['m1', 'm2']);

    await store.append(
      makeMemo('m3', {
        userNeed: firstGen!.userNeed,
        approach: firstGen!.approach,
        outcome: '部分完成',
        recordedAt: base + 2000,
      }),
    );

    const secondPlan = await buildConsolidationPlan(store);
    const group = secondPlan.duplicateGroups.find((item) =>
      item.memos.some((memo) => memo.id === firstGen!.id),
    );
    expect(group).toBeDefined();
    group!.merged.distilled = '令牌刷新统一走拦截器，页面不再手动重试';
    await applyConsolidation(store, secondPlan);

    const remaining = await readAll();
    const secondGen = remaining.find(
      (memo) => memo.distilled === '令牌刷新统一走拦截器，页面不再手动重试',
    );
    expect(secondGen).toBeDefined();
    expect(secondGen!.origin).toBe('dream');
    expect(secondGen!.distilledFrom?.map((source) => source.id).toSorted()).toEqual(
      ['m1', 'm2', 'm3', firstGen!.id].toSorted(),
    );
  });

  it('never prunes a distilled rule as resolved or stale', async () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await store.append(
      makeMemo('resolved-rule', {
        userNeed: '长期规则 A',
        outcome: '完成',
        recordedAt: old,
        origin: 'dream',
        distilled: '规则 A',
        distilledAt: old,
      }),
    );
    await store.append(
      makeMemo('stale-rule', {
        userNeed: '长期规则 B',
        outcome: '部分完成',
        recordedAt: old,
        origin: 'user',
        distilled: '规则 B',
        distilledAt: old,
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(plan.resolved.map((memo) => memo.id)).not.toContain('resolved-rule');
    expect(plan.stale.map((memo) => memo.id)).not.toContain('stale-rule');
  });

  it('skips a group that holds a rule when the plan has no new conclusion', async () => {
    await store.append(
      makeMemo('rule-1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '完成',
        origin: 'dream',
        distilled: '旧结论',
        distilledAt: Date.now(),
      }),
    );
    await store.append(
      makeMemo('raw-1', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '完成',
        recordedAt: Date.now() + 1000,
      }),
    );

    const plan = await buildConsolidationPlan(store);
    expect(
      plan.duplicateGroups.some((group) => group.memos.some((memo) => memo.id === 'rule-1')),
    ).toBe(true);

    const result = await applyConsolidation(store, plan);
    expect(result.skipped).toBeGreaterThan(0);
    expect(await store.get('rule-1')).toBeDefined();
    expect((await store.get('rule-1'))!.distilled).toBe('旧结论');
  });
});
