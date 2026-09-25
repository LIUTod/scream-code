/**
 * Windows dialect — command resolution, spawn planning and process-tree rules.
 *
 * `LocalJian` takes its dialect from the injected `Environment` (`osKind`), not
 * from `process.platform`, so these branches are exercised on any host:
 *
 *   - a bare `npm` resolves through `PATH` + `PATHEXT` (raw `spawn('npm')` fails
 *     on Windows even where `npm.cmd` works in every terminal);
 *   - `.cmd` / `.bat` shims launch through `cmd.exe /d /s /c` with a quoted
 *     command line, everything else is spawned by path;
 *   - the tree is killed with `taskkill /F /T`, which is why the child is not
 *     spawned `detached` — that flag is the POSIX process-group mechanism.
 *
 * `windowsSpawnPlan` is asserted directly rather than through a stubbed
 * `child_process`, so the exact argv is pinned without an emulated `cmd.exe`.
 *
 * The two end-to-end execution tests below do spawn, and they stand a Windows
 * tool in with a POSIX shell script — which no Windows host can run — so they
 * skip on Windows itself; the argv they exercise is asserted above on every
 * host.
 */

import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '#/environment';
import { JianExecError } from '#/errors';
import { LocalJian, windowsSpawnPlan } from '#/local';
import { detachedForProcessTree, isWindowsPlatform } from '#/platform';

const WINDOWS_ENV: Environment = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: '10.0.26100',
  shellName: 'powershell',
  shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  shellArgs: ['-NoProfile', '-NonInteractive', '-Command'],
};

