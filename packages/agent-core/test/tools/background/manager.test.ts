/**
 * Covers: BackgroundProcessManager.
 *
 * Uses JianProcess fakes — the manager accepts JianProcess directly,
 * with no ChildProcess dependency.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { JianProcess } from '@scream-code/jian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager';

/**
 * Creates a JianProcess that completes immediately with the given exit code.
 * stdout emits `stdoutText` if provided.
 */
function immediateProcess(exitCode: number, stdoutText = ''): JianProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 10000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as JianProcess['wait'],
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as JianProcess['kill'],
  };
}

/**
 * Creates a JianProcess that stays running until `kill()` is called.
 * Calling `kill()` resolves `wait()` with `exitOnKill`.
 */
function pendingProcess(exitOnKill = 143): {
  proc: JianProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode === null) {
      currentExitCode = exitOnKill;
      resolveWait(exitOnKill);
    }
  });
  const proc: JianProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as JianProcess['kill'],
  };
  return { proc, killSpy };
}

function manuallyResolvedProcess(): {
  proc: JianProcess;
  killSpy: ReturnType<typeof vi.fn>;
  resolve: (exitCode: number) => void;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn().mockResolvedValue(undefined);
  const proc: JianProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54324,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as JianProcess['kill'],
  };
  return {
    proc,
    killSpy,
    resolve: (exitCode) => {
      if (currentExitCode !== null) return;
      currentExitCode = exitCode;
      resolveWait(exitCode);
    },
  };
}

/**
 * Creates a JianProcess with a live stdout stream, so chunks can be injected
 * at any point in the lifecycle — including after `resolve()` has exited the
 * process, which is how a real shell's stdio drain outlives `'exit'`.
 */
function controllableProcess(): {
  proc: JianProcess;
  stdout: PassThrough;
  resolve: (exitCode: number) => void;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const stdout = new PassThrough();
  const killSpy = vi.fn().mockResolvedValue(undefined);
  const proc: JianProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr: new PassThrough(),
    pid: 54325,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as JianProcess['kill'],
  };
  return {
    proc,
    stdout,
    resolve: (exitCode) => {
      if (currentExitCode !== null) return;
      currentExitCode = exitCode;
      resolveWait(exitCode);
    },
  };
}

function waiterCount(manager: BackgroundProcessManager, taskId: string): number {
  const processes = (
    manager as unknown as {
      processes: Map<string, { waiters: Array<() => void> }>;
    }
  ).processes;
  return processes.get(taskId)?.waiters.length ?? 0;
}

function processExitingAfterSigkill(
  exitOnKill = 137,
  delayMs = 25,
): {
  proc: JianProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async (signal?: NodeJS.Signals) => {
    if (signal !== 'SIGKILL' || currentExitCode !== null) return;
    setTimeout(() => {
      currentExitCode = exitOnKill;
      resolveWait(exitOnKill);
    }, delayMs);
  });
  const proc: JianProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54323,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as JianProcess['kill'],
  };
  return { proc, killSpy };
}

function processWithVisibleExitCodeBeforeWait(exitCode = 143): {
  proc: JianProcess;
  markExited: () => void;
} {
  let currentExitCode: number | null = null;
  const proc: JianProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54322,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => new Promise<number>(() => {}),
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as JianProcess['kill'],
  };
  return {
    proc,
    markExited: () => {
      currentExitCode = exitCode;
    },
  };
}

