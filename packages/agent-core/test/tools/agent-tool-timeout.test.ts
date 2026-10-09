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

function makeHost(
  handle: {
    agentId: string;
    profileName: string;
    completion: Promise<{ result: string; usage: unknown }>;
  },
  childRequestArrival: Promise<void> = new Promise<void>(() => {}),
) {
  return {
    spawn: vi.fn(async () => handle),
    resume: vi.fn(),
    getProfileName: vi.fn(() => 'coder'),
    backgroundTaskTimeoutMs: 600_000,
    waitForChildRequest: vi.fn(() => childRequestArrival),
    releaseChildRequestWait: vi.fn(),
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
      waitForChildRequest: vi.fn(() => new Promise<void>(() => {})),
      releaseChildRequestWait: vi.fn(),
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

describe('AgentTool foreground request arrival → background handoff', () => {
  it('hands the child to the background manager when it submits a request, with no timeout set', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const requestArrival = deferred<void>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const registerAgentTask = vi.fn(() => 'task-7');
    const host = makeHost(handle, requestArrival.promise);
    const tool = makeTool(host, { registerAgentTask });

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'task', description: 'needs input' },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    // The wait registered its wake-up and is parked: the child is still running
    // and no timeout was given, so nothing but the request can end it early.
    expect(host.waitForChildRequest).toHaveBeenCalledWith('agent-0');
    expect(registerAgentTask).not.toHaveBeenCalled();

    requestArrival.resolve();
    await vi.advanceTimersByTimeAsync(1);
    let settled = false;
    void execPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    // The request ends the wait promptly; without the request leg the call is
    // still parked on the child's completion here.
    expect(settled).toBe(true);

    const output = await execPromise;

    expect(output.isError).toBeUndefined();
    expect(output.output).toContain('status: backgrounded');
    expect(output.output).toContain('task_id: task-7');
    expect(output.output).not.toContain('status: completed');
    // The request path tells the parent how to answer the still-running child.
    expect(output.output).toContain('SendSubagentMessage');
    expect(output.output).toContain('interject');
    expect(output.output).toContain('TaskOutput(task_id="task-7", block=true)');
    expect(registerAgentTask).toHaveBeenCalledWith(
      completion.promise,
      'needs input',
      expect.objectContaining({ agentId: 'agent-0', subagentType: 'coder' }),
    );
    // The request is not an abort.
    expect(controller.signal.aborted).toBe(false);
    // The one-shot registration is released when the wait ends.
    expect(host.releaseChildRequestWait).toHaveBeenCalledWith('agent-0');
  });

  it('does not background a child that was cancelled while parked in a request', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const requestArrival = deferred<void>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const registerAgentTask = vi.fn(() => 'task-7');
    const markBackground = vi.fn();
    const host = { ...makeHost(handle, requestArrival.promise), markBackground };
    const tool = makeTool(host, { registerAgentTask });

    const controller = new AbortController();
    const execPromise = execute(
      tool,
      { prompt: 'task', description: 'needs input' },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    // The user cancels the parent turn while the child is parked inside
    // ContactParent: the cancellation reaches the child controller through
    // `linkAbortSignal`, but ContactParent does not observe the signal — so the
    // request still arrives and wakes the wait.
    controller.abort(new UserCancellationError());
    requestArrival.resolve();
    await vi.advanceTimersByTimeAsync(1);

    // The cancelled child is NOT handed to the background manager: a
    // backgrounded cancelled run settles as a `failed` task whose notification
    // advertises Agent(resume=...), the opposite of the "user cancellation
    // never suggests resume" contract.
    expect(registerAgentTask).not.toHaveBeenCalled();
    expect(markBackground).not.toHaveBeenCalled();
    const settled = { value: false };
    void execPromise.then(() => {
      settled.value = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    // The wait fell back to the completion leg: still parked until the child's
    // own run settles (it too is being cancelled).
    expect(settled.value).toBe(false);

    completion.reject(new Error('aborted by the user'));
    const output = await execPromise;

    expect(output.isError).toBe(true);
    expect(output.output).toContain('user manually interrupted');
    expect(output.output).not.toContain('backgrounded');
    expect(output.output).not.toContain('resume_hint');
    // The one-shot registration is released when the wait ends.
    expect(host.releaseChildRequestWait).toHaveBeenCalledWith('agent-0');
  });

  it('keeps the completed result when the child finishes together with a request', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const requestArrival = deferred<void>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const registerAgentTask = vi.fn(() => 'task-7');
    const host = makeHost(handle, requestArrival.promise);
    const tool = makeTool(host, { registerAgentTask });

    const execPromise = execute(
      tool,
      { prompt: 'task', description: 'task' },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    // Same dispatch, completion attached first: the accepted trade-off is that
    // a finished child is never backgrounded.
    completion.resolve({ result: 'all done', usage: {} });
    requestArrival.resolve();
    const output = await execPromise;

    expect(output.isError).toBeUndefined();
    expect(output.output).toContain('status: completed');
    expect(output.output).toContain('all done');
    expect(output.output).not.toContain('backgrounded');
    expect(registerAgentTask).not.toHaveBeenCalled();
    expect(host.releaseChildRequestWait).toHaveBeenCalledWith('agent-0');
  });

  it('keeps waiting for completion when background dispatch is unavailable', async () => {
    vi.useFakeTimers();
    const completion = deferred<{ result: string; usage: unknown }>();
    const requestArrival = deferred<void>();
    const handle = { agentId: 'agent-0', profileName: 'coder', completion: completion.promise };
    const host = makeHost(handle, requestArrival.promise);
    // No background manager → no handoff target, so the wait stays unchanged.
    const tool = makeTool(host, undefined);

    const execPromise = execute(
      tool,
      { prompt: 'task', description: 'task' },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    requestArrival.resolve();
    let settled = false;
    void execPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    // The request cannot move the child anywhere: the tool is still awaiting
    // completion, and no wake-up was ever registered.
    expect(settled).toBe(false);
    expect(host.waitForChildRequest).not.toHaveBeenCalled();

    completion.resolve({ result: 'finished', usage: {} });
    const output = await execPromise;
    expect(output.output).toContain('status: completed');
    expect(output.output).toContain('finished');
  });
});