const POSIX_ENV: Environment = {
  osKind: 'Linux',
  osArch: 'x64',
  osVersion: '6.1.0',
  shellName: 'bash',
  shellPath: '/bin/bash',
  shellArgs: ['-c'],
};

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** A stand-in for a Windows executable that this host can actually run. */
async function writeExecutable(path: string, marker: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\necho ${marker}\n`);
  await chmod(path, 0o755);
}

describe('platform dialect', () => {
  it('identifies win32 and only win32 as Windows', () => {
    expect(isWindowsPlatform('win32')).toBe(true);
    expect(isWindowsPlatform('linux')).toBe(false);
    expect(isWindowsPlatform('darwin')).toBe(false);
    expect(isWindowsPlatform('posix')).toBe(false);
  });

  it('detaches exactly the platforms that have process groups', () => {
    expect(detachedForProcessTree('win32')).toBe(false);
    expect(detachedForProcessTree('linux')).toBe(true);
    expect(detachedForProcessTree('darwin')).toBe(true);
  });
});

describe('LocalJian injected dialect', () => {
  it('reports the win32 path class without the host being Windows', async () => {
    const jian = await LocalJian.create(undefined, undefined, WINDOWS_ENV);
    expect(jian.pathClass()).toBe('win32');
  });

  it('reports the posix path class for a POSIX environment', async () => {
    const jian = await LocalJian.create(undefined, undefined, POSIX_ENV);
    expect(jian.pathClass()).toBe('posix');
  });

  it('keeps the Windows dialect across withCwd()', async () => {
    const jian = await LocalJian.create(undefined, undefined, WINDOWS_ENV);
    expect(jian.withCwd('/tmp').pathClass()).toBe('win32');
  });
});

describe('windowsSpawnPlan', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jian-win-plan-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  function env(overrides: Record<string, string> = {}): Record<string, string> {
    return { PATH: dir, PATHEXT: DEFAULT_PATHEXT, ComSpec: COMSPEC, ...overrides };
  }

  it('resolves a bare name through PATHEXT into a direct spawn', async () => {
    const npmExe = join(dir, 'npm.EXE');
    await writeExecutable(npmExe, 'x');

    const plan = await windowsSpawnPlan('npm', ['install'], env());

    expect(plan).toEqual({
      command: npmExe,
      args: ['install'],
      windowsVerbatimArguments: false,
    });
  });

  it('prefers the literal name over any PATHEXT candidate', async () => {
    const literal = join(dir, 'tool');
    await writeExecutable(literal, 'x');
    await writeExecutable(join(dir, 'tool.CMD'), 'x');

    const plan = await windowsSpawnPlan('tool', [], env());

    expect(plan.command).toBe(literal);
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it('uses PATHEXT entries verbatim, including their case', async () => {
    const lower = join(dir, 'tool.cmd');
    await writeExecutable(lower, 'x');

    const plan = await windowsSpawnPlan('tool', [], env({ PATHEXT: '.cmd' }));

    expect(plan.command).toBe(COMSPEC);
    expect(plan.args[3]).toBe(`"${lower}"`);
  });

  it('launches a .cmd shim through cmd.exe with one quoted command line', async () => {
    const npmCmd = join(dir, 'npm.CMD');
    await writeExecutable(npmCmd, 'x');

    const plan = await windowsSpawnPlan('npm', ['install', 'left-pad'], env());

    expect(plan.command).toBe(COMSPEC);
    expect(plan.args).toEqual(['/d', '/s', '/c', `"${npmCmd} install left-pad"`]);
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it('quotes tokens carrying cmd metacharacters or spaces', async () => {
    const npmCmd = join(dir, 'npm.CMD');
    await writeExecutable(npmCmd, 'x');

    const plan = await windowsSpawnPlan('npm', ['a&b', 'c d', 'e|f'], env());

    expect(plan.args[3]).toBe(`"${npmCmd} "a&b" "c d" "e|f""`);
  });

  it('keeps an empty argument as its own quoted slot', async () => {
    const npmCmd = join(dir, 'npm.CMD');
    await writeExecutable(npmCmd, 'x');

    // `""` is how `cmd` spells an empty argument. Dropping it would shift every
    // argument after it, so `install -g ''` would reach npm as `install -g`.
    const plan = await windowsSpawnPlan('npm', ['install', '-g', ''], env());

    expect(plan.args[3]).toBe(`"${npmCmd} install -g """`);
  });

  it('refuses a token carrying a double quote instead of escaping it', async () => {
    const npmCmd = join(dir, 'npm.CMD');
    await writeExecutable(npmCmd, 'x');

    // `cmd` toggles quoting on `"` and has no escape character, so this token
    // could not be kept one argument: the `&` would reach `cmd` as a separator
    // and run a second command. Failing closed is the only safe outcome.
    const error = await windowsSpawnPlan('npm', ['a" & calc & "b'], env()).then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(JianExecError);
    expect((error as Error).message).toContain('a\\" & calc & \\"b');
    expect((error as Error).message).toContain('cmd.exe has no escape character');
  });

  it('refuses a token carrying a line break', async () => {
    const npmCmd = join(dir, 'npm.CMD');
    await writeExecutable(npmCmd, 'x');

    // A newline ends the line `cmd.exe /c` parses, so anything after it becomes
    // a further command rather than an argument.
    const error = await windowsSpawnPlan('npm', ['a\r\ncalc'], env()).then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(JianExecError);
    expect((error as Error).message).toContain('line break');
  });

  it('falls back to the platform PATHEXT and ComSpec defaults when unset', async () => {
    await writeExecutable(join(dir, 'shim.CMD'), 'x');

    const plan = await windowsSpawnPlan('shim', [], { PATH: dir });

    expect(plan.command).toBe('cmd.exe');
    expect(plan.args).toEqual(['/d', '/s', '/c', `"${join(dir, 'shim.CMD')}"`]);
  });

  it('reports the command and every name it tried instead of a bare ENOENT', async () => {
    const error = await windowsSpawnPlan('missing-tool', [], env({ PATHEXT: '.CMD;.EXE' })).then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(JianExecError);
    expect((error as Error).message).toContain('Command not found: missing-tool');
    expect((error as Error).message).toContain('missing-tool, missing-tool.CMD, missing-tool.EXE');
    expect((error as Error).message).toContain(dir);
  });

  it('looks only at the given path when the command carries a separator', async () => {
    const error = await windowsSpawnPlan(join(dir, 'nested', 'missing-tool'), [], env()).then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );

    expect((error as Error).message).toContain('the path given in the command');
    expect((error as Error).message).not.toContain(`PATH (${dir})`);
  });

  it('resolves an absolute path that needs a PATHEXT suffix appended', async () => {
    const nested = join(dir, 'nested');
    await mkdir(nested);
    const toolCmd = join(nested, 'tool.CMD');
    await writeExecutable(toolCmd, 'x');

    const plan = await windowsSpawnPlan(join(nested, 'tool'), [], env());

    expect(plan.command).toBe(COMSPEC);
    expect(plan.args[3]).toBe(`"${toolCmd}"`);
  });

  it('keeps a directory with a space intact through the .CMD command line', async () => {
    const spaced = join(dir, 'with space');
    await mkdir(spaced);
    const npmCmd = join(spaced, 'npm.CMD');
    await writeExecutable(npmCmd, 'x');

    const plan = await windowsSpawnPlan('npm', [], env({ PATH: spaced }));

    // Outer quotes are `cmd.exe /s`'s single stripped pair; the inner pair is
    // what keeps the space-bearing path one argument.
    expect(plan.args[3]).toBe(`""${npmCmd}""`);
  });
});

