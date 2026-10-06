import { Readable, type Writable } from 'node:stream';

import type { Environment, JianProcess } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import { BashTool } from '../../src/tools/builtin/shell/bash';
import { parentInterjectReason } from '../../src/utils/abort';
import { executeTool } from './fixtures/execute-tool';
import { createFakeJian } from './fixtures/fake-jian';

const posixEnv: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
};

/**
 * A process whose `wait` settles only once `kill` runs, so a test can fire an
 * abort while the command is "running" — no dependence on real timing or on a
 * real child process.
 */
function runningProcess(): { proc: JianProcess; kill: ReturnType<typeof vi.fn> } {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const kill = vi.fn(async () => {
    resolveWait(143);
  });
  const proc: JianProcess = {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 501,
    exitCode: null,
    wait: vi.fn(async () => waitPromise),
    kill,
  };
  return { proc, kill };
}

describe('BashTool cancellation contract', () => {
  it('reports the cancellation with an "Interrupted by user" message and kills the process', async () => {
    const { proc, kill } = runningProcess();
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const controller = new AbortController();
    const tool = new BashTool(createFakeJian({ execWithEnv, osEnv: posixEnv }), '/workspace');

    const running = executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_cancel',
      args: { command: 'sleep 2 && printf should-not-exist > cancel_output.txt' },
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(proc.stdin.end).toHaveBeenCalled();
    });
    controller.abort();
    const result = await running;

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Interrupted by user');
  });

  it('attributes a parent-agent interject when it cuts a running command', async () => {
    const { proc } = runningProcess();
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const controller = new AbortController();
    const tool = new BashTool(createFakeJian({ execWithEnv, osEnv: posixEnv }), '/workspace');

    const running = executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_interject',
      args: { command: 'sleep 2 && printf should-not-exist > cancel_output.txt' },
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(proc.stdin.end).toHaveBeenCalled();
    });
    // Exactly the reason the loop builds when a parent agent's `interject`
    // trips the mid-batch steer lane (loop/tool-call.ts).
    controller.abort(parentInterjectReason());
    const result = await running;

    // Bash settles its own abort result, so the attribution has to come from
    // the signal's reason: a parent's redirection must not be reported as the
    // user stopping the run.
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Interrupted by the parent agent');
    expect(result.output).not.toContain('Interrupted by user');
    // `brief` (the side-channel label) rides along at runtime — the builder's
    // result carries it — but is not part of the declared result type.
    expect((result as { brief?: string }).brief).toBe('Interrupted by the parent agent');
  });

  it('attributes a parent-agent interject that lands before the command starts', async () => {
    const execWithEnv = vi.fn();
    const controller = new AbortController();
    const tool = new BashTool(createFakeJian({ execWithEnv, osEnv: posixEnv }), '/workspace');
    controller.abort(parentInterjectReason());

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_interject_pre_start',
      args: { command: 'echo never-runs' },
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'Interrupted by the parent agent before the command started',
    });
    expect(execWithEnv).not.toHaveBeenCalled();
  });
});
