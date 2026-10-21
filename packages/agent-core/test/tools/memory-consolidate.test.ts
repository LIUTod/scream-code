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
import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function getOutputText(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : '';
}

function makeMemo(
  id: string,
  overrides: Partial<Omit<MemoryMemo, 'id' | 'projectDir'>> & { projectDir?: string } = {},
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
      read: async function* (options?: { projectDir?: string }) {
        for (const memo of stored) {
          if (deletedIds.has(memo.id)) continue;
          if (
            options?.projectDir !== undefined &&
            memo.projectDir !== options.projectDir &&
            memo.projectDir !== ''
          ) {
            continue;
          }
          yield memo;
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

function makeAgent(memos: MemoryMemo[], tracker?: { recordDream: () => Promise<void> }, cwd = '/workspace/project') {
  const { store } = makeStore(memos);
  return {
    agent: {
      memoStore: store as unknown as NonNullable<Agent['memoStore']>,
      dreamTracker: tracker ?? { recordDream: async () => {} },
      config: { cwd },
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
    expect(plan.duplicateGroups[0].merged.distilled).toBe('');
    expect(plan.resolved.length).toBeGreaterThan(0);
    expect(plan.stale.length).toBeGreaterThan(0);
  });

  it('identifies related memos sharing a compound topic without treating them as duplicates', async () => {
    const memos = [
      makeMemo('r1', {
        userNeed: 'Install and use sample-tool',
        approach: 'curl install then run',
        outcome: '完成',
        recordedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
      }),
      makeMemo('r2', {
        userNeed: 'Delete sample-tool without asking',
        approach: 'rm -rf the folder silently',
        outcome: '完成',
        recordedAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
      }),
      makeMemo('r3', {
        userNeed: 'Delete sample-tool cleanly',
        approach: 'remove config and binaries',
        outcome: '完成',
        recordedAt: Date.now(),
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
    expect(plan.relatedGroups.length).toBeGreaterThan(0);
    const relatedGroup = plan.relatedGroups.find((g: { topic: string }) => g.topic === 'sample-tool');
    expect(relatedGroup).toBeDefined();
    expect(relatedGroup.memos.length).toBe(3);
    expect(plan.duplicateGroups.length).toBe(0);
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
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        outcome: '完成',
        note: '先看网关日志',
      }),
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
    expect(plan.duplicateGroups.length).toBeGreaterThan(0);
    const distilledText = '刷新令牌统一走 axios 拦截器，不要在页面里手动重试';
    plan.duplicateGroups[0].merged.distilled = distilledText;
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
    expect(store.getAppended().some((memo) => memo.distilled === distilledText)).toBe(true);
  });

  it('accepts a plan whose memos carry origin, distilledAt and lineage', async () => {
    const memos = [
      makeMemo('m1', {
        userNeed: 'Fix login token refresh',
        outcome: '部分完成',
        distilled: '旧结论：拦截器负责刷新',
        origin: 'dream',
        distilledAt: 1_700_000_000_000,
        distilledFrom: [{ id: 'older', title: '更早的条目', at: 1_699_000_000_000 }],
      }),
      makeMemo('m2', { userNeed: 'Fix login token refresh bug', outcome: '部分完成' }),
    ];
    const { agent, store } = makeAgent(memos);

    const planResult = await executeTool(new MemoryConsolidatePlanTool(agent), {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {},
      signal,
    });
    const plan = JSON.parse(getOutputText(planResult));
    expect(plan.duplicateGroups.length).toBeGreaterThan(0);

    const distilledText = '刷新令牌统一走拦截器，页面不再手动重试';
    plan.duplicateGroups[0].merged.distilled = distilledText;

    const applyTool = new MemoryConsolidateApplyTool(agent);
    // The plan is passed back verbatim, so the closed-object parameter schema
    // must accept the provenance fields it carries.
    const validator = compileToolArgsValidator(applyTool.parameters);
    expect(validateToolArgs(validator, plan)).toBeNull();

    const result = await executeTool(applyTool, {
      turnId: 't1',
      toolCallId: 'call_2',
      args: plan,
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(store.getAppended().some((memo) => memo.distilled === distilledText)).toBe(true);
  });

  it('returns an error when the store is unavailable', async () => {
    const tool = new MemoryConsolidateApplyTool({ memoStore: undefined } as unknown as Agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        duplicateGroups: [],
        relatedGroups: [],
        resolved: [],
        stale: [],
        summary: {
          totalMemos: 0,
          duplicatesFound: 0,
          relatedGroupsFound: 0,
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
