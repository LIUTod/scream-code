import { Readable, type Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { Jian, JianProcess } from '@scream-code/jian';

import {
  buildLaunchSpec,
  DEBUGPY_INSTALL_MESSAGE,
  resolveDebugpy,
} from '../../src/dap/adapter';
import { testJian } from '../fixtures/test-jian';

function fakeProcess(options: { stdout?: string; exitCode?: number } = {}): JianProcess {
  const exitCode = options.exitCode ?? 0;
  return {
    stdin: { end: () => {} } as unknown as Writable,
    stdout: Readable.from(options.stdout === undefined ? [] : [options.stdout]),
    stderr: Readable.from([]),
    pid: 4242,
    exitCode,
    wait: async () => exitCode,
    kill: async () => {},
  } as unknown as JianProcess;
}

function jianWithExec(exec: Jian['exec']): Jian {
  return { exec, execWithEnv: exec } as unknown as Jian;
}

describe('resolveDebugpy', () => {
  it('probes python3 -m debugpy --version and returns the stdio adapter command', async () => {
    const calls: string[][] = [];
    const jian = jianWithExec(async (...args: string[]) => {
      calls.push(args);
      return fakeProcess({ stdout: '1.8.16\n' });
    });

    const resolution = await resolveDebugpy(jian);

    expect(calls).toEqual([['python3', '-m', 'debugpy', '--version']]);
    expect(resolution).toEqual({
      ok: true,
      command: ['python3'],
      args: ['-m', 'debugpy.adapter'],
      python: ['python3'],
    });
  });

  it('maps a non-zero probe exit to the install instruction', async () => {
    const jian = jianWithExec(async () => fakeProcess({ exitCode: 1 }));
    await expect(resolveDebugpy(jian)).resolves.toEqual({
      ok: false,
      reason: DEBUGPY_INSTALL_MESSAGE,
    });
  });

  it('maps a spawn failure to the install instruction', async () => {
    const jian = jianWithExec(async () => {
      throw new Error('spawn python3 ENOENT');
    });
    const resolution = await resolveDebugpy(jian);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('expected the probe to fail');
    expect(resolution.reason).toBe(
      'debugpy is not installed. Install it with: python3 -m pip install debugpy',
    );
  });

  it('honours a custom interpreter name', async () => {
    const jian = jianWithExec(async () => fakeProcess({ stdout: '1.8.16\n' }));
    const resolution = await resolveDebugpy(jian, '/usr/bin/python3.12');
    expect(resolution.ok && resolution.command).toEqual(['/usr/bin/python3.12']);
  });

  it('reports a missing interpreter through a real spawn (no fake)', async () => {
    // A real LocalJian, a real failed spawn: the device this repository runs on
    // may or may not have debugpy, but this binary never exists, so the path is
    // deterministic on every machine.
    const resolution = await resolveDebugpy(testJian, 'scream-code-no-such-python-binary');
    expect(resolution).toEqual({ ok: false, reason: DEBUGPY_INSTALL_MESSAGE });
  });
});

describe('buildLaunchSpec', () => {
  it('builds a debugpy launch body that stays off the terminal', () => {
    const spec = buildLaunchSpec({
      python: ['python3'],
      program: '/tmp/prog.py',
      args: ['--x'],
      cwd: '/tmp',
    });
    expect(spec).toEqual({
      python: ['python3'],
      program: '/tmp/prog.py',
      args: ['--x'],
      cwd: '/tmp',
      stopOnEntry: true,
      justMyCode: true,
    });
  });

  it('carries explicit stop and justMyCode switches', () => {
    const spec = buildLaunchSpec({
      python: ['python3'],
      program: '/tmp/prog.py',
      cwd: '/tmp',
      stopOnEntry: false,
      justMyCode: false,
    });
    expect(spec.stopOnEntry).toBe(false);
    expect(spec.justMyCode).toBe(false);
    expect(spec.args).toEqual([]);
  });
});
