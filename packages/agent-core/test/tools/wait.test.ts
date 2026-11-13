/**
 * Covers: WaitTool — blocking wait over the background task registry.
 *
 * Uses JianProcess fakes on a real BackgroundProcessManager (same pattern as
 * test/tools/background/task-tools.test.ts). The ladder-fallback tests use a
 * structural manager stub whose `onLifecycle` drops every event, so only the
 * registry re-checks can observe a settle.
 *
 * Blocking paths under test:
 *   - task_id: unknown id → immediate error; already-terminal → immediate
 *     result; running → settles via the manager's lifecycle event (proven by
 *     resolving before the first ladder tick fires).
 *   - no task_id: zero tasks → immediate; one running → settles; two
 *     running → first-to-finish wins; a task registered mid-wait
 *     participates.
 *   - concurrent waiters: one terminal event fans out to a task-specific
 *     and an any waiter at once — both settle from the same event, each
 *     with its own result, no cross-delivery.
 *   - ladder fallback: with events dropped, the registry re-check resolves
 *     at the right ladder step (fake timers).
 *   - timeout: `status: running`, NOT an error, at the requested budget.
 *   - abort: user and parent-agent attribution; every pending timer cleared.
 */

import { Readable, type Writable } from 'node:stream';

import type { JianProcess } from '@scream-code/jian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundProcessManager,
  isBackgroundTaskTerminal,
  type BackgroundTaskInfo,
} from '../../src/tools/background/manager';
import { WaitInputSchema, WaitTool, type WaitInput } from '../../src/tools/builtin/wait';
import { parentInterjectReason } from '../../src/utils/abort';
import { toolContentString } from './fixtures/fake-jian';
import { executeTool, type TestExecutableToolContext } from './fixtures/execute-tool';

// ── Fakes ────────────────────────────────────────────────────────────

const liveSignal = new AbortController().signal;

function context(
  toolCallId: string,
  args: WaitInput,
  signal: AbortSignal = liveSignal,
): TestExecutableToolContext<WaitInput> {
  return { turnId: '0', toolCallId, args, signal };
}

interface ResolvableProcess extends JianProcess {
  /** Settle the process wait exactly like an OS exit would. */
  exit(exitCode: number): void;
}

function resolvableProcess(stdoutText = ''): ResolvableProcess {
  let resolveWait: (exitCode: number) => void = () => {};
  let currentExitCode: number | null = null;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 42424,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn(async () => {
      proc.exit(143);
    }),
    exit: (code: number) => {
      if (currentExitCode !== null) return;
      currentExitCode = code;
      resolveWait(code);
    },
  };
  return proc as unknown as ResolvableProcess;
}

/**
 * Manager stub implementing exactly the surface WaitTool touches, with the
 * lifecycle subscription dropped: `onLifecycle` accepts the callback and
 * never fires it, so only the ladder poll can observe a settle.
 */
function stubManagerWithoutEvents(
  tasks: Map<string, BackgroundTaskInfo>,
): BackgroundProcessManager {
  return {
    onLifecycle: () => {},
    getTask: (taskId: string) => tasks.get(taskId),
    list: (activeOnly = true) =>
      [...tasks.values()].filter((task) => !activeOnly || !isBackgroundTaskTerminal(task.status)),
    getOutputSnapshot: async (taskId: string) => {
      const info = tasks.get(taskId);
      return {
        outputPath: undefined,
        outputSizeBytes: 0,
        previewBytes: 0,
        truncated: false,
        fullOutputAvailable: false,
        preview: info === undefined ? '' : `stubbed tail for ${taskId}`,
      };
    },
  } as unknown as BackgroundProcessManager;
}

function taskInfo(
  overrides: Partial<BackgroundTaskInfo> & { taskId: string },
): BackgroundTaskInfo {
  return {
    command: 'sleep 60',
    description: 'stub task',
    status: 'running',
    pid: 0,
    exitCode: null,
    startedAt: 0,
    endedAt: null,
    ...overrides,
  };
}

// ── Harness ──────────────────────────────────────────────────────────

