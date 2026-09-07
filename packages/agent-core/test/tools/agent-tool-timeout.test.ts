import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import type { ExecutableToolContext, ExecutableToolResult } from '../../src/loop/types';
import { UserCancellationError } from '../../src/utils/abort';

/**
 * P0 regression tests: a foreground `Agent` call with an explicit `timeout`
 * must NOT abort the subagent when the deadline fires. Instead the still-running
 * child is handed to the background task manager (status: backgrounded) and the
 * completed work is preserved. User cancellation still aborts immediately, and
 * after the handoff the parent signal no longer controls the child — only an
 * explicit TaskStop of the background task terminates it.
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
  };
}

function makeTool(host: unknown, backgroundManager?: unknown): AgentTool {
  return new AgentTool(host as never, backgroundManager as never, undefined, {
    allowBackground: backgroundManager !== undefined,
    log: undefined,
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

describe('AgentTool foreground timeout → background handoff', () => {
  it('does not abort the child on timeout; hands it to the background manager', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const registerAgentTask = vi.fn(() => 'task-42');
    const backgroundManager = { registerAgentTask };
    const tool = makeTool(makeHost(handle), backgroundManager);

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'long task', description: 'long task', timeout: 30 },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const output = await execPromise;

    expect(registerAgentTask).toHaveBeenCalledWith(
      completion.promise,
      'long task',
      expect.objectContaining({ agentId: 'agent-0', subagentType: 'coder' }),
    );
    expect(output.isError).toBeUndefined();
    expect(output.output).toContain('status: backgrounded');
    expect(output.output).toContain('task_id: task-42');
    expect(output.output).toContain('agent_id: agent-0');
    // The child signal must NOT have been aborted by the timeout — its work is
    // still in flight under the background task.
    expect(controller.signal.aborted).toBe(false);
  });

  it('completes normally (status: completed + [summary]) when the child finishes before the timeout', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const backgroundManager = { registerAgentTask: vi.fn() };
    const tool = makeTool(makeHost(handle), backgroundManager);

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'task', description: 'task', timeout: 30 },
      controller.signal,
    );
    completion.resolve({ result: 'all done', usage: {} });
    await vi.advanceTimersByTimeAsync(1);
    const output = await execPromise;

    expect(output.isError).toBeUndefined();
    expect(output.output).toContain('status: completed');
    expect(output.output).toContain('[summary]');
    expect(output.output).toContain('all done');
    expect(backgroundManager.registerAgentTask).not.toHaveBeenCalled();
  });

  it('still aborts on user cancellation and reports the deliberate interruption', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const backgroundManager = { registerAgentTask: vi.fn() };
    const tool = makeTool(makeHost(handle), backgroundManager);

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'task', description: 'task', timeout: 30 },
      controller.signal,
    );
    controller.abort(new UserCancellationError());
    completion.reject(new Error('Aborted'));
    const output = await execPromise;

    expect(output.isError).toBe(true);
    expect(output.output).toContain('user manually interrupted');
    expect(backgroundManager.registerAgentTask).not.toHaveBeenCalled();
  });

  it('keeps awaiting completion directly when background dispatch is unavailable', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const tool = makeTool(makeHost(handle), undefined);

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'task', description: 'task', timeout: 30 },
      controller.signal,
    );
    completion.resolve({ result: 'finished', usage: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    const output = await execPromise;

    expect(output.output).toContain('status: completed');
    expect(output.output).toContain('finished');
  });

  it('detaches the child from the parent signal after a background handoff', async () => {
    vi.useFakeTimers();
    let childSignal: AbortSignal | undefined;
    const completion = deferred<{ result: string; usage: unknown }>();
    const host = {
      spawn: vi.fn((_profileName: string, options: { signal: AbortSignal }) => {
        childSignal = options.signal;
        childSignal.addEventListener(
          'abort',
          () => completion.reject(new Error('child aborted')),
          { once: true },
        );
        return Promise.resolve({
          agentId: 'agent-0',
          profileName: 'coder',
          completion: completion.promise,
        });
      }),
      resume: vi.fn(),
      getProfileName: vi.fn(() => 'coder'),
      backgroundTaskTimeoutMs: 600_000,
    };
    let abortCallback: (() => void) | undefined;
    const registerAgentTask = vi.fn(
      (_p: Promise<unknown>, _d: string, opts: { abort?: () => void }) => {
        abortCallback = opts.abort;
        return 'task-42';
      },
    );
    const markBackground = vi.fn();
    const tool = makeTool({ ...host, markBackground }, { registerAgentTask });

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'long task', description: 'long task', timeout: 30 },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const output = await execPromise;
    expect(output.output).toContain('status: backgrounded');
    expect(childSignal?.aborted).toBe(false);

    // The handoff flips the child's lifecycle flag so parent-turn
    // cancellation (cancelAll) no longer cascades into it.
    expect(markBackground).toHaveBeenCalledWith('agent-0');

    // After the handoff the parent signal no longer controls the child:
    // aborting the parent must NOT kill the backgrounded subagent.
    controller.abort(new UserCancellationError());
    expect(childSignal?.aborted).toBe(false);

    // Only an explicit stop of the background task (the registerAgentTask
    // abort callback) terminates it now.
    expect(abortCallback).toBeTypeOf('function');
    abortCallback?.();
    expect(childSignal?.aborted).toBe(true);
    await expect(completion.promise).rejects.toThrow('child aborted');
  });

  it('reports a backgrounded warning + resume hint when the handoff registration fails', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const backgroundManager = {
      registerAgentTask: vi.fn(() => {
        throw new Error('no slot');
      }),
    };
    const tool = makeTool(makeHost(handle), backgroundManager);

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'long task', description: 'long task', timeout: 30 },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const output = await execPromise;

    expect(output.isError).toBeUndefined();
    expect(output.output).toContain('status: backgrounded');
    expect(output.output).toContain('warning:');
    expect(output.output).toContain('no slot');
    expect(output.output).toContain('resume_hint');
    expect(controller.signal.aborted).toBe(false);
  });
});
