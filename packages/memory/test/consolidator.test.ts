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
});
