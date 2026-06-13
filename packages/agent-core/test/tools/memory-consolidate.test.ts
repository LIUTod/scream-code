/**
 * Tests for MemoryConsolidatePlanTool and MemoryConsolidateApplyTool.
 */

import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import type { MemoryMemo, MemoryMemoStore } from '@scream-code/memory';
import type { ExecutableToolResult } from '../../src/loop';
import {
  MemoryConsolidateApplyTool,
  MemoryConsolidatePlanTool,
} from '../../src/tools/builtin/memory/memory-consolidate';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function getOutputText(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : '';
}

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
    ...overrides,
    id,
  };
}

interface MockStore extends MemoryMemoStore {
  getDeletedIds(): string[];
  getAppended(): MemoryMemo[];
}

function makeStore(memos: MemoryMemo[]) {
  const stored = [...memos];
  const deletedIds = new Set<string>();
  const appended: MemoryMemo[] = [];

  return {
    store: {
      read: async function* () {
        for (const memo of stored) {
          if (!deletedIds.has(memo.id)) {
            yield memo;
          }
        }
      },
      delete: async (id: string) => {
        if (deletedIds.has(id)) return false;
        deletedIds.add(id);
        return true;
      },
      append: async (memo: MemoryMemo) => {
        appended.push(memo);
        return;
      },
      getDeletedIds: () => [...deletedIds],
      getAppended: () => appended,
    } as unknown as MockStore,
  };
}

function makeAgent(memos: MemoryMemo[], tracker?: { recordDream: () => Promise<void> }) {
  const { store } = makeStore(memos);
  return {
    agent: {
      memoStore: store as unknown as NonNullable<Agent['memoStore']>,
      dreamTracker: tracker ?? { recordDream: async () => {} },
    } as unknown as Agent,
    store,
  };
}

describe('MemoryConsolidatePlanTool', () => {
  it('has name, description, and empty parameters', () => {
    const { agent } = makeAgent([]);
    const tool = new MemoryConsolidatePlanTool(agent);

    expect(tool.name).toBe('MemoryConsolidatePlan');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain('consolidation plan');
    expect(tool.parameters).toMatchObject({ type: 'object', properties: {} });
  });

  it('returns a consolidation plan for near-duplicate memos', async () => {
    const memos = [
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        approach: 'Add axios interceptor',
        outcome: '完成',
        whatWorked: 'Interceptor handles refresh automatically',
        recordedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
      }),
      makeMemo('m2', {
        userNeed: 'Fix login token refresh bug',
        approach: 'Use axios interceptor for refresh',
        outcome: '完成',
        whatWorked: 'Auto refresh works',
        recordedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
      }),
      makeMemo('m3', {
        userNeed: 'Add dark mode',
        approach: 'CSS variables',
        outcome: '失败',
        recordedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryConsolidatePlanTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result.isError).toBeFalsy();
    const plan = JSON.parse(getOutputText(result));
    expect(plan.summary.totalMemos).toBe(3);
    expect(plan.duplicateGroups.length).toBeGreaterThan(0);
    expect(plan.resolved.length).toBeGreaterThan(0);
    expect(plan.stale.length).toBeGreaterThan(0);
  });

  it('reports an empty store', async () => {
    const { agent } = makeAgent([]);
    const tool = new MemoryConsolidatePlanTool(agent);

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
    const tool = new MemoryConsolidatePlanTool({ memoStore: undefined } as unknown as Agent);

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
  it('applies a plan and records the dream', async () => {
    const memos = [
      makeMemo('m1', { userNeed: 'Fix login token refresh', outcome: '完成' }),
      makeMemo('m2', { userNeed: 'Fix login token refresh bug', outcome: '完成' }),
    ];
    let dreamRecorded = false;
    const { agent, store } = makeAgent(memos, {
      recordDream: async () => {
        dreamRecorded = true;
      },
    });

    const planTool = new MemoryConsolidatePlanTool(agent);
    const planResult = await executeTool(planTool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    const plan = JSON.parse(getOutputText(planResult));
    const applyTool = new MemoryConsolidateApplyTool(agent);

    const result = await executeTool(applyTool, {
      turnId: 't1',
      toolCallId: 'call_2',
      args: plan,
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(getOutputText(result)).toContain('Consolidation complete');
    expect(dreamRecorded).toBe(true);
    expect(store.getDeletedIds().length).toBeGreaterThan(0);
    expect(store.getAppended().length).toBeGreaterThan(0);
  });

  it('returns an error when the store is unavailable', async () => {
    const tool = new MemoryConsolidateApplyTool({ memoStore: undefined } as unknown as Agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        duplicateGroups: [],
        resolved: [],
        stale: [],
        summary: {
          totalMemos: 0,
          duplicatesFound: 0,
          resolvedFound: 0,
          staleFound: 0,
          memosAfterConsolidation: 0,
        },
      },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(getOutputText(result)).toContain('not available');
  });
});