describe('BackgroundProcessManager', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
  });

  it('register returns a task ID and tracks the process', () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo hello', 'test echo');
    // Id format is `{bash|agent}-{8 base36}`.
    expect(taskId).toMatch(/^bash-[0-9a-z]{8}$/);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.command).toBe('echo hello');
    expect(info!.description).toBe('test echo');
    expect(info!.pid).toBe(proc.pid);
  });

  it('records failed runtime when proc.wait() rejects', async () => {
    // Simulate a Jian launch that resolves into a JianProcess whose
    // subsequent wait() rejects (e.g. shell fork failure mid-exec).
    const proc: JianProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 99999,
      exitCode: null,
      wait: vi.fn().mockRejectedValue(new Error('launch failed')) as JianProcess['wait'],
      // oxlint-disable-next-line unicorn/no-useless-undefined
      kill: vi.fn().mockResolvedValue(undefined) as JianProcess['kill'],
    };
    const taskId = manager.register(proc, '/bogus/cmd', 'broken launch');

    // Let the wait() rejection propagate through the .finally block.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('failed');
    expect(info!.endedAt).not.toBeNull();
  });

  it('registerAgentTask registers as running with agent- id prefix', () => {
    // Promise that never resolves — we only inspect the initial register
    // snapshot here.
    const taskId = manager.registerAgentTask(new Promise(() => {}), 'agent task');
    expect(taskId).toMatch(/^agent-[0-9a-z]{8}$/);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.status).toBe('running');
    // Agent tasks use pid=0 (dummy JianProcess).
    expect(info!.pid).toBe(0);
    // Spec marker: command includes the `[agent]` tag so LLM renderers
    // can distinguish bash vs agent entries when scrolling tasks.
    expect(info!.command).toContain('[agent]');
  });

  it('getTask on an unknown id does not touch disk or create state', () => {
    // Live + ghost maps stay untouched; no partial creation.
    const before = manager.list(false).length;
    expect(manager.getTask('bash-deadbeef')).toBeUndefined();
    const after = manager.list(false).length;
    expect(after).toBe(before);
  });

  it('list returns active tasks by default', () => {
    const { proc: proc1 } = pendingProcess();
    const { proc: proc2 } = pendingProcess();
    manager.register(proc1, 'sleep 60', 'task 1');
    manager.register(proc2, 'sleep 60', 'task 2');
    const active = manager.list(true);
    expect(active.length).toBe(2);
  });

  it('rejects new bash tasks when maxRunningTasks is reached', () => {
    const limited = new BackgroundProcessManager({ maxRunningTasks: 1 });
    const { proc: first } = pendingProcess();
    const { proc: second } = pendingProcess();

    limited.register(first, 'sleep 60', 'first task');

    expect(() => {
      limited.register(second, 'sleep 60', 'second task');
    }).toThrow('Too many background tasks are already running.');
  });

  it('rejects new agent tasks when maxRunningTasks is reached', () => {
    const limited = new BackgroundProcessManager({ maxRunningTasks: 1 });

    limited.registerAgentTask(new Promise(() => {}), 'first agent');

    expect(() => {
      limited.registerAgentTask(new Promise(() => {}), 'second agent');
    }).toThrow('Too many background tasks are already running.');
  });

  it('getOutput returns captured stdout', async () => {
    const proc = immediateProcess(0, 'captured output\n');
    const taskId = manager.register(proc, 'echo captured output', 'capture test');

    // Allow the wait() promise and stream data events to settle.
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const output = manager.getOutput(taskId);
    expect(output).toContain('captured output');
  });

  it('task status transitions to completed on exit code 0', async () => {
    const proc = immediateProcess(0, 'done');
    const taskId = manager.register(proc, 'echo done', 'completion test');

    // Allow the wait() promise to settle.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('completed');
    expect(info!.exitCode).toBe(0);
  });

  it('task status transitions to failed on non-zero exit', async () => {
    const proc = immediateProcess(42);
    const taskId = manager.register(proc, 'exit 42', 'fail test');

    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('failed');
    expect(info!.exitCode).toBe(42);
  });

  it('does not finalize task status from a visible process exit code before wait settles', () => {
    const { proc, markExited } = processWithVisibleExitCodeBeforeWait(143);
    const taskId = manager.register(proc, 'sleep 60', 'external kill test');

    markExited();

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('running');
    expect(info!.exitCode).toBeNull();
    expect(info!.endedAt).toBeNull();
  });

  it('does not resolve wait from a visible process exit code before wait settles', async () => {
    const { proc, markExited } = processWithVisibleExitCodeBeforeWait(143);
    const taskId = manager.register(proc, 'sleep 60', 'external kill wait test');

    markExited();

    const info = await manager.wait(taskId, 1);
    expect(info!.status).toBe('running');
    expect(info!.exitCode).toBeNull();
  });

  it('stop kills a running task via JianProcess.kill()', async () => {
    const { proc, killSpy } = pendingProcess(143);
    const taskId = manager.register(proc, 'sleep 60', 'kill test');

    const result = await manager.stop(taskId);
    expect(result).toBeDefined();
    expect(result!.status).toBe('killed');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop normalizes a blank reason instead of recording an empty stopReason', async () => {
    const { proc, resolve } = manuallyResolvedProcess();
    const taskId = manager.register(proc, 'sleep 60', 'blank reason test');

    const stopPromise = manager.stop(taskId, '   ');
    resolve(0);
    const result = await stopPromise;

    // A whitespace-only reason must not be persisted as a blank stopReason.
    // Public callers (SDK/RPC) reach manager.stop() directly, bypassing the
    // TaskStop tool's own normalization, so the boundary must guard it.
    expect(result!.stopReason).toBeUndefined();
  });

  it('stop keeps graceful process shutdown classified as killed', async () => {
    const { proc, killSpy, resolve } = manuallyResolvedProcess();
    const taskId = manager.register(proc, 'sleep 60', 'process race test');

    const stopPromise = manager.stop(taskId, 'user requested');
    resolve(0);
    const result = await stopPromise;

    expect(result!.status).toBe('killed');
    expect(result!.stopReason).toBe('user requested');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('persists graceful process shutdown as killed when stop requested', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'scream-bg-stop-race-'));
    try {
      const writer = new BackgroundProcessManager();
      writer.attachSessionDir(sessionDir);
      const { proc, resolve } = manuallyResolvedProcess();
      const taskId = writer.register(proc, 'sleep 60', 'persisted process race test');

      const stopPromise = writer.stop(taskId, 'user requested');
      resolve(0);
      await stopPromise;

      const reader = new BackgroundProcessManager();
      reader.attachSessionDir(sessionDir);
      await reader.loadFromDisk();

      const persisted = reader.getTask(taskId);
      expect(persisted?.status).toBe('killed');
      expect(persisted?.exitCode).toBe(0);
      expect(persisted?.stopReason).toBe('user requested');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('stop preserves agent task completion that settles during the grace window', async () => {
    let resolveCompletion!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const abort = vi.fn();
    const taskId = manager.registerAgentTask(completion, 'agent race test', { abort });

    const stopPromise = manager.stop(taskId, 'user requested');
    resolveCompletion({ result: 'finished naturally' });
    const result = await stopPromise;

    expect(result!.status).toBe('completed');
    expect(result!.stopReason).toBeUndefined();
    expect(manager.getOutput(taskId)).toContain('finished naturally');
    expect(abort).toHaveBeenCalled();
  });

  it('stop preserves agent task failure when a non-abort rejection wins', async () => {
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const abort = vi.fn();
    const taskId = manager.registerAgentTask(completion, 'agent failure race test', { abort });

    const stopPromise = manager.stop(taskId, 'user requested');
    rejectCompletion(new Error('model failed'));
    const result = await stopPromise;

    expect(result!.status).toBe('failed');
    expect(result!.stopReason).toBeUndefined();
    expect(abort).toHaveBeenCalled();
  });

  it('stop marks agent task killed when abort rejection wins', async () => {
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const abort = vi.fn(() => {
      rejectCompletion(abortError);
    });
    const taskId = manager.registerAgentTask(completion, 'agent abort test', { abort });

    const result = await manager.stop(taskId, 'user requested');

    expect(result!.status).toBe('killed');
    expect(result!.stopReason).toBe('user requested');
    expect(abort).toHaveBeenCalled();
  });

  it('stop finalizes a never-settling agent task after the grace window', async () => {
    vi.useFakeTimers();
    try {
      const local = new BackgroundProcessManager();
      const abort = vi.fn();
      const taskId = local.registerAgentTask(new Promise(() => {}), 'hung agent task', { abort });
      const terminalPromise = local.waitForTerminal(taskId);

      const stopPromise = local.stop(taskId, 'user requested');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      const [stopped, terminal] = await Promise.all([stopPromise, terminalPromise]);

      expect(stopped?.status).toBe('killed');
      expect(stopped?.stopReason).toBe('user requested');
      expect(terminal?.status).toBe('killed');
      expect(abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates endedAt when a killed task finally exits after SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const local = new BackgroundProcessManager();
      const terminated: string[] = [];
      local.onLifecycle((event, info) => {
        if (event === 'terminated') terminated.push(info.status);
      });
      const { proc, killSpy } = processExitingAfterSigkill(137, 25);
      const taskId = local.register(proc, 'sleep 60', 'forced kill test');

      const stopPromise = local.stop(taskId);
      await vi.advanceTimersByTimeAsync(5_000);
      const stopped = await stopPromise;
      const stopEndedAt = stopped!.endedAt;

      expect(stopped!.status).toBe('killed');
      expect(killSpy).toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(25);

      const info = local.getTask(taskId);
      expect(info!.exitCode).toBe(137);
      expect(info!.endedAt).toBeGreaterThan(stopEndedAt!);
      expect(terminated).toEqual(['killed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wait resolves when task completes', async () => {
    const proc = immediateProcess(0, 'fast');
    const taskId = manager.register(proc, 'echo fast', 'wait test');

    const info = await manager.wait(taskId, 5000);
    expect(info).toBeDefined();
    expect(info!.status).toBe('completed');
  });

  it('wait removes its waiter when the timeout branch wins', async () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'timeout cleanup test');

    const info = await manager.wait(taskId, 0);

    expect(info).toBeDefined();
    expect(info!.status).toBe('running');
    expect(waiterCount(manager, taskId)).toBe(0);
  });

  it('getTask returns undefined for unknown ID', () => {
    expect(manager.getTask('bash-nonexist')).toBeUndefined();
  });

  it('getOutput returns empty string for unknown ID', () => {
    expect(manager.getOutput('bash-nonexist')).toBe('');
  });

  it('stop returns terminal info for already-exited task', async () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo done', 'already done');

    // Let wait() settle first.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const result = await manager.stop(taskId);
    expect(result).toBeDefined();
    expect(result!.status).toBe('completed');
  });
});

// ── py-aligned coverage for bash + agent registration semantics ────────

describe('BackgroundProcessManager — registration semantics', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
  });

  // The freshly-registered bash task should be immediately observable
  // in `starting` (or `running`) with the worker pid wired in. Py
  // distinguishes `starting` vs `running`; TS collapses to `running`
  // and exposes that pre-output.
  it('a newly-registered bash task is immediately visible with a starting/running state and worker pid', () => {
    const proc = pendingProcess().proc;
    const taskId = manager.register(proc, 'sleep 1', 'short sleep');
    expect(taskId.startsWith('bash-')).toBe(true);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    // Py: 'starting' state visible. TS: starting status is collapsed
    // into 'running' here — the assertion lives at the py level.
    expect((info!.status as string) === 'starting' || info!.status === 'running').toBe(true);
    expect(info!.pid).toBe(proc.pid);
  });

  // Race-safety invariant: if the worker writes a terminal state
  // (completed) DURING register's startup transition, the registrar
  // must NOT clobber it back to `starting`/`running`.
  it('register does not overwrite a worker-written terminal completion', async () => {
    const proc = immediateProcess(0, 'done\n');
    const taskId = manager.register(proc, 'echo done', 'instant completion');
    // Let the immediate-exit `wait()` settle.
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const info = manager.getTask(taskId);
    expect(info!.status).toBe('completed');
    expect(info!.exitCode).toBe(0);
  });

  // Worker launch raises → manager re-raises, AND persists a `failed`
  // runtime record so the orphan never leaks as a zombie `running`.
  it('records a failed runtime when the worker launch raises', async () => {
    const proc: JianProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 99999,
      exitCode: null,
      wait: vi.fn().mockRejectedValue(new Error('launch boom')) as JianProcess['wait'],
      // oxlint-disable-next-line unicorn/no-useless-undefined
      kill: vi.fn().mockResolvedValue(undefined) as JianProcess['kill'],
    };
    const taskId = manager.register(proc, '/bogus', 'broken launch');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const info = manager.getTask(taskId);
    expect(info!.status).toBe('failed');
    expect(info!.endedAt).not.toBeNull();
  });

  // Agent task registration places kind_payload-style info on the task
  // info (agent_id / subagent_type carried through), status visible.
  it('agent task registration exposes agent metadata on the task info', () => {
    const taskId = manager.registerAgentTask(new Promise(() => {}), 'investigate bug');
    expect(taskId.startsWith('agent-')).toBe(true);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    // Py: `kind_payload.agent_id / subagent_type`. TS exposes neither
    // today — assertion lives at the py spec level.
    const extended = info as unknown as {
      readonly agentId?: string;
      readonly subagentType?: string;
      readonly kindPayload?: { agent_id?: string; subagent_type?: string };
    };
    const agentId = extended.agentId ?? extended.kindPayload?.agent_id;
    const subagentType = extended.subagentType ?? extended.kindPayload?.subagent_type;
    expect(agentId).toBeDefined();
    expect(subagentType).toBeDefined();
  });

  // Lookup for an unknown task id must return undefined AND must NOT
  // create any task directory on disk.
  it('getTask on an unknown id never creates on-disk state', async () => {
    const sessionDir = await import('node:fs/promises').then((m) =>
      m.mkdtemp(join(tmpdir(), 'scream-bg-mgr-missing-')),
    );
    try {
      const m2 = new BackgroundProcessManager();
      m2.attachSessionDir(sessionDir);
      expect(m2.getTask('bash-bogusss0')).toBeUndefined();
      const { readdir } = await import('node:fs/promises');
      // The tasks/ dir may not exist at all — the lookup must not have
      // touched it.
      const top = await readdir(sessionDir);
      expect(top.includes('tasks')).toBe(false);
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  // Terminal-notification dedupe behavior: a subscriber that maintains
  // its own seen-set should observe each task exactly once. Python
  // expressed this via a `publish_terminal_notifications(limit=N)`
  // entry point that skipped tasks whose dedupe_key was already
  // recorded; TS pushes the dedupe responsibility to the consumer (the
  // `BackgroundManager` subclass in `agent/background/index.ts` uses
  // `scheduledNotificationKeys` for the same effect). The behavior we
  // care about is "duplicate terminal events are filterable by the
  // consumer"; the entry-point method itself is not part of the TS BPM
  // surface.
  it('terminal-notification dedupe via onTerminal subscriber yields each task once', async () => {
    const seen = new Set<string>();
    const published: string[] = [];
    manager.onTerminal((info) => {
      if (seen.has(info.taskId)) return;
      seen.add(info.taskId);
      published.push(info.taskId);
    });

    const taskId = manager.register(immediateProcess(0), 'echo a', 'a');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    // A second subscriber observing the same terminal event must not
    // cause the first subscriber's published list to grow.
    manager.onTerminal(() => {
      /* no-op */
    });
    expect(published).toEqual([taskId]);
  });

  // E2E: launch a real child process and wait for it to land in
  // `completed` with the output captured.
  it('launches a real worker and waits to completion', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('bg-ok\\n')"],
      { stdio: 'pipe' },
    );
    const proc: JianProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid ?? 0,
      get exitCode(): number | null {
        return child.exitCode;
      },
      wait: () =>
        new Promise<number>((resolve) => {
          child.on('exit', (code) => {
            resolve(code ?? 0);
          });
        }),
      kill: vi.fn(async (sig?: NodeJS.Signals) => {
        child.kill(sig ?? 'SIGTERM');
      }) as unknown as JianProcess['kill'],
    };
    const taskId = manager.register(proc, 'node -e <stdout bg-ok>', 'real worker smoke');
    const info = await manager.wait(taskId, 10_000);
    expect(info!.status).toBe('completed');
    expect(info!.exitCode).toBe(0);
    expect(manager.getOutput(taskId)).toContain('bg-ok');
  }, 15_000);

  // Calling stop(taskId) on a running bg agent transitions runtime to
  // `killed` with stopReason carried from the caller; failure_reason
  // not overwritten by the late agent_runner CancelledError handler.
  it('stop on a running agent transitions to killed with caller-supplied reason', async () => {
    // Wire abort → reject completion so stop() doesn't have to ride
    // the 5s SIGTERM grace period. The rejection must carry
    // `name: 'AbortError'` so the lifecycle catch handler can
    // distinguish it from an unrelated model failure that happens to
    // race against the stop (the "non-abort rejection wins" case is
    // covered separately and must remain `failed`).
    let rejectCompletion!: (err: unknown) => void;
    const completion = new Promise<{ result: string }>((_res, rej) => {
      rejectCompletion = rej;
    });
    const taskId = manager.registerAgentTask(completion, 'killable', {
      abort: () => {
        const abortError = new Error('cancelled');
        abortError.name = 'AbortError';
        rejectCompletion(abortError);
      },
    });
    const stopped = await manager.stop(taskId, 'test kill');
    expect(stopped?.status).toBe('killed');
    expect(stopped?.stopReason).toBe('test kill');
  });

  // kill() on an already-completed task is a no-op: returns the current
  // view unchanged; failure_reason stays null; subagent record stays
  // `idle` (the completion side already cleaned up).
  it('stop on an already-completed task is a no-op', async () => {
    const proc = immediateProcess(0, 'done');
    const taskId = manager.register(proc, 'echo done', 'quick');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(manager.getTask(taskId)?.status).toBe('completed');

    const after = await manager.stop(taskId, 'too late');
    expect(after?.status).toBe('completed');
    // No stopReason should be recorded on a noop stop.
    expect(after?.stopReason).toBeUndefined();
  });
});

