import { type ChildProcess } from 'node:child_process';

import type * as JianModule from '@scream-code/jian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLatestArgs, globalPrefixForScream } from '#/cli/update/prefix';
import { runInstallStep } from '#/tui/commands/update';
import { npmLaunchPlan } from '#/utils/exec/npm';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

const killProcessTreeMock = vi.hoisted(() => vi.fn(async () => {}));
// The real exports stay in place: `npmLaunchPlan` builds its Windows command
// line with the package's `buildCmdCommandLine`.
vi.mock('@scream-code/jian', async (importOriginal) => ({
  ...(await importOriginal<typeof JianModule>()),
  killProcessTree: killProcessTreeMock,
}));

describe('globalPrefixForScream', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('resolves the prefix from a user-global install path', () => {
    process.argv = [
      'node',
      '/Users/someone/.npm-global/lib/node_modules/scream-code/dist/main.mjs',
    ];
    expect(globalPrefixForScream()).toBe('/Users/someone/.npm-global');
  });

  it('resolves the prefix from a system-global install path', () => {
    process.argv = [
      'node',
      '/usr/local/lib/node_modules/scream-code/dist/main.mjs',
    ];
    expect(globalPrefixForScream()).toBe('/usr/local');
  });

  it('returns undefined for an unrecognized layout', () => {
    process.argv = ['node', '/Users/someone/dev/scream-code/dist/main.mjs'];
    expect(globalPrefixForScream()).toBeUndefined();
  });

  it('returns undefined when there is no entry script', () => {
    process.argv = ['node'];
    expect(globalPrefixForScream()).toBeUndefined();
  });
});

describe('installLatestArgs', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('includes --prefix when the global prefix is resolvable', () => {
    process.argv = [
      'node',
      '/Users/someone/.npm-global/lib/node_modules/scream-code/dist/main.mjs',
    ];
    expect(installLatestArgs()).toEqual([
      'install',
      '-g',
      'scream-code@latest',
      '--prefix',
      '/Users/someone/.npm-global',
    ]);
  });

  it('omits --prefix for an unrecognized layout', () => {
    process.argv = ['node', '/Users/someone/dev/scream-code/dist/main.mjs'];
    expect(installLatestArgs()).toEqual(['install', '-g', 'scream-code@latest']);
  });
});

/** A child that never exits and never errors, so only the timeout path runs. */
function fakeChild(pid: number | undefined): ChildProcess {
  return {
    pid,
    kill: vi.fn(() => true),
    stderr: { on: vi.fn() },
    once: vi.fn(),
  } as unknown as ChildProcess;
}

describe('runInstallStep — timeout teardown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function runToTimeout(
    platform: NodeJS.Platform,
    child: ChildProcess,
  ): Promise<{ ok: boolean; message: string }> {
    spawnMock.mockReturnValue(child);
    vi.useFakeTimers();

    const pending = runInstallStep(
      npmLaunchPlan(['install', '-g', 'scream-code@latest'], platform),
      undefined,
      'install: ',
      50,
    );
    await vi.advanceTimersByTimeAsync(60);
    return pending;
  }

  it('reaps the whole tree through taskkill when the Windows wrapper times out', async () => {
    const child = fakeChild(4321);

    const result = await runToTimeout('win32', child);

    // The direct child on Windows is `cmd.exe` (see `npmLaunchPlan`), so
    // signalling it would stop the wrapper and leave the `npm` / `node` beneath
    // it running. `killProcessTree` walks the tree with `taskkill /F /T /PID`.
    expect(killProcessTreeMock).toHaveBeenCalledWith(4321, {
      signal: 'SIGTERM',
      platform: 'win32',
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('install: ');
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', '"npm.cmd install -g scream-code@latest"'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  it('signals the child itself on POSIX, unchanged', async () => {
    const child = fakeChild(4321);

    const result = await runToTimeout('linux', child);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'scream-code@latest'],
      expect.objectContaining({ windowsVerbatimArguments: false }),
    );
  });

  it('passes a non-positive pid when the spawn never produced a process', async () => {
    const child = fakeChild(undefined);

    await runToTimeout('win32', child);

    // `killProcessTree` treats a non-positive pid as a no-op; the timeout still
    // has to be reported.
    expect(killProcessTreeMock).toHaveBeenCalledWith(0, {
      signal: 'SIGTERM',
      platform: 'win32',
    });
  });
});
