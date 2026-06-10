/**
 * Environment — cross-platform probe of OS / shell.
 *
 * Detection is a pure function of injected probes (`platform` / `arch` /
 * `release` / `env` / `isFile` / `findExecutable`) so the same suite runs
 * identically on any host OS. `detectEnvironmentFromNode()` bundles the
 * Node defaults for production callers.
 *
 * On Windows the probe expects Git Bash (the canonical POSIX shell that
 * ships with Git for Windows). If it cannot be located the function
 * throws `JianShellNotFoundError`; the SDK layer can wrap that into a
 * user-facing install hint. Set `SCREAM_SHELL_PATH` to override.
 */

import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as nodeOs from 'node:os';

import { JianShellNotFoundError } from './errors';

// `OsKind` carries 'macOS' / 'Linux' / 'Windows' for known platforms and
// falls back to the raw `process.platform` string for unknown ones (e.g.
// 'freebsd'). Typed as `string` so the union isn't inhabited-by-string.
export type OsKind = string;
export type ShellName = 'bash' | 'sh';

export interface Environment {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
}

export interface EnvironmentDeps {
  // Accepts the full Node `Platform` enum plus arbitrary strings for
  // forward-compatible OS kinds.
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly env: Record<string, string | undefined>;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly findExecutable: (name: string) => Promise<string | undefined>;
}

function resolveOsKind(platform: string): OsKind {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}

export async function detectEnvironment(deps: EnvironmentDeps): Promise<Environment> {
  const osKind = resolveOsKind(deps.platform);
  const osArch = deps.arch;
  const osVersion = deps.release;

  if (deps.platform === 'win32') {
    const shellPath = await locateWindowsGitBash(deps);
    return { osKind, osArch, osVersion, shellName: 'bash', shellPath };
  }

  const candidates: readonly string[] = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
  let found: string | undefined;
  for (const p of candidates) {
    if (await deps.isFile(p)) {
      found = p;
      break;
    }
  }
  if (found !== undefined) {
    return { osKind, osArch, osVersion, shellName: 'bash', shellPath: found };
  }
  return { osKind, osArch, osVersion, shellName: 'sh', shellPath: '/bin/sh' };
}

async function locateWindowsGitBash(deps: EnvironmentDeps): Promise<string> {
  const checked: string[] = [];

  const override = deps.env['SCREAM_SHELL_PATH']?.trim();
  if (override !== undefined && override.length > 0) {
    checked.push(override);
    if (await deps.isFile(override)) {
      return override;
    }
  }

  // 1. Try to find git.exe on PATH and infer bash.exe from its location.
  const gitExe = await deps.findExecutable('git.exe');
  if (gitExe !== undefined) {
    const inferred = inferGitBashFromGitExe(gitExe);
    if (inferred !== undefined) {
      checked.push(inferred);
      if (await deps.isFile(inferred)) {
        return inferred;
      }
    }
    // Scoop shims (e.g. ~/scoop/shims/git.exe) won't infer correctly
    // because the path lacks "cmd"/"bin" segments.  Walk sibling
    // directories of the resolved git.exe to find a companion bash.exe.
    const fellback = inferBashByWalkingUp(gitExe);
    if (fellback !== undefined) {
      checked.push(fellback);
      if (await deps.isFile(fellback)) {
        return fellback;
      }
    }
  }

  // 2. Search for bash.exe directly on PATH (handles scoop / custom layouts
  //    where the Git usr/bin directory is on PATH).
  const bashExe = await deps.findExecutable('bash.exe');
  if (bashExe !== undefined) {
    checked.push(bashExe);
    return bashExe;
  }

  // 3. Check well-known installation roots.
  const candidates: string[] = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\cygwin64\\bin\\bash.exe',
  ];
  const localAppData = deps.env['LOCALAPPDATA']?.trim();
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  }
  const userProfile = deps.env['USERPROFILE']?.trim();
  if (userProfile !== undefined && userProfile.length > 0) {
    // scoop (default); current symlink points to the active version
    candidates.push(`${userProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe`);
  }
  for (const candidate of candidates) {
    checked.push(candidate);
    if (await deps.isFile(candidate)) {
      return candidate;
    }
  }

  throw new JianShellNotFoundError(
    `Git Bash was not found on this Windows host. Install Git for Windows from https://gitforwindows.org/ or set SCREAM_SHELL_PATH to a bash.exe. Checked: ${checked.join(', ')}.`,
  );
}