describe('BackgroundProcessManager — terminal eviction', () => {
  let sessionDir: string;
  let manager: BackgroundProcessManager;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-evict-'));
    manager = new BackgroundProcessManager();
    manager.attachSessionDir(sessionDir);
  });

  afterEach(() => {
    manager._reset();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('evicts 50 terminal tasks from processes and bounds the retired ring', async () => {
    for (let i = 0; i < 50; i++) {
      const body = `terminal-output-${i}`;
      const taskId = manager.register(immediateProcess(0, `${body}\n`), 'echo', `task ${i}`);
      await manager.wait(taskId);
      await manager.flushOutput(taskId);
    }

    // Live map is empty: nothing terminal stays in `processes`.
    expect(manager.liveTaskCount).toBe(0);
    // Retired ring is bounded (N=20, FIFO drop-oldest).
    expect(manager.retiredTaskCount).toBeLessThanOrEqual(20);
    expect(manager.retiredTaskCount).toBe(20);

    // Newest retired id is still addressable and its full text is on disk.
    const listed = manager.list(false);
    expect(listed.length).toBeGreaterThanOrEqual(20);
    const newest = listed.find((info) => info.command === 'echo' && info.description === 'task 49');
    expect(newest).toBeDefined();
    const full = await manager.readOutput(newest!.taskId);
    expect(full).toContain('terminal-output-49');
    // Sync getOutput reads the same authoritative disk log for retired ids.
    expect(manager.getOutput(newest!.taskId)).toContain('terminal-output-49');
    // ... and it really is the disk log, not a leftover in-memory copy: the
    // snapshot only reports `fullOutputAvailable` for an existing output.log.
    const snapshot = await manager.getOutputSnapshot(newest!.taskId, 4096);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.outputPath).toContain('output.log');
    expect(snapshot.preview).toContain('terminal-output-49');

    // Oldest of the 50 is gone from the ring (FIFO overflow).
    const oldest = manager.list(false).find((info) => info.description === 'task 0');
    expect(oldest).toBeUndefined();
  });

  it('stopAll only acts on active tasks after eviction', async () => {
    const finished = manager.register(immediateProcess(0, 'done\n'), 'echo', 'finished');
    await manager.wait(finished);
    await manager.flushOutput(finished);

    const { proc } = pendingProcess();
    const running = manager.register(proc, 'sleep', 'still going');

    expect(manager.liveTaskCount).toBe(1);
    const stopped = await manager.stopAll('shutdown');
    expect(stopped.map((info) => info.taskId)).toEqual([running]);
    expect(manager.liveTaskCount).toBe(0);
    // Finished task stays readable via the retired ring, untouched by stopAll.
    expect(manager.getTask(finished)?.status).toBe('completed');
    expect(manager.getOutput(finished)).toContain('done');
  });

  // A3(P2): 'exit' routinely beats the stdio drain, so a chunk can still
  // arrive after finalizeTerminal retired the task. That late chunk extends
  // the on-disk log, and flushOutput / readOutput must wait for its write
  // instead of settling on the queue snapshot taken at retire time.
  it('awaits a post-exit chunk on the retired record until the log is drained', async () => {
    const persistModule = await import('../../../src/tools/background/persist');
    const realAppend = persistModule.appendTaskOutput;
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const appendSpy = vi
      .spyOn(persistModule, 'appendTaskOutput')
      .mockImplementation(async (dir, id, chunk) => {
        if (chunk === 'tail-after-exit\n') await tailGate;
        await realAppend(dir, id, chunk);
      });

    try {
      const { proc, stdout, resolve } = controllableProcess();
      const taskId = manager.register(proc, 'sleep 1', 'post-exit chunk');

      stdout.write('head\n');
      await vi.waitFor(async () => {
        expect(await manager.getOutputSizeBytes(taskId)).toBeGreaterThan(0);
      });

      // The process exits and the task is retired...
      resolve(0);
      await vi.waitFor(() => {
        expect(manager.liveTaskCount).toBe(0);
      });
      expect(manager.getTask(taskId)?.status).toBe('completed');

      // ...but stdio is still draining into the retired record.
      const chunkObserved = new Promise<void>((resolveObserved) => {
        stdout.on('data', () => {
          resolveObserved();
        });
      });
      stdout.write('tail-after-exit\n');
      await chunkObserved;

      // The tail append is still in flight (gated), so flushOutput must not
      // report the task as drained.
      let drained = false;
      const flush = manager.flushOutput(taskId).then(() => {
        drained = true;
      });
      await new Promise((r) => {
        setTimeout(r, 25);
      });
      expect(drained).toBe(false);

      releaseTail();
      await flush;

      // Once drained the tail is on disk, reachable through every read path.
      expect(await manager.readOutput(taskId)).toContain('tail-after-exit');
      expect(manager.getOutput(taskId)).toContain('tail-after-exit');
      const snapshot = await manager.getOutputSnapshot(taskId, 4096);
      expect(snapshot.preview).toContain('tail-after-exit');
    } finally {
      appendSpy.mockRestore();
    }
  });

  // A5(P3): a terminal task is evicted from `processes` into the retired
  // ring, and `waitForTerminal` must resolve it exactly like the `getTask`
  // it documents itself as matching.
  it('waitForTerminal resolves a retired task to its terminal info', async () => {
    const taskId = manager.register(immediateProcess(0, 'done\n'), 'echo done', 'retired wait');

    await vi.waitFor(() => {
      expect(manager.liveTaskCount).toBe(0);
    });

    const terminal = await manager.waitForTerminal(taskId);

    expect(terminal).toEqual(manager.getTask(taskId));
    expect(terminal?.status).toBe('completed');
    expect(terminal?.exitCode).toBe(0);
  });
});

