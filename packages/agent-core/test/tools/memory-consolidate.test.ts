/**
 * Tests for MemoryConsolidatePlanTool and MemoryConsolidateApplyTool.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryMemo, MemoryMemoStore, type MemoryMemo } from '@scream-code/memory';
import type { Agent } from '../../src/agent';
import type { ExecutableToolResult } from '../../src/loop';
import {
  MemoryConsolidateApplyTool,
  MemoryConsolidatePlanTool,
} from '../../src/tools/builtin/memory/memory-consolidate';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const DAY = 24 * 60 * 60 * 1000;

function getOutputText(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : '';
}

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

function makeAgent(
  memoStore: MemoryMemoStore | undefined,
  tracker?: { recordDream: () => Promise<void> },
): Agent {
  return {
    memoStore,
    dreamTracker: tracker ?? { recordDream: async () => {} },
    config: { cwd: '/workspace/project' },
  } as unknown as Agent;
}

describe('MemoryConsolidatePlanTool', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-tool-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('has name, description, and empty parameters', () => {
    const tool = new MemoryConsolidatePlanTool(makeAgent(store));

    expect(tool.name).toBe('MemoryConsolidatePlan');
    expect(tool.description).toContain('dream plan');
    expect(tool.description).toContain('never writes or deletes');
    expect(tool.parameters).toMatchObject({ type: 'object', properties: {} });
  });

  it('returns topic clusters instead of duplicate groups', async () => {
    const now = Date.now();
    await store.append(
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        recordedAt: now - 9 * DAY,
      }),
    );
    await store.append(
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        recordedAt: now - 7 * DAY,
      }),
    );
    await store.append(
      makeMemo('m3', { userNeed: 'Add dark mode', approach: 'CSS variables' }),
    );

    const tool = new MemoryConsolidatePlanTool(makeAgent(store));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result.isError).toBeFalsy();
    const plan = JSON.parse(getOutputText(result));
    expect(plan.summary).toEqual({ totalMemos: 3, clusters: 1, estimatedLlmCalls: 1 });
    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0].memoIds).toEqual(['m2', 'm1']);
    expect(plan.clusters[0].topicHint.length).toBeGreaterThan(0);
    expect(plan.clusters[0].sample).toHaveLength(2);
    expect(plan.clusters[0].kindGuess).toBeDefined();
    expect(plan.existingDigests).toEqual([]);
    expect(plan.maintenance).toEqual({
      expiredDigested: 0,
      expiredEpisodic: 0,
      overCap: 0,
      dormant: 0,
    });
  });

  it('reports an empty store', async () => {
    const tool = new MemoryConsolidatePlanTool(makeAgent(store));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(getOutputText(result)).toContain('empty');
  });

  it('returns an error when the store is unavailable', async () => {
    const tool = new MemoryConsolidatePlanTool(makeAgent(undefined));

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result.isError).toBe(true);
    expect(getOutputText(result)).toContain('not available');
  });
});

describe('MemoryConsolidateApplyTool', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-dream-apply-tool-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('folds memos into a digest and records the dream', async () => {
    await store.append(makeMemo('m1', { userNeed: 'Fix login token refresh' }));
    await store.append(makeMemo('m2', { userNeed: 'Login token refresh fix' }));
    let dreamRecorded = false;
    const agent = makeAgent(store, {
      recordDream: async () => {
        dreamRecorded = true;
      },
    });

    const tool = new MemoryConsolidateApplyTool(agent);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_2',
      args: {
        clusters: [
          {
            memoIds: ['m1', 'm2'],
            digest: {
              topic: 'token refresh',
              kind: 'procedure',
              statement: '刷新 token 统一交给 axios 拦截器。',
              confidence: 'high',
              evidenceIds: ['m1', 'm2'],
            },
          },
        ],
      },
      signal,
    });

    expect(result.isError).toBeFalsy();
    const output = getOutputText(result);
    expect(output).toContain('created 1');
    expect(output).toContain('archived 2');
    expect(output).toContain('totalDigests 1');
    expect(dreamRecorded).toBe(true);

    const digests = await store.listDigests();
    expect(digests).toHaveLength(1);
    expect(digests[0]!.topic).toBe('token refresh');
    // Memos are folded, not deleted: the grace window reclaims them later.
    expect((await store.list()).total).toBe(0);
    expect(await store.list({ includeDigested: true })).toMatchObject({ total: 2 });
  });

  it('rejects evidence ids outside the cluster', async () => {
    await store.append(makeMemo('m1'));
    await store.append(makeMemo('m2'));
    const tool = new MemoryConsolidateApplyTool(makeAgent(store));

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        clusters: [
          {
            memoIds: ['m1'],
            digest: {
              topic: 'bad evidence',
              kind: 'fact',
              statement: 'cites a memo it does not own',
              confidence: 'low',
              evidenceIds: ['m2'],
            },
          },
        ],
      },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(getOutputText(result)).toContain('outside');
    expect(await store.listDigests()).toHaveLength(0);
  });

  it('describes the grace window instead of immediate deletion', () => {
    const tool = new MemoryConsolidateApplyTool(makeAgent(store));
    expect(tool.description).toContain('grace window');
    expect(tool.description).not.toContain('deletes the original');
    expect(tool.parameters).toMatchObject({ type: 'object' });
  });

  it('returns an error when the store is unavailable', async () => {
    const tool = new MemoryConsolidateApplyTool(makeAgent(undefined));

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { clusters: [] },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(getOutputText(result)).toContain('not available');
  });
});
