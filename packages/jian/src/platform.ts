/**
 * Platform dialect — the spawn / kill rules that differ between Windows and
 * POSIX, written once and shared by every spawn site in this repo.
 *
 * Two questions come up at each site, and they must be answered the same way
 * everywhere or a caller ends up with a half-killed process tree:
 *
 *   1. `detached` — on POSIX, `detached: true` makes the child a process-group
 *      leader, which is what lets a single `kill(-pid)` reach the grandchildren
 *      a shell command spawns. Windows has no process groups, so it stays
 *      `false` and relies on `taskkill /T`.
 *   2. Killing — {@link killProcessTree}, which pairs with (1).
 *
 * The platform is always a parameter (never a module-level constant) so tests
 * can drive both dialects from any host.
 */

import { spawn } from 'node:child_process';

/**
 * True on Windows — the platform with no POSIX process groups, no POSIX
 * signals, and case-insensitive path comparison.
 */
export function isWindowsPlatform(platform: string): boolean {
  return platform === 'win32';
}

/**
 * The `detached` flag for a spawn whose process tree will later be reaped by
 * {@link killProcessTree}: true exactly when the platform has process groups.
 */
export function detachedForProcessTree(platform: string): boolean {
  return !isWindowsPlatform(platform);
}

export interface KillProcessTreeOptions {
  /** POSIX signal to deliver. Ignored on Windows — see {@link killProcessTree}. */
  readonly signal: NodeJS.Signals;
  /** Host platform; defaults to the ambient one at call time. */
  readonly platform?: string | undefined;
}

/**
 * Kill `pid` and every descendant, resolving once the request has been made.
 *
 * Windows: `taskkill /F /T /PID <pid>`. `/T` walks the tree; `/F` is
 * unconditional because without it `taskkill` only posts `WM_CLOSE`, which
 * console processes — i.e. everything an agent runs — ignore, so a "graceful"
 * Windows kill would report success while leaving the tree running. Exit code
 * 128 ("process not found") resolves, mirroring the POSIX `ESRCH` branch below:
 * an already-dead tree is the state the caller asked for.
 *
 * POSIX: signal the process group, which requires the child to have been
 * spawned with `detached: true` (see {@link detachedForProcessTree}).
 * `ESRCH` resolves for the same reason. Anything else rejects so the caller can
 * decide whether to surface it.
 */
export async function killProcessTree(
  pid: number,
  options: KillProcessTreeOptions,
): Promise<void> {
  // pid <= 0 means the spawn never produced a process. `kill(-1)` on POSIX
  // would signal every process the user owns, so this must never be reached.
  if (pid <= 0) return;

  if (isWindowsPlatform(options.platform ?? process.platform)) {
    await runTaskkill(pid);
    return;
  }

  try {
    process.kill(-pid, options.signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
}

const TASKKILL_PROCESS_NOT_FOUND = 128;

function runTaskkill(pid: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', (error: Error) => {
      reject(new Error(`taskkill failed to start: ${error.message}`));
    });
    killer.once('close', (code: number | null) => {
      if (code === 0 || code === TASKKILL_PROCESS_NOT_FOUND) resolve();
      else reject(new Error(`taskkill exited with code ${String(code)}`));
    });
    // Do not hold the event loop open for the reaper of a process we are
    // already tearing down.
    killer.unref();
  });
}