describe('BackgroundProcessManager — retired late-output budget', () => {
  interface RetiredShape {
    readonly outputChunks: string[];
    readonly outputTextBytes: number;
    readonly outputSizeBytes: number;
  }

  interface DeadEntryShape {
    readonly outputChunks: string[];
    readonly outputSizeBytes: number;
  }

  // The leak guarded here is precisely about state no public read path
  // exposes any more (the chunk ring behind an evicted record, the dead
  // entry of a retired task), so the probe reaches into the manager's maps —
  // the same way `waiterCount` above does.
  interface Internals {
    readonly processes: Map<string, DeadEntryShape>;
    readonly retiredTasks: Map<string, RetiredShape>;
  }

  let manager: BackgroundProcessManager;

  beforeEach(() => {
    // Detached (no session dir): every read falls back to the in-memory
    // retained tail, which is the structure under test.
    manager = new BackgroundProcessManager();
  });

  afterEach(() => {
    manager._reset();
  });

  function internalsOf(target: BackgroundProcessManager): Internals {
    return target as unknown as Internals;
  }

  /**
   * Register a task, retire it, and leave its stdout open so chunks written
   * afterwards arrive exactly like a shell's stdio drain outliving `'exit'`.
   */
  async function retireWithOpenStdout(): Promise<{ taskId: string; stdout: PassThrough }> {
    const { proc, stdout, resolve } = controllableProcess();
    const taskId = manager.register(proc, 'sleep 1', 'late stdout');
    stdout.write('head\n');
    resolve(0);
    await vi.waitFor(() => {
      expect(manager.liveTaskCount).toBe(0);
    });
    expect(manager.getTask(taskId)?.status).toBe('completed');
    return { taskId, stdout };
  }

  /**
   * Write `count` copies of `chunk` and resolve once the manager's own data
   * listener has seen the last one (listeners fire in registration order, so
   * the manager has already appended it when ours runs).
   */
  async function flood(stdout: PassThrough, chunk: string, count: number): Promise<void> {
    let delivered = 0;
    let drained: () => void = () => {
      /* replaced below */
    };
    const done = new Promise<void>((resolve) => {
      drained = resolve;
    });
    stdout.on('data', () => {
      delivered += 1;
      if (delivered >= count) drained();
    });
    for (let i = 0; i < count; i++) {
      stdout.write(chunk);
    }
    await done;
  }

  it('caps late post-retirement stdout at the live-ring 1 MiB budget', async () => {
    const { taskId, stdout } = await retireWithOpenStdout();

    const chunk = `${'x'.repeat(4095)}\n`; // 4 KiB per late chunk
    await flood(stdout, chunk, 2048); // 8 MiB delivered after retirement

    const retained = manager.getOutput(taskId);
    const retainedBytes = Buffer.byteLength(retained, 'utf-8');
    // Bounded exactly like the live ring...
    expect(retainedBytes).toBe(1024 * 1024);
    // ...head-trimmed, tail kept: the newest chunk survives.
    expect(retained.endsWith(chunk)).toBe(true);
    // The record still reports every byte it observed, ring-dropped included.
    const retired = internalsOf(manager).retiredTasks.get(taskId);
    expect(retired).toBeDefined();
    expect(retired!.outputTextBytes).toBe(retainedBytes);
    expect(retired!.outputSizeBytes).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('keeps a single oversized late chunk inside the budget by keeping its tail', async () => {
    const { taskId, stdout } = await retireWithOpenStdout();

    const huge = 'y'.repeat(2 * 1024 * 1024); // whole budget exceeded by one write
    await flood(stdout, huge, 1);

    const retained = manager.getOutput(taskId);
    expect(Buffer.byteLength(retained, 'utf-8')).toBe(1024 * 1024);
    expect(retained.endsWith('y'.repeat(1024))).toBe(true);
  });

  it('cuts an oversized multi-byte late chunk on a code point boundary', async () => {
    const { taskId, stdout } = await retireWithOpenStdout();

    const huge = '😀'.repeat(300_000); // 4 bytes / 2 code units per char
    await flood(stdout, huge, 1);

    const retained = manager.getOutput(taskId);
    // Byte budget holds for 4-byte code points too...
    expect(Buffer.byteLength(retained, 'utf-8')).toBeLessThanOrEqual(1024 * 1024);
    // ...and the head cut lands on a boundary: no broken surrogate pair, no
    // replacement character introduced by the trim.
    expect(retained.startsWith('😀')).toBe(true);
    expect(retained).not.toContain('\uFFFD');
  });

  it('drops late chunks once the retired record left the ring (nothing reachable grows)', async () => {
    const { proc, stdout, resolve } = controllableProcess();
    const taskId = manager.register(proc, 'sleep 1', 'evicted late chunk');
    const deadEntry = internalsOf(manager).processes.get(taskId)!;
    stdout.write('head\n');
    resolve(0);
    await vi.waitFor(() => {
      expect(manager.liveTaskCount).toBe(0);
    });
    const evictedRecord = internalsOf(manager).retiredTasks.get(taskId);
    expect(evictedRecord).toBeDefined();

    // Overflow the 20-slot retired ring so this task's record is FIFO-evicted.
    for (let i = 0; i < 21; i++) {
      const filler = manager.register(
        immediateProcess(0, `filler-${i}\n`),
        'echo',
        `filler ${i}`,
      );
      await manager.wait(filler);
      await manager.flushOutput(filler);
    }
    expect(internalsOf(manager).retiredTasks.has(taskId)).toBe(false);
    expect(manager.getTask(taskId)).toBeUndefined();

    const entryChunksBefore = deadEntry.outputChunks.length;
    const entryBytesBefore = deadEntry.outputSizeBytes;
    const retainedBefore = evictedRecord!.outputTextBytes;
    const ringBefore = manager.retiredTaskCount;

    // A chunk drains in after both the live entry and its retired record are
    // gone: it must be dropped, not piled into the dead entry's ring.
    await flood(stdout, 'dead-late-chunk\n', 1);

    expect(manager.retiredTaskCount).toBe(ringBefore);
    expect(manager.getTask(taskId)).toBeUndefined();
    expect(manager.getOutput(taskId)).toBe('');
    expect(evictedRecord!.outputTextBytes).toBe(retainedBefore);
    expect(deadEntry.outputChunks.length).toBe(entryChunksBefore);
    expect(deadEntry.outputSizeBytes).toBe(entryBytesBefore);
  });

  it('appends a late flood in amortized-linear time (no per-chunk whole-tail rebuild)', async () => {
    const { taskId, stdout } = await retireWithOpenStdout();

    const chunk = 'z'.repeat(1024); // 1 KiB per late chunk
    const totalChunks = 16_384; // 16 MiB delivered after retirement

    const startedAt = performance.now();
    await flood(stdout, chunk, totalChunks);
    const elapsedMs = performance.now() - startedAt;

    // The retained tail stays bounded...
    const retired = internalsOf(manager).retiredTasks.get(taskId);
    expect(retired!.outputTextBytes).toBeLessThanOrEqual(1024 * 1024);
    // ...and 16 MiB of late output costs tens of ms here. A per-chunk rebuild
    // of the ≤1 MiB tail copies ≈16 GiB and measures ≈3.5 s, so this bound
    // sits ~10× above the linear cost and ~4× below the quadratic one.
    expect(elapsedMs).toBeLessThan(800);
  }, 20_000);
});

describe('BackgroundProcessManager — tail slices stay ANSI-safe', () => {
  let manager: BackgroundProcessManager;

  beforeEach(() => {
    // Detached (no session dir): the tail comes from the in-memory text.
    manager = new BackgroundProcessManager();
  });

  afterEach(() => {
    manager._reset();
  });

  /**
   * Mirrors the TUI's `sanitizeShellOutput` contract: it strips complete
   * escape sequences only, so any residue left here is rendered to the user
   * as literal text.
   */
  function visibleText(text: string): string {
    return text
      .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
      .replaceAll(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '');
  }

  async function registerSettled(text: string): Promise<string> {
    const taskId = manager.register(immediateProcess(0, text), 'printf', 'ansi tail');
    // The stdout `data` event lands a tick after `register()`; wait until the
    // chunk is actually captured before reading tails.
    await vi.waitFor(() => {
      expect(manager.getOutput(taskId)).toContain(text.slice(-8));
    });
    await manager.wait(taskId);
    await manager.flushOutput(taskId);
    return taskId;
  }

  it('aligns a torn CSI cut to the next line when the cut lands mid-line', async () => {
    const text = `${'x'.repeat(64)}\u001B[31mred first line\nkept second line`;
    const taskId = await registerSettled(text);

    // `tail = 32` puts the cut right after `\u001B[31`: a raw slice(-32)
    // starts inside the SGR opener, so `m` survives the sanitizer as text.
    const output = manager.getOutput(taskId, 32);

    expect(visibleText(output)).toBe('kept second line');
    expect(output).not.toContain('red first line');
  });

  it('keeps a tail that already starts on a line boundary', async () => {
    const taskId = await registerSettled(`first\nsecond\n${'z'.repeat(4)}`);

    // The cut sits exactly on the last line: alignment must not hunt for a
    // following newline (there is none) and drop the whole tail.
    expect(manager.getOutput(taskId, 4)).toBe('zzzz');
  });

  it('drops the torn-sequence remainder when a single line has no newline to align to', async () => {
    const taskId = await registerSettled(`${'x'.repeat(64)}\u001B[31mred`);

    // The cut lands after `\u001B[31`: `red` is visible text and must survive,
    // while the `m` that completes the SGR opener must not.
    expect(manager.getOutput(taskId, 4)).toBe('red');
  });

  it('drops a torn escape-intermediate fragment (`ESC ( B` shape)', async () => {
    const taskId = await registerSettled(`${'x'.repeat(64)}\u001B(Bbody`);

    // `tail = 5` keeps `Bbody`; the dropped prefix ends inside `ESC (`.
    expect(manager.getOutput(taskId, 5)).toBe('body');
  });

  it('never leaves an orphan surrogate half at the head of a tail slice', async () => {
    const taskId = await registerSettled(`${'x'.repeat(63)}😀tail`);

    // `tail = 5` splits the surrogate pair; the low half alone would render as
    // U+FFFD.
    expect(manager.getOutput(taskId, 5)).toBe('tail');
  });

  it('keeps a non-empty tail when the cut splits a trailing surrogate pair', async () => {
    const taskId = await registerSettled(`${'x'.repeat(60)}😀`);

    // `tail = 1` puts the raw cut on the pair's low half; dropping the orphan
    // would land past `text.length` and hand back an empty tail for a
    // non-empty log. Backing onto the pair's first half keeps the character.
    expect(manager.getOutput(taskId, 1)).toBe('😀');
  });

  it('never empties the tail when the open-string clamp lands on a trailing pair', async () => {
    // The unterminated-OSC rule clamps its head to `text.length - 1`, the
    // trailing pair's low half here. The orphan drop used to push the head
    // past `text.length`, so `tailSlice(…, 1)` returned an empty string.
    const taskId = await registerSettled('\u001B]0;😀');

    for (const tail of [1, 2, 3, 4, 5]) {
      const output = manager.getOutput(taskId, tail);
      expect(output.length).toBeGreaterThan(0);
      const first = output.codePointAt(0);
      expect(first !== undefined && first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(output).toBe('😀');
    }
  });

  it('applies the same boundary-safe cut on the disk window path (readOutput)', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'bpm-tail-ansi-'));
    const diskManager = new BackgroundProcessManager();
    diskManager.attachSessionDir(sessionDir);
    try {
      const text = `${'x'.repeat(64)}\u001B[31mred first line\nkept second line`;
      const taskId = diskManager.register(immediateProcess(0, text), 'printf', 'ansi tail on disk');
      await vi.waitFor(() => {
        expect(diskManager.getOutput(taskId)).toContain(text.slice(-8));
      });
      await diskManager.wait(taskId);
      await diskManager.flushOutput(taskId);

      // Same torn cut as the in-memory case, now through the bounded window read.
      expect(await diskManager.readOutput(taskId, 32)).toBe('kept second line');
      // The untailed read still returns the authoritative full log.
      expect(await diskManager.readOutput(taskId)).toContain('red first line');
    } finally {
      diskManager._reset();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps the newest bytes when an OSC sequence never terminates', async () => {
    // A run killed mid-title (or a truncated write) leaves an OSC with no BEL
    // or ST behind it. A terminal swallows the rest of the log there, but the
    // tail must not: the open-string rule used to return `text.length`, so
    // paging a tail (`tasks-browser` reads `tail: 4000`) came back empty.
    const text = `\u001B]0;build 42%${'p'.repeat(120)}TAILEND`;
    const taskId = await registerSettled(text);

    expect(manager.getOutput(taskId, 40)).toBe(text.slice(-40));
  });

  it('skips a torn OSC opener instead of leaking its header into the head', async () => {
    // `tail = 62` puts the cut between the `0` and the `;` of `\u001B]0;`: the
    // head starts on the payload, not on the `0;` fragment left by the opener.
    const text = `\u001B]0;${'A'.repeat(60)}`;
    const taskId = await registerSettled(text);

    expect(manager.getOutput(taskId, 62)).toBe('A'.repeat(60));
  });

  it('resumes normal output after a CAN / SUB aborted string sequence', async () => {
    // CAN (0x18) and SUB (0x1A) abort a string sequence: a terminal drops the
    // payload and keeps parsing after them, so those bytes are real output and
    // must stay in the tail.
    for (const abort of ['\u0018', '\u001A']) {
      const text = `\u001B]0;${'g'.repeat(200)}${abort}AFTER${'v'.repeat(50)}`;
      const taskId = await registerSettled(text);

      // The cut lands a few bytes before the abort: the payload's remainder
      // goes, the output after the abort stays.
      expect(manager.getOutput(taskId, 60)).toBe(`AFTER${'v'.repeat(50)}`);
    }
  });

  it('does not spend more than half the tail aligning to a far-away newline', async () => {
    // Rule 1 restarts after the next `\n`; with a 5000-char line ahead, a
    // 100-unit budget would come back as the 9 units after it. The raw cut
    // keeps the newest output the caller actually asked for.
    const text = `head\n${'L'.repeat(5000)}\ntail-line`;
    const taskId = await registerSettled(text);

    expect(manager.getOutput(taskId, 100)).toBe(text.slice(-100));
  });

  it('does not spend more than half the tail skipping a torn CSI colour run', async () => {
    // The cut lands inside the parameter run of an SGR sequence whose final
    // `m` sits 23 units past it. Skipping to that `m` would keep only the 17
    // units of visible text behind it — 57% of the 40 asked for gone. Past the
    // bound the raw cut keeps the newest bytes, fragment and all.
    const text = `${'x'.repeat(200)}\u001B[38;2;255;0;0;48;2;0;255;0;7;4;1mtail-after-colour`;
    const taskId = await registerSettled(text);

    expect(manager.getOutput(taskId, 40)).toBe(text.slice(-40));
  });

  it('does not spend more than half the tail on a torn 100-unit CSI parameter run', async () => {
    // Same torn cut with a synthetic run: the skip would keep only the 8 units
    // behind the sequence's final byte.
    const text = `${'y'.repeat(200)}\u001B[${'1'.repeat(100)}mabcdefgh`;
    const taskId = await registerSettled(text);

    expect(manager.getOutput(taskId, 59)).toBe(text.slice(-59));
  });

  it('backs onto the introducer ESC when bounding the skip would surface its fragment', async () => {
    // `tail = 7` makes the `[31m` opener worth 57% of the window, so the skip
    // is past the bound — but the ESC byte sits one unit before the head, and
    // keeping it makes the sequence whole, so the sanitizer strips it instead
    // of the fragment rendering as text.
    const text = `${'x'.repeat(64)}\u001B[31mred`;
    const taskId = await registerSettled(text);

    expect(manager.getOutput(taskId, 7)).toBe('\u001B[31mred');
  });

  it('does not back onto the introducer ESC when the torn CSI never closes', async () => {
    // `tail = 101` puts the cut right after the `\u001B[` opener, one unit
    // past the ESC, of a parameter run that reaches the end of the log with no
    // final byte. The look-back would keep the ESC, but the sequence never
    // closes, so the sanitizer cannot strip it: the window would start with a
    // bare ESC and a terminal would swallow the bytes behind it. The raw cut
    // keeps a text-only head (`[3…`) instead.
    const text = `${'x'.repeat(10)}\u001B[${'3'.repeat(100)}`;
    const taskId = await registerSettled(text);

    const output = manager.getOutput(taskId, 101);
    expect(output).toHaveLength(101);
    expect(output).toBe(`[${'3'.repeat(100)}`);
    expect(output.startsWith('\u001B')).toBe(false);
    // Same contract the TUI applies: with no ESC left in front, nothing can be
    // swallowed and the run renders as the literal text it is.
    expect(visibleText(output)).toBe(output);
  });

  it('returns the same tail from the disk window read and the whole-file read', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'bpm-tail-window-'));
    const diskManager = new BackgroundProcessManager();
    diskManager.attachSessionDir(sessionDir);
    try {
      // Three shapes the two reads have to agree on: an unterminated string
      // opener (its payload is all the log has), an aborted one, and a line
      // past the alignment bound. Each case is larger than the read window, so
      // the window read really is a window and not the whole file.
      const cases = [
        {
          text: `\u001B]0;build 42%${'p'.repeat(20_000)}newest-osc-line`,
          marker: 'newest-osc-line',
        },
        {
          text: `\u001B]0;title${'g'.repeat(8_000)}\u0018newest-after-abort`,
          marker: 'newest-after-abort',
        },
        { text: `head\n${'L'.repeat(5_000)}\ntail-line`, marker: 'tail-line' },
      ];
      for (const { text, marker } of cases) {
        const taskId = diskManager.register(immediateProcess(0, text), 'printf', 'window vs whole file');
        await vi.waitFor(() => {
          expect(diskManager.getOutput(taskId)).toContain(text.slice(-8));
        });
        await diskManager.wait(taskId);
        await diskManager.flushOutput(taskId);

        // `readOutput` pages a bounded window off the end of the log;
        // `getOutput` reads the authoritative file whole.
        const window = await diskManager.readOutput(taskId, 100);
        const whole = diskManager.getOutput(taskId, 100);

        // The two reads agree, and the newest bytes survive both of them.
        expect(window).toBe(whole);
        expect(whole).toContain(marker);
      }
    } finally {
      diskManager._reset();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
