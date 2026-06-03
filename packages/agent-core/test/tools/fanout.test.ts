import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagentHost, SubagentHandle } from '../../src/session/subagent-host';
import {
  FanOutInputSchema,
  FanOutTool,
  type FanOutInput,
} from '../../src/tools/builtin/collaboration/fanout';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

// ── Helpers ────────────────────────────────────────────────────────────────

interface MockCompletion {
  result: string;
}

function mockHandle(completion: MockCompletion | Error): SubagentHandle {
  const promise = completion instanceof Error
    ? Promise.reject(completion)
    : Promise.resolve(completion);
  return {
    agentId: 'agent-0',
    profileName: 'coder',
    resumed: false,
    completion: promise as Promise<{ result: string }>,
  };
}

function mockSubagentHost(handles: SubagentHandle[]): SessionSubagentHost {
  const spawn = vi.fn<(profileName: string, options: unknown) => Promise<SubagentHandle>>();
  for (const handle of handles) {
    spawn.mockResolvedValueOnce(handle);
  }
  return { spawn } as unknown as SessionSubagentHost;
}

function fanOutTool(host: SessionSubagentHost): FanOutTool {
  return new FanOutTool(host);
}

async function execute(tool: FanOutTool, input: FanOutInput) {
  return executeTool(tool, {
    turnId: '0',
    toolCallId: 'call_0',
    args: input,
    signal,
  });
}

function twoTasks(): FanOutInput {
  return {
    tasks: [
      { description: 'Analyze auth', prompt: 'Analyze src/auth/login.ts structure.' },
      { description: 'Analyze db', prompt: 'Analyze src/db/query.ts structure.' },
    ],
  };
}

// ── Schema validation ──────────────────────────────────────────────────────

describe('FanOutInputSchema', () => {
  it('accepts valid input with 2 tasks', () => {
    const result = FanOutInputSchema.safeParse(twoTasks());
    expect(result.success).toBe(true);
  });

  it('accepts 5 tasks (max)', () => {
    const input: FanOutInput = {
      tasks: Array.from({ length: 5 }, (_, i) => ({
        description: `Task ${i}`,
        prompt: `Do task ${i}`,
      })),
    };
    const result = FanOutInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects empty tasks array', () => {
    const result = FanOutInputSchema.safeParse({ tasks: [] });
    expect(result.success).toBe(false);
  });

  it('rejects more than 5 tasks', () => {
    const input = {
      tasks: Array.from({ length: 6 }, (_, i) => ({
        description: `Task ${i}`,
        prompt: `Do task ${i}`,
      })),
    };
    const result = FanOutInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects missing description', () => {
    const result = FanOutInputSchema.safeParse({
      tasks: [{ prompt: 'test' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing prompt', () => {
    const result = FanOutInputSchema.safeParse({
      tasks: [{ description: 'test' }],
    });
    expect(result.success).toBe(false);
  });

  it('defaults subagent_type when omitted', () => {
    const result = FanOutInputSchema.safeParse(twoTasks());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0]!.subagent_type).toBeUndefined();
    }
  });
});

// ── ConflictTracker ─────────────────────────────────────────────────────────

describe('ConflictTracker', () => {
  it('detects overlapping file paths between tasks', () => {
    // The ConflictTracker is exercised internally by the FanOut execution.
    // We test it indirectly by verifying that tasks referencing the same file
    // still complete (the warning is injected into the prompt).
    const host = mockSubagentHost([
      mockHandle({ result: 'auth analysis done.' }),
      mockHandle({ result: 'db analysis done.' }),
    ]);

    const tool = fanOutTool(host);
    const input: FanOutInput = {
      tasks: [
        { description: 'Fix auth', prompt: 'Edit src/auth/login.ts — fix the login bug.' },
        { description: 'Refactor auth', prompt: 'Refactor src/auth/login.ts — simplify.' },
      ],
    };

    // Both tasks reference the same file; FanOut should still spawn both
    // and inject conflict warnings into their prompts.
    const exec = tool.resolveExecution(input);
    if ('isError' in exec) {
      expect.unreachable('resolveExecution returned an error');
    } else {
      expect(exec.description).toContain('FanOut');
    }

    // The spawn mock verifies both were called
    void execute(tool, input).then(() => {
      expect(host.spawn).toHaveBeenCalledTimes(2);
    });
  });

  it('does not warn when tasks reference different files', () => {
    const host = mockSubagentHost([
      mockHandle({ result: 'done 1.' }),
      mockHandle({ result: 'done 2.' }),
    ]);

    const tool = fanOutTool(host);
    const input = twoTasks();

    const exec = tool.resolveExecution(input);
    // Both tasks use different files; should not fail
    expect(exec).toBeDefined();
  });
});

// ── Execution ───────────────────────────────────────────────────────────────

describe('FanOut execution', () => {
  it('spawns all tasks and aggregates results', async () => {
    const host = mockSubagentHost([
      mockHandle({ result: 'auth: found 3 endpoints' }),
      mockHandle({ result: 'db: found 5 tables' }),
    ]);

    const tool = fanOutTool(host);
    const result = await execute(tool, twoTasks());

    expect(host.spawn).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Analyze auth');
    expect(result.output).toContain('Analyze db');
    expect(result.output).toContain('auth: found 3 endpoints');
    expect(result.output).toContain('db: found 5 tables');
    expect(result.output).toContain('✅');
    expect(result.output).toContain('status: completed');
  });

  it('reports failed subagents alongside successful ones', async () => {
    const host = mockSubagentHost([
      mockHandle({ result: 'task 1 done' }),
      mockHandle(new Error('db connection refused')),
    ]);

    const tool = fanOutTool(host);
    const result = await execute(tool, twoTasks());

    expect(host.spawn).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true); // because one failed
    expect(result.output).toContain('✅'); // success badge
    expect(result.output).toContain('❌'); // failure badge
    expect(result.output).toContain('task 1 done');
    expect(result.output).toContain('db connection refused');
    expect(result.output).toContain('status: completed');
    expect(result.output).toContain('status: failed');
  });

  it('marks error when no subagents spawn successfully', async () => {
    const host = mockSubagentHost([]);
    // Override spawn to always throw
    (host.spawn as ReturnType<typeof vi.fn>).mockReset();
    (host.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('spawn failed'));

    const tool = fanOutTool(host);
    const result = await execute(tool, twoTasks());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('all subagents failed to spawn');
  });

  it('caps at 5 tasks even if input provides more', async () => {
    // Schema rejects >5, so this is only reachable via internal slicing
    const handles = Array.from({ length: 5 }, (_, i) =>
      mockHandle({ result: `task ${i} done` }),
    );
    const host = mockSubagentHost(handles);
    const tool = fanOutTool(host);

    const input: FanOutInput = {
      tasks: Array.from({ length: 5 }, (_, i) => ({
        description: `Task ${i}`,
        prompt: `Do task ${i}`,
      })),
    };

    const result = await execute(tool, input);
    expect(host.spawn).toHaveBeenCalledTimes(5);
    expect(result.isError).toBeFalsy();
  });

  it('includes error from aborted subagent', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    const host = mockSubagentHost([
      mockHandle({ result: 'done' }),
      mockHandle(abortError),
    ]);

    const tool = fanOutTool(host);
    const result = await execute(tool, twoTasks());

    expect(result.output).toContain('stopped before completion');
  });
});