describe('WaitTool', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
    vi.useRealTimers();
  });

  // ── construction / schema ────────────────────────────────────────

  it('registers as "Wait" with task_id / timeout_seconds / tail_lines parameters and a blocking description', () => {
    const tool = new WaitTool(manager);
    expect(tool.name).toBe('Wait');
    expect(tool.longRunning).toBe(true);
    expect(tool.description.toLowerCase()).toContain('background');
    expect(tool.description).toContain('TaskOutput');
    const parameters = tool.parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(parameters.properties).toSorted()).toEqual([
      'tail_lines',
      'task_id',
      'timeout_seconds',
    ]);
  });

  it('schema bounds: timeout_seconds ≤ 600, tail_lines ≤ 200, empty input accepted', () => {
    expect(WaitInputSchema.safeParse({}).success).toBe(true);
    expect(WaitInputSchema.safeParse({ timeout_seconds: 600 }).success).toBe(true);
    expect(WaitInputSchema.safeParse({ timeout_seconds: 601 }).success).toBe(false);
    expect(WaitInputSchema.safeParse({ timeout_seconds: 0 }).success).toBe(false);
    expect(WaitInputSchema.safeParse({ tail_lines: 200 }).success).toBe(true);
    expect(WaitInputSchema.safeParse({ tail_lines: 201 }).success).toBe(false);
  });

  // ── task_id ──────────────────────────────────────────────────────

  it('unknown task_id errors immediately without blocking', async () => {
    const tool = new WaitTool(manager);
    const result = await executeTool(tool, context('c_unknown', { task_id: 'bash-unknown0' }));
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('Task bash-unknown0 is not a task of this session.');
  });

  it('already-terminal task returns its status and tail immediately', async () => {
    const proc = resolvableProcess('build line 1\nbuild line 2\nbuild line 3\n');
    const taskId = manager.register(proc, 'make build', 'already done');
    // Let the stdout stream flush before exiting: the manager captures
    // output through 'data' listeners, so a synchronous exit would finalize
    // the task before the chunk lands (same pattern the task tools use).
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    proc.exit(0);
    await manager.wait(taskId, 5_000);

    const tool = new WaitTool(manager);
    const result = await executeTool(tool, context('c_terminal', { task_id: taskId }));
    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain(`task_id: ${taskId}`);
    expect(content).toContain('status: completed');
    expect(content).toContain('exit_code: 0');
    expect(content).toContain('build line 3');
    // Zero remaining tasks → no "other tasks" line.
    expect(content).not.toContain('other task');
    expect((result as unknown as { message?: string }).message).toContain('finished');
  });

  it('tail_lines caps the trailing output lines', async () => {
    const proc = resolvableProcess('l1\nl2\nl3\nl4\nl5\n');
    const taskId = manager.register(proc, 'echo lines', 'tail cap');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    proc.exit(0);
    await manager.wait(taskId, 5_000);

    const tool = new WaitTool(manager);
    const result = await executeTool(
      tool,
      context('c_tail_cap', { task_id: taskId, tail_lines: 2 }),
    );
    const content = toolContentString(result);
    expect(content).toContain('tail (last 2 lines):');
    expect(content).toContain('l4\nl5');
    expect(content).not.toContain('l3');
  });

  it('a task with no output reports "[no output available]" in the tail', async () => {
    const proc = resolvableProcess();
    const taskId = manager.register(proc, 'sleep 5', 'silent task');
    proc.exit(0);
    await manager.wait(taskId, 5_000);

    const tool = new WaitTool(manager);
    const result = await executeTool(tool, context('c_silent', { task_id: taskId }));
    expect(toolContentString(result)).toContain('[no output available]');
  });

  it('a running task settles via the lifecycle event, before the first ladder tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = resolvableProcess('worker out\n');
    const taskId = manager.register(proc, 'run worker', 'event settle');
    const tool = new WaitTool(manager);

    let settled = false;
    const pending = executeTool(tool, context('c_event', { task_id: taskId })).then((result) => {
      settled = true;
      return result;
    });

    // No ladder tick has fired yet (first is at 1000ms); the wait is parked.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);

    proc.exit(0);
    const result = await pending;

    expect(settled).toBe(true);
    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('status: completed');
    expect(content).toContain('worker out');
    // Settled before the ladder ever polled → every tool timer cleared.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed exit surfaces the failed status and exit code', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = resolvableProcess('boom\n');
    const taskId = manager.register(proc, 'fail fast', 'failed settle');
    const tool = new WaitTool(manager);
    const pending = executeTool(tool, context('c_failed', { task_id: taskId }));
    await vi.advanceTimersByTimeAsync(1);
    proc.exit(1);

    const result = await pending;
    const content = toolContentString(result);
    expect(content).toContain('status: failed');
    expect(content).toContain('exit_code: 1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a task stopped via TaskStop settles the wait with status killed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = resolvableProcess();
    const taskId = manager.register(proc, 'sleep 60', 'killed settle');
    const tool = new WaitTool(manager);
    const pending = executeTool(tool, context('c_killed', { task_id: taskId }));
    await vi.advanceTimersByTimeAsync(1);

    // manager.stop records stopRequested → the exit lands as `killed`, the
    // same terminal event the Wait tool subscribes to.
    const stopPromise = manager.stop(taskId, 'stopped by test');
    const result = await pending;

    expect(toolContentString(result)).toContain('status: killed');
    await expect(stopPromise).resolves.toMatchObject({ status: 'killed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── no task_id ───────────────────────────────────────────────────

  it('with no task_id and no tasks, returns immediately without blocking', async () => {
    const tool = new WaitTool(manager);
    const result = await executeTool(tool, context('c_none', {}));
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toBe('No background tasks are running.');
  });

  it('with no task_id, waits for the only running task', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = resolvableProcess('solo out\n');
    manager.register(proc, 'run solo', 'solo task');
    const tool = new WaitTool(manager);
    const pending = executeTool(tool, context('c_solo', {}));
    await vi.advanceTimersByTimeAsync(1);

    proc.exit(0);
    const result = await pending;
    const content = toolContentString(result);
    expect(content).toContain('status: completed');
    expect(content).toContain('solo out');
    expect(content).not.toContain('other task');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with no task_id and two running tasks, the first to finish wins and the other is counted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = resolvableProcess('first out\n');
    const second = resolvableProcess('second out\n');
    const firstId = manager.register(first, 'run first', 'first task');
    manager.register(second, 'run second', 'second task');
    const tool = new WaitTool(manager);

    const pending = executeTool(tool, context('c_two', {}));
    await vi.advanceTimersByTimeAsync(1);

    first.exit(0);
    const result = await pending;
    const content = toolContentString(result);
    expect(content).toContain(`task_id: ${firstId}`);
    expect(content).toContain('first out');
    expect(content).toContain('1 other task still running.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a task registered mid-wait participates and can win the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = resolvableProcess();
    manager.register(first, 'run first', 'first task');
    const tool = new WaitTool(manager);
    const pending = executeTool(tool, context('c_late', {}));
    await vi.advanceTimersByTimeAsync(1);

    // A second task becomes owned while the wait is parked (its 'started'
    // event must not reset or break the wait), then finishes first.
    const late = resolvableProcess('late out\n');
    const lateId = manager.register(late, 'run late', 'late task');
    await vi.advanceTimersByTimeAsync(10_000); // past several ladder ticks
    late.exit(0);

    const result = await pending;
    const content = toolContentString(result);
    expect(content).toContain(`task_id: ${lateId}`);
    expect(content).toContain('late out');
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── concurrent waiters ──────────────────────────────────────────

  it('fans one terminal event out to a task-specific and an any waiter at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const xProc = resolvableProcess('x tail\n');
    const xId = manager.register(xProc, 'run x', 'fan-out x');
    // A second owned task that stays running: it shows up as the remaining
    // count in both results, and its tail must never leak into either.
    const yProc = resolvableProcess('y tail\n');
    manager.register(yProc, 'run y', 'fan-out y');
    // ONE tool instance: the single onLifecycle subscription must fan the
    // event out to every blocked call (A with the task_id filter, B any).
    const tool = new WaitTool(manager);

    const pendingA = executeTool(tool, context('c_fan_a', { task_id: xId }));
    const pendingB = executeTool(tool, context('c_fan_b', {}));
    await vi.advanceTimersByTimeAsync(1); // both parked before the first ladder tick

    xProc.exit(0);
    const [aResult, bResult] = await Promise.all([pendingA, pendingB]);

    const contentA = toolContentString(aResult);
    const contentB = toolContentString(bResult);
    // A waited on X explicitly: X's own status and tail.
    expect(contentA).toContain(`task_id: ${xId}`);
    expect(contentA).toContain('status: completed');
    expect(contentA).toContain('x tail');
    // B (any-waiter) observed the SAME event: with only X terminating, the
    // terminal event of the one owned task legitimately resolves it too —
    // neither waiter consumed the event exclusively and left the other hung.
    expect(contentB).toContain(`task_id: ${xId}`);
    expect(contentB).toContain('status: completed');
    expect(contentB).toContain('x tail');
    // No cross-delivery: neither result carries the other task's tail, and
    // both report the same event's remaining count (Y still running).
    expect(contentA).not.toContain('y tail');
    expect(contentB).not.toContain('y tail');
    expect(contentA).toContain('1 other task still running.');
    expect(contentB).toContain('1 other task still running.');
    // Each waiter received its OWN result object, not a shared/leaked one.
    expect(aResult).not.toBe(bResult);
    expect(vi.getTimerCount()).toBe(0);

    // A delivery after both settled (Y exits) must not error or re-resolve:
    // the already-settled deliver closures are no-ops.
    yProc.exit(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(toolContentString(aResult)).toBe(contentA);
    expect(toolContentString(bResult)).toBe(contentB);
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── ladder fallback (events dropped) ─────────────────────────────

  it('with events dropped, the ladder poll resolves a specific task at the first ladder step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tasks = new Map<string, BackgroundTaskInfo>([
      ['bash-ladder01', taskInfo({ taskId: 'bash-ladder01', status: 'running' })],
    ]);
    const tool = new WaitTool(stubManagerWithoutEvents(tasks));

    let settled = false;
    const pending = executeTool(tool, context('c_ladder', { task_id: 'bash-ladder01' })).then(
      (result) => {
        settled = true;
        return result;
      },
    );

    // Just before the first ladder re-check (1000ms).
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    // The task finishes; nothing fires an event, so only the ladder can see it.
    tasks.set(
      'bash-ladder01',
      taskInfo({ taskId: 'bash-ladder01', status: 'completed', exitCode: 0, endedAt: 1 }),
    );
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(settled).toBe(true);
    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('status: completed');
    expect(content).toContain('stubbed tail for bash-ladder01');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with events dropped, the any-task ladder resolves the tracked task that turned terminal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tasks = new Map<string, BackgroundTaskInfo>([
      ['bash-ladder02', taskInfo({ taskId: 'bash-ladder02', status: 'running' })],
    ]);
    const tool = new WaitTool(stubManagerWithoutEvents(tasks));

    let settled = false;
    const pending = executeTool(tool, context('c_ladder_any', {})).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    tasks.set(
      'bash-ladder02',
      taskInfo({ taskId: 'bash-ladder02', status: 'failed', exitCode: 2, endedAt: 1 }),
    );
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(settled).toBe(true);
    expect(toolContentString(result)).toContain('task_id: bash-ladder02');
    expect(toolContentString(result)).toContain('status: failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── timeout ──────────────────────────────────────────────────────

  it('times out with status running and no error at the requested budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = resolvableProcess();
    const taskId = manager.register(proc, 'sleep 600', 'timeout test');
    const tool = new WaitTool(manager);

    const pending = executeTool(
      tool,
      context('c_timeout', { task_id: taskId, timeout_seconds: 2 }),
    );
    await vi.advanceTimersByTimeAsync(2_100); // fires the 2s budget
    const result = await pending;

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('status: running');
    expect(content).toContain(`task_id: ${taskId}`);
    expect(content).toContain(
      'Wait timed out after 2s; the task is still running. Wait again or check TaskOutput.',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the default budget is 120 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = resolvableProcess();
    manager.register(proc, 'sleep 600', 'default budget');
    const tool = new WaitTool(manager);

    const pending = executeTool(tool, context('c_default_budget', {}));
    await vi.advanceTimersByTimeAsync(120_100); // fires the 120s budget
    const result = await pending;

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain(
      'Wait timed out after 120s; the task is still running. Wait again or check TaskOutput.',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects timeout_seconds above 600 at execution time', async () => {
    const tool = new WaitTool(manager);
    const result = await executeTool(tool, context('c_over_max', { timeout_seconds: 601 }));
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('timeout_seconds cannot exceed 600');
  });

  // ── abort ────────────────────────────────────────────────────────

  it('a user interrupt cancels the wait and clears every pending timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const proc = resolvableProcess();
    manager.register(proc, 'sleep 600', 'abort test');
    const tool = new WaitTool(manager);

    const pending = executeTool(tool, context('c_abort_user', {}, controller.signal));
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // ladder + budget timers pending

    controller.abort();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('Wait interrupted by user.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a parent-agent interject is attributed to the parent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const proc = resolvableProcess();
    manager.register(proc, 'sleep 600', 'abort parent test');
    const tool = new WaitTool(manager);

    const pending = executeTool(tool, context('c_abort_parent', {}, controller.signal));
    await vi.advanceTimersByTimeAsync(1);

    controller.abort(parentInterjectReason());
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('Wait interrupted by the parent agent.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an already-aborted signal never starts the wait', async () => {
    const controller = new AbortController();
    controller.abort();
    const proc = resolvableProcess();
    manager.register(proc, 'sleep 600', 'pre-aborted');
    const tool = new WaitTool(manager);

    const result = await executeTool(tool, context('c_pre_aborted', {}, controller.signal));
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toBe('Aborted before the wait started');
  });
});
