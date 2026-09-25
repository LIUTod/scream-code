/**
 * Environment detection.
 *
 * Pins the cross-platform shape of `detectEnvironment()`:
 *
 *   - macOS / Linux / Windows / unknown → `osKind`
 *   - POSIX path probing prefers /bin/bash, falls back to /usr/bin/bash,
 *     /usr/local/bin/bash, then /bin/sh (with shellName 'sh').
 *   - Windows resolves Git Bash via `SCREAM_SHELL_PATH`, `git.exe` on PATH,
 *     or well-known install locations; when Git Bash is absent it falls back
 *     to PowerShell (`pwsh.exe` before `powershell.exe`); throws
 *     `JianShellNotFoundError` only when neither shell exists.
 *   - `osArch` / `osVersion` are populated from the Node OS APIs.
 *
 * All tests expect `detectEnvironment()` to be a pure function of
 * injected platform probes (no ambient state) so the same suite runs
 * identically on macOS/Linux/Windows CI runners.
 */

import { describe, expect, it } from 'vitest';

import {
  detectEnvironment,
  type Environment,
  type OsKind,
  type ShellName,
} from '#/environment';
import { JianShellNotFoundError } from '#/errors';

interface StubOpts {
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  readonly release?: string;
  readonly env?: Record<string, string | undefined>;
  readonly existingPaths?: readonly string[];
  readonly executables?: Readonly<Record<string, string>>;
}

/** Build a stub deps bag mimicking Node's `os` + `process` surface. */
function stubDeps(opts: StubOpts): Parameters<typeof detectEnvironment>[0] {
  const existing = new Set(opts.existingPaths ?? []);
  const executables = opts.executables ?? {};
  return {
    platform: opts.platform,
    arch: opts.arch ?? 'x86_64',
    release: opts.release ?? '1.2.3',
    env: opts.env ?? {},
    isFile: async (path: string) => existing.has(path),
    findExecutable: async (name: string) => executables[name],
  };
}

describe('detectEnvironment', () => {
  it('reports osKind "macOS" on darwin', async () => {
    const env: Environment = await detectEnvironment(
      stubDeps({
        platform: 'darwin',
        arch: 'arm64',
        release: '23.4.0',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osKind satisfies OsKind).toBe('macOS');
    expect(env.osArch).toBe('arm64');
    expect(env.osVersion).toBe('23.4.0');
  });

  it('reports osKind "Linux" on linux', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'linux', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osKind).toBe('Linux');
  });

  it('reports osKind "Windows" on win32', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.osKind).toBe('Windows');
  });

  it('passes through unknown platform string verbatim', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'freebsd' as NodeJS.Platform, existingPaths: ['/bin/sh'] }),
    );
    // Python `Environment.detect` returns `platform.system()` verbatim
    // for unknown OS strings; TS mirrors that behaviour.
    expect(env.osKind).toBe('freebsd');
  });

  // ── POSIX shell probing ────────────────────────────────────────────

  it('prefers /bin/bash when it exists (shellName=bash)', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('bash');
    expect(env.shellPath).toBe('/bin/bash');
    expect(env.shellArgs).toEqual(['-c']);
  });

  it('falls back to /usr/bin/bash when /bin/bash is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/bin/bash');
  });

  it('falls back to /usr/local/bin/bash when /bin and /usr/bin are missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/local/bin/bash');
  });

  it('falls back to /bin/sh with shellName=sh when no bash is found', async () => {
    const env = await detectEnvironment(stubDeps({ platform: 'linux', existingPaths: [] }));
    expect(env.shellName).toBe('sh');
    expect(env.shellPath).toBe('/bin/sh');
  });

  // ── Windows Git Bash probing ───────────────────────────────────────

  it('uses SCREAM_SHELL_PATH override when set and the file exists', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { SCREAM_SHELL_PATH: 'D:\\custom\\bash.exe' },
        existingPaths: ['D:\\custom\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\custom\\bash.exe');
  });

  it('infers Git Bash from git.exe on PATH when override is absent', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        executables: { 'git.exe': 'C:\\Program Files\\Git\\cmd\\git.exe' },
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('falls back to the well-known Program Files install location', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('falls back to LOCALAPPDATA install when present', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        existingPaths: ['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('throws JianShellNotFoundError when neither Git Bash nor PowerShell exists', async () => {
    const error = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        existingPaths: [],
      }),
    ).then(
      () => {
        throw new Error('expected throw');
      },
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(JianShellNotFoundError);
  });

  it('includes attempted paths in the thrown error message', async () => {
    const error = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { SCREAM_SHELL_PATH: 'D:\\custom\\bash.exe' },
        existingPaths: [],
      }),
    ).then(
      () => {
        throw new Error('expected throw');
      },
      (error: unknown) => error as JianShellNotFoundError,
    );
    expect(error.message).toContain('D:\\custom\\bash.exe');
    expect(error.message).toContain('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  // ── Windows PowerShell fallback ────────────────────────────────────
  //
  // A Windows host without Git for Windows used to have no execution channel
  // at all. It now falls back to PowerShell, and only a host with neither shell
  // raises: pwsh (PowerShell 7) is preferred over powershell.exe (5.1).

  it('falls back to pwsh when Git Bash is absent and pwsh is on PATH', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        executables: { 'pwsh.exe': 'C:\\Tools\\PowerShell\\7\\pwsh.exe' },
        existingPaths: [],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('pwsh');
    expect(env.shellPath).toBe('C:\\Tools\\PowerShell\\7\\pwsh.exe');
    expect(env.shellArgs).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  });

  it('prefers pwsh over powershell.exe when both are on PATH', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        executables: {
          'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          'pwsh.exe': 'C:\\Tools\\PowerShell\\7\\pwsh.exe',
        },
        existingPaths: [],
      }),
    );
    expect(env.shellName).toBe('pwsh');
    expect(env.shellPath).toBe('C:\\Tools\\PowerShell\\7\\pwsh.exe');
  });

  it('falls back to powershell.exe when Git Bash and pwsh are absent', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        executables: {
          'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        },
        existingPaths: [],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('powershell');
    expect(env.shellPath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(env.shellArgs).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  });

  it('finds pwsh in %ProgramFiles% when it is not on PATH', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        existingPaths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
      }),
    );
    expect(env.shellName).toBe('pwsh');
    expect(env.shellPath).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('finds Windows PowerShell under %SystemRoot% when it is not on PATH', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        existingPaths: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      }),
    );
    expect(env.shellName).toBe('powershell');
    expect(env.shellPath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('prefers Git Bash over PowerShell when both are available', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        executables: { 'pwsh.exe': 'C:\\Tools\\PowerShell\\7\\pwsh.exe' },
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(env.shellArgs).toEqual(['-c']);
  });

  // ── arch / version passthrough ─────────────────────────────────────

  it('reports osArch verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'darwin', arch: 'arm64', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osArch).toBe('arm64');
  });

  it('reports osVersion verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        release: '6.1.0-test',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osVersion).toBe('6.1.0-test');
  });
});
