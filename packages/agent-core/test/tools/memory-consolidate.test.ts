/**
 * MemoryConsolidatePlan / MemoryConsolidateApply against a real store.
 *
 * The contract under test: /dream merges duplicates, distils existing memories
 * and induces new rules — it never removes a memory for being old, and the apply
 * payload stays small (ids + new text) so a model can actually emit it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { MemoryMemoStore, createMemoryMemo, type MemoryMemo } from '@scream-code/memory';
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

function makeMemo(id: string, overrides: Partial<Omit<MemoryMemo, 'id'>> = {}): MemoryMemo {
  return createMemoryMemo({
    id,
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
  });
}

describe('MemoryConsolidate tools', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;
  let agent: Agent;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-consolidate-tool-'));
    store = new MemoryMemoStore(tmpDir);
    agent = {
      memoStore: store,
      dreamTracker: { recordDream: vi.fn(async () => {}) },
    } as unknown as Agent;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('says there is nothing new instead of proposing cleanup', async () => {
    await store.append(makeMemo('a', { recordedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }));
    // Mark it seen the way a completed pass would.
    await store.markDreamed(['a']);

    const result = await executeTool(new MemoryConsolidatePlanTool(agent), {
      turnId: '0',
      toolCallId: 'c1',
      args: {},
      signal,
    });
    expect(getOutputText(result)).toContain('nothing new to integrate');
    expect(getOutputText(result)).not.toMatch(/delete|remove|prune/iu);
  });

  it('returns the new plan shape, with no deletion lists', async () => {
    await store.append(makeMemo('a', { recordedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }));
    const result = await executeTool(new MemoryConsolidatePlanTool(agent), {
      turnId: '0',
      toolCallId: 'c2',
      args: {},
      signal,
    });
    const plan = JSON.parse(getOutputText(result)) as Record<string, unknown>;
    expect(plan['version']).toBe(2);
    expect(Object.keys(plan)).toEqual(
      expect.arrayContaining(['duplicateGroups', 'nearMisses', 'distillCandidates', 'inductionClusters']),
    );
    expect(plan).not.toHaveProperty('resolved');
    expect(plan).not.toHaveProperty('stale');
  });

  it('merges two duplicates, keeps lineage, and reports a merge id for undo', async () => {
    await store.append(makeMemo('d1', { userNeed: '同一件事', approach: '同一种做法' }));
    await store.append(makeMemo('d2', { userNeed: '同一件事', approach: '同一种做法' }));

    const result = await executeTool(new MemoryConsolidateApplyTool(agent), {
      turnId: '0',
      toolCallId: 'c3',
      args: {
        merges: [
          {
            memoIds: ['d1', 'd2'],
            merged: {
              userNeed: '同一件事',
              approach: '同一种做法',
              outcome: '完成',
              whatFailed: 'none',
              whatWorked: '一次做完',
              distilled: '当遇到同一件事时，直接用同一种做法一次做完',
            },
          },
        ],
        distillations: [],
        inductions: [],
      },
      signal,
    });

    const output = getOutputText(result);
    expect(output).toContain('merged 1 group(s)');
    expect(output).toContain('Merge id(s) for undo');
    expect(result.isError).not.toBe(true);
    expect(await store.get('d1')).toBeUndefined();
    const remaining: Array<{ distilledFrom?: Array<{ id: string }> }> = [];
    for await (const memo of store.read()) remaining.push(memo);
    const merged = remaining.find((memo) => (memo.distilledFrom?.length ?? 0) === 2);
    expect(merged?.distilledFrom?.map((source) => source.id).toSorted()).toEqual(['d1', 'd2']);
    expect(agent.dreamTracker.recordDream).toHaveBeenCalled();
  });

  it('distils without touching the memo or its origin', async () => {
    await store.append(makeMemo('k', { origin: 'user', userNeed: '装不上包' }));
    await executeTool(new MemoryConsolidateApplyTool(agent), {
      turnId: '0',
      toolCallId: 'c4',
      args: {
        merges: [],
        distillations: [{ memoId: 'k', distilled: '当发布后立刻安装报 404 时，先等两分钟再重试' }],
        inductions: [],
      },
      signal,
    });
    const after = await store.get('k');
    expect(after).toBeDefined();
    expect(after?.origin).toBe('user');
    expect(after?.distilled).toContain('先等两分钟');
  });

  it('induces a rule while leaving every source memo in place', async () => {
    for (const id of ['i1', 'i2', 'i3']) await store.append(makeMemo(id, { tags: ['deploy'] }));
    const result = await executeTool(new MemoryConsolidateApplyTool(agent), {
      turnId: '0',
      toolCallId: 'c5',
      args: {
        merges: [],
        distillations: [],
        inductions: [
          {
            topic: 'deploy',
            sourceMemoIds: ['i1', 'i2', 'i3'],
            rule: {
              userNeed: '部署反复失败',
              approach: '先看日志再改配置',
              distilled: '当部署反复失败时，先看日志再改配置，不要直接重部署',
            },
          },
        ],
      },
      signal,
    });
    expect(getOutputText(result)).toContain('induced 1 new rule(s)');
    for (const id of ['i1', 'i2', 'i3']) expect(await store.get(id)).toBeDefined();
  });

  it('reports a bad rule instead of failing the whole pass', async () => {
    await store.append(makeMemo('good'));
    const result = await executeTool(new MemoryConsolidateApplyTool(agent), {
      turnId: '0',
      toolCallId: 'c6',
      args: {
        merges: [],
        distillations: [
          { memoId: 'good', distilled: '合并 3 条相关记录。最新方案: 用了工具' },
          { memoId: 'good', distilled: '当遇到这类情况时先用工具再确认结果' },
        ],
        inductions: [],
      },
      signal,
    });
    const output = getOutputText(result);
    expect(output).toContain('Skipped 1');
    expect(output).toContain('distilled 1 memory');
    expect(result.isError).not.toBe(true);
  });

  it('validates the payload shape at the tool boundary', () => {
    const tool = new MemoryConsolidateApplyTool(agent);
    const validator = compileToolArgsValidator(tool.parameters);
    // Six ids exceed the per-merge cap of five.
    const tooMany = validateToolArgs(validator, {
        merges: [
          {
            memoIds: ['1', '2', '3', '4', '5', '6'],
            merged: {
              userNeed: 'n',
              approach: 'a',
              outcome: 'o',
              whatFailed: 'none',
              whatWorked: 'w',
              distilled: '当遇到 n 时先做 a',
            },
          },
        ],
        distillations: [],
        inductions: [],
    });
    expect(tooMany).not.toBeNull();
  });
});