describe('LocalJian Windows execution', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jian-win-exec-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  // `writeExecutable` stands a Windows tool in with a POSIX shell script, which
  // only a POSIX host can launch — Windows refuses a text file however it is
  // named, so the assertion would be about the stub, not the resolution. The
  // resolution itself is pinned by the `windowsSpawnPlan` tests above, which run
  // on every host.
  it.skipIf(process.platform === 'win32')('runs the executable a bare name resolves to', async () => {
    await writeExecutable(join(dir, 'npm.EXE'), 'resolved-exe');
    vi.stubEnv('PATH', dir);
    vi.stubEnv('PATHEXT', DEFAULT_PATHEXT);

    const jian = await LocalJian.create(undefined, undefined, WINDOWS_ENV);
    const proc = await jian.exec('npm');
    const output = await streamToString(proc.stdout);
    await proc.wait();

    expect(output.trim()).toBe('resolved-exe');
  });

  // Premise: this host has no `cmd.exe`, so the route to `ComSpec` is only
  // observable as a spawn failure naming it. On Windows that interpreter exists
  // and the spawn succeeds — the rejection asserted below cannot happen — so the
  // routing is pinned by the `windowsSpawnPlan` tests above instead.
  it.skipIf(process.platform === 'win32')('routes a .CMD shim through cmd.exe', async () => {
    await writeExecutable(join(dir, 'npm.CMD'), 'resolved-cmd');
    vi.stubEnv('PATH', dir);
    vi.stubEnv('PATHEXT', DEFAULT_PATHEXT);
    vi.stubEnv('ComSpec', COMSPEC);

    const jian = await LocalJian.create(undefined, undefined, WINDOWS_ENV);
    const error = await jian.exec('npm').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );

    // `cmd.exe` does not exist on this host, so the failure names the
    // interpreter the shim was routed to — which is the assertion.
    expect((error as Error).message).toContain(COMSPEC);
  });

  it('fails with the resolution error before spawning anything', async () => {
    vi.stubEnv('PATH', dir);
    vi.stubEnv('PATHEXT', DEFAULT_PATHEXT);

    const jian = await LocalJian.create(undefined, undefined, WINDOWS_ENV);
    const error = await jian.exec('missing-tool-xyz').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );

    expect((error as Error).message).toContain('Command not found: missing-tool-xyz');
  });

  it('spawns a POSIX command as given, with no Windows resolution', async () => {
    const jian = await LocalJian.create(undefined, undefined, POSIX_ENV);
    // `node` is a bare name with no PATHEXT-suffixed sibling anywhere, so this
    // only succeeds because the POSIX branch spawns the name as given.
    const proc = await jian.exec('node', '-e', 'process.stdout.write("posix-spawn")');
    const output = await streamToString(proc.stdout);
    await proc.wait();

    expect(output).toBe('posix-spawn');
  });
});
