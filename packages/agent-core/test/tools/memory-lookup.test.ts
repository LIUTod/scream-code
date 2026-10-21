/**
 * Tests for MemoryLookupTool — active memory memo search by the model.
 */

import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import type { MemoryMemo } from '@scream-code/memory';
import {
  MemoryLookupInputSchema,
  MemoryLookupTool,
} from '../../src/tools/builtin/memory/memory-lookup';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeMemo(partial: Omit<MemoryMemo, 'id' | 'recordedAt' | 'projectDir'> & { id: string; projectDir?: string }): MemoryMemo {
  return {
    ...partial,
    projectDir: partial.projectDir ?? '',
    recordedAt: Date.now(),
  };
}

function makeStore(memos: MemoryMemo[]): { store: NonNullable<Agent['memoStore']> } {
  return {
    store: {
      read: async function* (options?: { projectDir?: string }) {
        for (const memo of memos) {
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
      getEmbeddingEngine: () => undefined,
      hasEmbeddings: () => false,
      searchByVector: async () => [],
      search: async (query: string, options?: { projectDir?: string }) => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        return memos.filter((memo) => {
          if (
            options?.projectDir !== undefined &&
            memo.projectDir !== options.projectDir &&
            memo.projectDir !== ''
          ) {
            return false;
          }
          const text = [
            memo.userNeed,
            memo.approach,
            memo.whatFailed,
            memo.whatWorked,
            memo.distilled ?? '',
            memo.note ?? '',
            memo.sourceSessionTitle ?? '',
          ]
            .join(' ')
            .toLowerCase();
          return terms.every((term) => text.includes(term));
        });
      },
    } as unknown as NonNullable<Agent['memoStore']>,
  };
}

function makeAgent(memos: MemoryMemo[], cwd = '/workspace/project'): { agent: Agent } {
  const { store } = makeStore(memos);
  return {
    agent: {
      memoStore: store,
      config: { cwd },
    } as unknown as Agent,
  };
}

describe('MemoryLookupTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const { agent } = makeAgent([]);
    const tool = new MemoryLookupTool(agent);

    expect(tool.name).toBe('MemoryLookup');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain('memory memo store');
    expect(MemoryLookupInputSchema.safeParse({ query: 'test' }).success).toBe(true);
    expect(MemoryLookupInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    });
  });

  it('returns ranked memos matching the query', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        sourceSessionTitle: 'Auth refactor',
        userNeed: 'Fix JWT token rotation',
        approach: 'Use redis to store refresh tokens',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'Storing tokens in redis with TTL',
        extractionSource: 'compaction',
      }),
      makeMemo({
        id: 'm2',
        sourceSessionId: 's2',
        sourceSessionTitle: 'Login bug',
        userNeed: 'Resolve OAuth redirect loop',
        approach: 'Check redirect_uri exact match',
        outcome: '完成',
        whatFailed: 'Trailing slash in redirect URI caused mismatch',
        whatWorked: 'Use exact string comparison for redirect_uri',
        extractionSource: 'exit',
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'JWT token rotation redis', min_score: 0.3 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Found 1 relevant memory memo');
    expect(result.output).toContain('Fix JWT token rotation');
    expect(result.output).toContain('Use redis to store refresh tokens');
    expect(result.output).toContain('Storing tokens in redis with TTL');
    expect(result.output).toContain('from: Auth refactor');
    expect(result.output).not.toContain('Resolve OAuth redirect loop');
  });

  it('surfaces the latest distillation and note', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: '修复令牌刷新',
        approach: '统一走拦截器',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: '拦截器自动刷新',
        distilled: '刷新令牌统一走拦截器，不要在页面手动重试',
        note: '先看网关日志',
        extractionSource: 'compaction',
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: '手动重试', min_score: 0 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Latest distillation: 刷新令牌统一走拦截器');
    expect(result.output).toContain('Note: 先看网关日志');
  });

  it('returns an error when the store is unavailable', async () => {    const tool = new MemoryLookupTool({ memoStore: undefined } as unknown as Agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'anything' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not available');
  });

  it('reports an empty store', async () => {
    const { agent } = makeAgent([]);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'anything' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('experience store is empty');
  });

  it('reports no matches when nothing is relevant enough', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: 'Deploy to production',
        approach: 'Use docker compose',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'completely unrelated quantum physics topic', min_score: 0.5 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No relevant memory memos found');
  });

  it('respects the limit parameter and caps at the maximum', async () => {
    const memos = Array.from({ length: 25 }, (_, i) =>
      makeMemo({
        id: `m${i}`,
        sourceSessionId: 's1',
        userNeed: `Task number ${i} about authentication`,
        approach: 'Approach',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
      }),
    );
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'authentication', limit: 100 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Found 20 relevant memory memos');
  });

  it('respects a custom min_score threshold', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: 'Fix authentication bug',
        approach: 'Approach',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'authentication', min_score: 0.99 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No relevant memory memos found');
  });

  it('omits optional fields when they are none', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: 'Simple task',
        approach: 'Simple approach',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'exit',
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'simple task' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Simple task');
    expect(result.output).not.toContain('What failed');
    expect(result.output).not.toContain('What worked');
  });

  it('uses store.search() to narrow candidates before ranking', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: 'Fix redis cache eviction',
        approach: 'Use LRU policy',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
      }),
      makeMemo({
        id: 'm2',
        sourceSessionId: 's2',
        userNeed: ' unrelated topic about databases',
        approach: 'SQL tuning',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'exit',
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'redis LRU', min_score: 0.3 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Fix redis cache eviction');
    expect(result.output).not.toContain('unrelated topic');
  });

  it('falls back to store.read() when search returns no candidates', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: 'Fix redis cache eviction',
        approach: 'Use LRU policy',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
      }),
    ];
    const { agent } = makeAgent(memos);
    const tool = new MemoryLookupTool(agent);

    // "strategy" is not a substring of the memo, so the mock FTS search returns
    // nothing and the tool falls back to scanning the full store. rankMemos
    // still finds the keyword overlap on "eviction" and returns the memo.
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'eviction strategy', min_score: 0.25 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('redis cache eviction');
  });

  it('respects scope parameter to filter by projectDir', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: 'Project A task',
        approach: 'Approach',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
        projectDir: '/workspace/a',
      }),
      makeMemo({
        id: 'm2',
        sourceSessionId: 's2',
        userNeed: 'Project B task',
        approach: 'Approach',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
        projectDir: '/workspace/b',
      }),
    ];
    const { agent } = makeAgent(memos, '/workspace/a');
    const tool = new MemoryLookupTool(agent);

    const projectResult = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'task', scope: 'project' },
      signal,
    });
    expect(projectResult.output).toContain('Project A task');
    expect(projectResult.output).not.toContain('Project B task');

    const globalResult = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_2',
      args: { query: 'task', scope: 'global' },
      signal,
    });
    expect(globalResult.output).toContain('Project A task');
    expect(globalResult.output).toContain('Project B task');
  });

  it('defaults to global scope', async () => {
    const memos = [
      makeMemo({
        id: 'm1',
        sourceSessionId: 's1',
        userNeed: 'Project A task',
        approach: 'Approach',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
        projectDir: '/workspace/a',
      }),
      makeMemo({
        id: 'm2',
        sourceSessionId: 's2',
        userNeed: 'Project B task',
        approach: 'Approach',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'none',
        extractionSource: 'compaction',
        projectDir: '/workspace/b',
      }),
    ];
    const { agent } = makeAgent(memos, '/workspace/a');
    const tool = new MemoryLookupTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { query: 'task' },
      signal,
    });
    expect(result.output).toContain('Project A task');
    expect(result.output).toContain('Project B task');
  });

  it('resolveExecution description is stable', () => {
    const { agent } = makeAgent([]);
    const execution = new MemoryLookupTool(agent).resolveExecution({ query: 'x' });
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Searching memory memos');
  });
});
