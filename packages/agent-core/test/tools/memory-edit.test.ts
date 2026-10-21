/**
 * Tests for MemoryEditTool — single memory memo update/delete.
 */

import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import type { MemoryMemo } from '@scream-code/memory';
import type { ExecutableToolResult } from '../../src/loop';
import {
  MemoryEditInputSchema,
  MemoryEditTool,
} from '../../src/tools/builtin/memory/memory-edit';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function getOutputText(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : '';
}

function makeAgent(memos: MemoryMemo[]) {
  const stored = [...memos];
  return {
    agent: {
      memoStore: {
        get: async (id: string) => stored.find((m) => m.id === id),
        update: async (id: string, patch: Partial<MemoryMemo>) => {
          const index = stored.findIndex((m) => m.id === id);
          if (index === -1) return false;
          stored[index] = { ...stored[index]!, ...patch };
          return true;
        },
        delete: async (id: string) => {
          const index = stored.findIndex((m) => m.id === id);
          if (index === -1) return false;
          stored.splice(index, 1);
          return true;
        },
      },
    } as unknown as Agent,
    stored,
  };
}

function makeMemo(id: string): MemoryMemo {
  return {
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
    projectDir: '/workspace/project',
    tags: ['old'],
  };
}

describe('MemoryEditTool', () => {
  it('exposes current metadata and schema', () => {
    const { agent } = makeAgent([]);
    const tool = new MemoryEditTool(agent);

    expect(tool.name).toBe('MemoryEdit');
    expect(tool.description).toContain('Update or delete');
    expect(tool.description).toContain('id');
    expect(MemoryEditInputSchema.safeParse({ id: 'x', action: 'update', updates: {} }).success).toBe(
      true,
    );
    expect(MemoryEditInputSchema.safeParse({ id: 'x', action: 'delete' }).success).toBe(true);
    expect(MemoryEditInputSchema.safeParse({ id: 'x', action: 'bad' }).success).toBe(false);
  });

  it('updates selected fields while preserving others', async () => {
    const { agent, stored } = makeAgent([makeMemo('m1')]);
    const tool = new MemoryEditTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { id: 'm1', action: 'update', updates: { outcome: '失败' } },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(getOutputText(result)).toContain('Updated');
    expect(stored[0]!.outcome).toBe('失败');
    expect(stored[0]!.userNeed).toBe('Need');
    expect(stored[0]!.tags).toEqual(['old']);
  });

  it('updates the note and the latest distillation', async () => {
    const { agent, stored } = makeAgent([makeMemo('m1')]);
    const tool = new MemoryEditTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: {
        id: 'm1',
        action: 'update',
        updates: { note: '先看网关日志', distilled: '刷新令牌统一走拦截器' },
      },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(stored[0]!.note).toBe('先看网关日志');
    expect(stored[0]!.distilled).toBe('刷新令牌统一走拦截器');
    expect(stored[0]!.origin).toBe('user');
    expect(stored[0]!.distilledAt).toBeGreaterThan(0);
  });

  it('clears the note and distillation when updated to an empty string', async () => {
    const memo = { ...makeMemo('m1'), note: '旧笔记', distilled: '旧结论' };
    const { agent, stored } = makeAgent([memo]);
    const tool = new MemoryEditTool(agent);

    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { id: 'm1', action: 'update', updates: { note: '   ', distilled: '' } },
      signal,
    });

    expect(stored[0]!.note).toBeUndefined();
    expect(stored[0]!.distilled).toBeUndefined();
    expect(stored[0]!.origin).toBe('session');
    expect(stored[0]!.distilledAt).toBeUndefined();
  });

  it('updates tags', async () => {    const { agent, stored } = makeAgent([makeMemo('m1')]);
    const tool = new MemoryEditTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { id: 'm1', action: 'update', updates: { tags: ['React', 'Auth'] } },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(getOutputText(result)).toContain('Updated');
    expect(stored[0]!.tags).toEqual(['react', 'auth']);
  });

  it('deletes a memo by id', async () => {
    const { agent, stored } = makeAgent([makeMemo('m1')]);
    const tool = new MemoryEditTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { id: 'm1', action: 'delete' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(getOutputText(result)).toContain('Deleted');
    expect(stored.length).toBe(0);
  });

  it('returns an error when the memo id does not exist', async () => {
    const { agent } = makeAgent([]);
    const tool = new MemoryEditTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { id: 'missing', action: 'update', updates: { outcome: '失败' } },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(getOutputText(result)).toContain('not found');
  });

  it('returns an error when no updates are provided for update action', async () => {
    const { agent } = makeAgent([makeMemo('m1')]);
    const tool = new MemoryEditTool(agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { id: 'm1', action: 'update' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(getOutputText(result)).toContain('No updates');
  });

  it('returns an error when the store is unavailable', async () => {
    const tool = new MemoryEditTool({ memoStore: undefined } as unknown as Agent);

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_1',
      args: { id: 'x', action: 'delete' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(getOutputText(result)).toContain('not available');
  });
});
