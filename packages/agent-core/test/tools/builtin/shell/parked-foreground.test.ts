/**
 * Foreground commands that outlive their Bash timeout are parked in the
 * background manager of the agent that ran them.
 *
 * The contract under test (batch 2.1):
 *   - the parked task belongs to the caller's manager only: another agent's
 *     Bash call never sees its output, and cannot reach it through its own
 *     TaskList/TaskStop
 *   - parking is open to every agent, Task tools or not — the result is
 *     delivered by the manager's terminal notification, never prepended to
 *     some later Bash call
 *   - the manager keeps recording what the caller read (head at park time,
 *     tail forwarded while it runs) and reuses the caller's kill escalation
 */

import { PassThrough, Readable, type Writable } from 'node:stream';

import type { Environment, Jian, JianProcess } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import type { BackgroundLifecycleEvent } from '../../../../src/tools/background/manager';
import { BackgroundProcessManager } from '../../../../src/tools/background/manager';
import { BashTool, type BashInput } from '../../../../src/tools/builtin/shell/bash';
import { createFakeJian } from '../../fixtures/fake-jian';
import { executeTool } from '../../fixtures/execute-tool';

const posixEnv: Environment = {
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
};

/** A process the test drives by hand: writes output, then exits on command. */
function controllableProcess(): {
  readonly proc: JianProcess;
  readonly writeStdout: (text: string) => void;
  readonly finish: (exitCode: number) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc: JianProcess = {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 4242,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {
      if (currentExitCode !== null) return;
      currentExitCode = 143;
      stdout.end();
      stderr.end();
      resolveWait(143);
    }),
  };
  return {
    proc,
    writeStdout: (text: string) => {
      stdout.write(text);
    },
    finish: (exitCode: number) => {
      if (currentExitCode !== null) return;
      currentExitCode = exitCode;
      stdout.end();
      stderr.end();
      resolveWait(exitCode);
    },
  };
}

function bashToolFor(jian: Jian, manager?: BackgroundProcessManager): BashTool {
  return new BashTool(jian, '/workspace', manager);
}

function context(args: BashInput) {
  return { turnId: '0', toolCallId: 'call_bash', args, signal: new AbortController().signal };
}

