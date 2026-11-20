import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import type { ExecutableToolContext, ExecutableToolResult } from '../../src/loop/types';

/**
 * The "delete the foreground Agent" contract: an omitted `run_in_background`
 * must never hard-block the parent turn.
 *
 * - 'auto' (default): a short foreground window returns quick tasks inline,
 *   and a subagent that outlives the window is handed to the background — its
 *   result arrives later as a notification instead of parking the parent.
 * - 'background': the task id returns immediately, no foreground wait at all.
 * - 'foreground': the legacy inline wait (only an explicit timeout bounds it).
 * - An explicit `run_in_background` always overrides the mode.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHost(handle: {
  agentId: string;
  profileName: string;
  completion: Promise<{ result: string; usage: unknown }>;
}) {
  return {
    spawn: vi.fn(async () => handle),
    resume: vi.fn(),
    getProfileName: vi.fn(() => 'coder'),
    backgroundTaskTimeoutMs: 600_000,
    waitForChildRequest: vi.fn(() => new Promise<void>(() => {})),
    releaseChildRequestWait: vi.fn(),
  };
}

function makeTool(
  host: unknown,
  backgroundManager: unknown,
  options: { subagentMode?: 'auto' | 'background' | 'foreground'; foregroundBudgetMs?: number } = {},
): AgentTool {
  return new AgentTool(host as never, backgroundManager as never, undefined, {
    allowBackground: backgroundManager !== undefined,
    log: undefined,
    ...options,
  });
}

function execute(
  tool: AgentTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ExecutableToolResult> {
  const exec = tool.resolveExecution(args as never) as {
    execute(ctx: unknown): Promise<ExecutableToolResult>;
  };
  return exec.execute({ toolCallId: 'call_1', signal } as unknown as ExecutableToolContext);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentTool subagentMode (default = auto, never hard-block)', () => {
  it('auto: a quick subagent still returns inline within the window', async () => {
    const handle = {
      agentId: 'agent-quick',
      profileName: 'coder',
      completion: Promise.resolve({ result: 'done fast', usage: {} }),
    };
    const registerAgentTask = vi.fn(() => 'task-x');
    const tool = makeTool(makeHost(handle), { registerAgentTask }, { subagentMode: 'auto' });

    const controller = new AbortController();
    const result = await execute(tool, { prompt: 'p', description: 'd' }, controller.signal);

    // Inline completion: no background registration, result text present.
    expect(registerAgentTask).not.toHaveBeenCalled();
    expect(result.output).toContain('done fast');
    expect(result.isError).not.toBe(true);
  });

  it('auto: a subagent that outlives the window is handed to the background, not awaited', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const handle = { agentId: 'agent-slow', profileName: 'coder', completion: completion.promise };
    const registerAgentTask = vi.fn(() => 'task-auto-1');
    // A tiny window so the test does not need to advance 30s.
    const tool = makeTool(makeHost(handle), { registerAgentTask }, { subagentMode: 'auto', foregroundBudgetMs: 50 });

    const controller = new AbortController();
    const execPromise = execute(tool, { prompt: 'p', description: 'd' }, controller.signal);
    // Let spawn settle, then fire the auto-background window.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60);
    const result = await execPromise;

    // The parent got a task id back (backgrounded), NOT a blocking wait, and
    // the child was never aborted — it can still complete later.
    expect(registerAgentTask).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('task-auto-1');
    expect(controller.signal.aborted).toBe(false);
    // P1 regression: the auto handoff must carry the operator-configured
    // background deadline, or a hung child would never be reaped.
    expect(registerAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'd',
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
    // Clean up the pending child.
    completion.resolve({ result: 'late', usage: {} });
  });

  it('background: returns the task id immediately even for a quick task', async () => {
    const completion = deferred<{ result: string; usage: unknown }>();
    const handle = { agentId: 'agent-bg', profileName: 'coder', completion: completion.promise };
    const registerAgentTask = vi.fn(() => 'task-bg-1');
    // The direct-background path reserves a concurrency slot before spawning.
    const reserveSlot = vi.fn(() => ({ release: vi.fn() }));
    const tool = makeTool(makeHost(handle), { registerAgentTask, reserveSlot }, { subagentMode: 'background' });

    const controller = new AbortController();
    const result = await execute(tool, { prompt: 'p', description: 'd' }, controller.signal);

    expect(registerAgentTask).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('task-bg-1');
    expect(result.output).toContain('automatic_notification: true');
    completion.resolve({ result: 'x', usage: {} });
  });

  it('foreground: keeps the legacy inline wait (no auto handoff)', async () => {
    const handle = {
      agentId: 'agent-fg',
      profileName: 'coder',
      completion: Promise.resolve({ result: 'inline result', usage: {} }),
    };
    const registerAgentTask = vi.fn(() => 'task-fg');
    const tool = makeTool(makeHost(handle), { registerAgentTask }, { subagentMode: 'foreground' });

    const controller = new AbortController();
    const result = await execute(tool, { prompt: 'p', description: 'd' }, controller.signal);

    expect(registerAgentTask).not.toHaveBeenCalled();
    expect(result.output).toContain('inline result');
  });

  it('an explicit run_in_background=false overrides even background mode', async () => {
    const handle = {
      agentId: 'agent-override',
      profileName: 'coder',
      completion: Promise.resolve({ result: 'forced inline', usage: {} }),
    };
    const registerAgentTask = vi.fn(() => 'task-override');
    const tool = makeTool(makeHost(handle), { registerAgentTask }, { subagentMode: 'background' });

    const controller = new AbortController();
    const result = await execute(
      tool,
      { prompt: 'p', description: 'd', run_in_background: false },
      controller.signal,
    );

    expect(registerAgentTask).not.toHaveBeenCalled();
    expect(result.output).toContain('forced inline');
  });

  it('falls back to a foreground wait when background dispatch is unavailable', async () => {
    // No background manager: 'auto'/'background' cannot detach, so the call
    // still completes inline rather than erroring — a capability-limited host
    // keeps working.
    const handle = {
      agentId: 'agent-nomgr',
      profileName: 'coder',
      completion: Promise.resolve({ result: 'no manager inline', usage: {} }),
    };
    const tool = makeTool(makeHost(handle), undefined, { subagentMode: 'background' });

    const controller = new AbortController();
    const result = await execute(tool, { prompt: 'p', description: 'd' }, controller.signal);

    expect(result.output).toContain('no manager inline');
    expect(result.isError).not.toBe(true);
  });
});