// Most Git for Windows installs put `git.exe` in `<root>\cmd\git.exe`,
// with bash at `<root>\bin\bash.exe`. Portable installs sometimes put
// both in `<root>\bin\`. Walk back to the parent of `cmd` / `bin` and
// re-anchor under `bin\bash.exe`.
function inferGitBashFromGitExe(gitExe: string): string | undefined {
  const sep = gitExe.includes('\\') ? '\\' : '/';
  const parts = gitExe.split(sep);
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const segment = parts[i];
    if (segment === 'cmd' || segment === 'bin') {
      const root = parts.slice(0, i).join(sep);
      return root.length === 0 ? `bin${sep}bash.exe` : `${root}${sep}bin${sep}bash.exe`;
    }
  }
  return undefined;
}

// Fallback when inferGitBashFromGitExe returns undefined — e.g. scoop shims
// at `~/scoop/shims/git.exe` where no path segment is "cmd" or "bin".
// Walks upward from git.exe looking for `bash.exe` in a sibling `bin`
// directory, capped at 5 levels to avoid scanning the whole drive.
function inferBashByWalkingUp(gitExe: string): string | undefined {
  const sep = gitExe.includes('\\') ? '\\' : '/';
  const parts = gitExe.split(sep);
  // Start from the directory containing git.exe, walk up.
  for (let i = parts.length - 1; i >= 1 && parts.length - i <= 6; i -= 1) {
    const root = parts.slice(0, i).join(sep) || sep;
    const candidate = `${root}${sep}bin${sep}bash.exe`;
    // Quick syntactic filter: only return if it looks like a different
    // directory than where git.exe lives (the caller will verify with isFile).
    const gitDir = parts.slice(0, -1).join(sep);
    if (`${root}${sep}bin` !== gitDir) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Production convenience — derive the deps bag from Node's ambient surface.
 *
 * The result is memoised: subsequent calls return the original promise.
 * `Environment` is immutable for the lifetime of the process (it derives
 * from `process.platform`, `process.arch`, `os.release()`, and one-time
 * shell-path discovery), so caching is sound. Tests that need to probe
 * with different inputs should call {@link detectEnvironment} directly
 * with an injected deps bag.
 */
let detectedEnvironment: Promise<Environment> | undefined;

export function detectEnvironmentFromNode(): Promise<Environment> {
  if (detectedEnvironment !== undefined) return detectedEnvironment;
  const platform = process.platform;
  const env = process.env as Record<string, string | undefined>;
  const isFile = async (path: string): Promise<boolean> => {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  detectedEnvironment = detectEnvironment({
    platform,
    arch: process.arch,
    release: nodeOs.release(),
    env,
    isFile,
    findExecutable: (name: string) => findExecutableOnPath(name, env['PATH'], platform, isFile),
  });
  return detectedEnvironment;
}

async function findExecutableOnPath(
  name: string,
  pathEnv: string | undefined,
  platform: string,
  isFile: (p: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (pathEnv === undefined || pathEnv.length === 0) return undefined;
  const listSep = platform === 'win32' ? ';' : ':';
  const dirSep = platform === 'win32' ? '\\' : '/';
  for (const rawDir of pathEnv.split(listSep)) {
    const dir = rawDir.trim();
    if (dir.length === 0) continue;
    const candidate = dir.endsWith(dirSep) ? `${dir}${name}` : `${dir}${dirSep}${name}`;
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