describe('parked foreground commands', () => {
  it('parks in the owning agent manager only, and never in another agent output', async () => {
    const managerA = new BackgroundProcessManager();
    const managerB = new BackgroundProcessManager();
    const events: Array<{ event: BackgroundLifecycleEvent; taskId: string; status: string }> = [];
    managerA.onLifecycle((event, info) => {
      events.push({ event, taskId: info.taskId, status: info.status });
    });

    const { proc, writeStdout, finish } = controllableProcess();
    const toolA = bashToolFor(
      createFakeJian({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
      managerA,
    );

    const result = await executeTool(
      toolA,
      context({ command: 'sleep 60', timeout: 0.01, description: 'long build' }),
    );

    expect(result.isError).toBe(false);
    const output = result.output as string;
    expect(output).toContain('Command timed out after 10ms');
    expect(output).toContain('still running in the background (task: bash-');
    expect(output).not.toContain('next Bash call');

    // The task is visible in its owner's ledger — started event included —
    // and nowhere else.
    const parked = managerA.list();
    expect(parked).toHaveLength(1);
    const parkedId = parked[0]!.taskId;
    expect(parked[0]!.status).toBe('running');
    expect(parked[0]!.description).toBe('long build');
    expect(events.some((e) => e.event === 'started' && e.taskId === parkedId)).toBe(true);
    expect(managerB.list()).toEqual([]);
    expect(managerB.getTask(parkedId)).toBeUndefined();

    // Its head is on the ledger: the output the tool already returned.
    writeStdout('tail-line\n');
    finish(0);
    const info = await managerA.waitForTerminal(parkedId);
    expect(info?.status).toBe('completed');
    expect(info?.exitCode).toBe(0);
    const snapshot = await managerA.getOutputSnapshot(parkedId, 4096);
    expect(snapshot.preview).toContain('tail-line');
    expect(events.some((e) => e.event === 'terminated' && e.taskId === parkedId)).toBe(true);

    // A later Bash call on another agent is a clean slate: the parked
    // command's result never leaks into it.
    const toolB = bashToolFor(
      createFakeJian({
        execWithEnv: vi.fn().mockResolvedValue({
          stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          pid: 7,
          exitCode: 0,
          wait: vi.fn(async () => 0),
          kill: vi.fn(async () => {}),
        } satisfies JianProcess),
        osEnv: posixEnv,
      }),
      managerB,
    );
    const otherResult = await executeTool(toolB, context({ command: 'true', timeout: 60 }));
    expect(otherResult.output as string).not.toContain(parkedId);
    expect(otherResult.output as string).not.toContain('[Background task');
  });

  it('parks even when the agent has no Task tools (background gating is separate)', async () => {
    // allowBackground=false only removes `run_in_background` from the tool;
    // a timed-out foreground command is still parked, because the terminal
    // notification — not TaskOutput — is what delivers its result.
    const manager = new BackgroundProcessManager();
    const { proc } = controllableProcess();
    const tool = new BashTool(
      createFakeJian({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
      '/workspace',
      manager,
      { allowBackground: false, availableTools: new Set() },
    );

    const result = await executeTool(tool, context({ command: 'sleep 60', timeout: 0.01 }));

    expect(result.isError).toBe(false);
    expect(result.output as string).toContain('still running in the background (task: bash-');
    expect(result.output as string).not.toContain('TaskOutput');
    expect(manager.list()).toHaveLength(1);
  });

  it('stops a timed-out command when no manager can own it', async () => {
    const { proc } = controllableProcess();
    const tool = bashToolFor(
      createFakeJian({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
    );

    const result = await executeTool(tool, context({ command: 'sleep 60', timeout: 0.01 }));

    expect(result.isError).toBe(true);
    expect(result.output as string).toContain('Command timed out after 10ms and was stopped');
    expect(result.output as string).toContain('no background task manager');
    // Nothing may be left running untracked.
    expect(proc.kill).toHaveBeenCalled();
  });

  it('stops a timed-out command the agent has no capacity to park', async () => {
    const manager = new BackgroundProcessManager({ maxRunningTasks: 1 });
    manager.register(controllableProcess().proc, 'sleep 3600', 'slot blocker');
    const { proc } = controllableProcess();
    const tool = bashToolFor(
      createFakeJian({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
      manager,
    );

    const result = await executeTool(tool, context({ command: 'sleep 60', timeout: 0.01 }));

    expect(result.isError).toBe(true);
    expect(result.output as string).toContain('could not park it as a background task');
    expect(result.output as string).toContain('Too many background tasks are already running.');
    expect(proc.kill).toHaveBeenCalled();
    // The blocker still owns its slot; the refused command added nothing.
    expect(manager.list()).toHaveLength(1);
  });

  it('a TaskStop of the parked task reuses the caller kill escalation', async () => {
    const manager = new BackgroundProcessManager();
    const { proc } = controllableProcess();
    const tool = bashToolFor(
      createFakeJian({ execWithEnv: vi.fn().mockResolvedValue(proc), osEnv: posixEnv }),
      manager,
    );

    await executeTool(tool, context({ command: 'sleep 60', timeout: 0.01 }));
    const parkedId = manager.list()[0]!.taskId;

    const info = await manager.stop(parkedId, 'user stopped it');

    expect(info?.status).toBe('killed');
    expect(info?.stopReason).toBe('user stopped it');
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe('parked foreground commands — exit settlement', () => {
  it('exposes the just-exited parked task to the settle path before its terminal transition', async () => {
    const manager = new BackgroundProcessManager();
    let resolveParked!: (value: { exitCode: number }) => void;
    const completion = new Promise<{ exitCode: number }>((resolve) => {
      resolveParked = resolve;
    });
    const taskId = manager.parkForegroundProcess(completion, 'deploy --prod', 'deploy', {
      kill: async () => {},
      initialOutput: 'building\n',
    });

    resolveParked({ exitCode: 0 });
    // The exit observation lands in its own microtask, one step before the
    // terminal transition — the two-step shape a real process reports (the OS
    // 'exit' event makes `proc.exitCode` non-null, then `wait()` resolves and
    // the lifecycle settles). This window is what the just-exited selector in
    // `settlePendingExits` keys on.
    await Promise.resolve();
    expect(manager.getTask(taskId)?.status).toBe('running');

    // The settle path must bridge that last step before it returns instead of
    // reading the task as "still running".
    await manager.settlePendingExits();
    const settled = manager.getTask(taskId);
    expect(settled?.status).toBe('completed');
    expect(settled?.exitCode).toBe(0);
  });
});
