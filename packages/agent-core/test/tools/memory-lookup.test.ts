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

function makeMemo(partial: Omit<MemoryMemo, 'id' | 'recordedAt'> & { id: string }): MemoryMemo {
  return {
    ...partial,
    recordedAt: Date.now(),
  };
}

function makeStore(memos: MemoryMemo[]): { store: NonNullable<Agent['memoStore']> } {
  return {
    store: {
      read: async function* () {
        for (const memo of memos) {
          yield memo;
        }
      },
    } as unknown as NonNullable<Agent['memoStore']>,
  };
}

function makeAgent(memos: MemoryMemo[]): { agent: Agent } {
  const { store } = makeStore(memos);
  return {
    agent: {
      memoStore: store,
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

  it('returns an error when the store is unavailable', async () => {
    const tool = new MemoryLookupTool({ memoStore: undefined } as unknown as Agent);

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

  it('resolveExecution description is stable', () => {
    const { agent } = makeAgent([]);
    const execution = new MemoryLookupTool(agent).resolveExecution({ query: 'x' });
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Searching memory memos');
  });
});
