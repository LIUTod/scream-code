import { buildCmdCommandLine } from '@scream-code/jian';

/**
 * Resolve how to launch the npm CLI on this platform.
 *
 * On Windows `npm` is `npm.cmd`, a batch shim, and a batch file cannot be
 * spawned directly: Node fails the call with EINVAL before the OS sees it,
 * because CreateProcess's implicit batch-file execution cannot be made
 * argument-safe and is therefore refused outright (see `IsWindowsBatchFile` in
 * Node's `process_wrap.cc`). Only `cmd.exe` can run a batch file.
 *
 * `shell: true` would be the one-line answer and is deliberately not used: it
 * makes Node concatenate and re-tokenize the command line itself, and it
 * triggers DEP0190 whenever args are passed alongside it. Instead the Windows
 * plan hands a fully quoted command line to `cmd.exe /d /s /c` with
 * `windowsVerbatimArguments` — the same shape the Jian Windows spawn path uses.
 *
 * The line itself is built by `buildCmdCommandLine` from `@scream-code/jian`
 * rather than by a copy of it here: quoting for `cmd` is the one thing that has
 * to stay identical to the spawn path that already ships it, and a second copy
 * is how one call site becomes injectable while the other is fixed. A token no
 * batch file can carry (an embedded `"`, a line break) throws that helper's
 * `JianExecError`.
 *
 * POSIX spawns the bare `npm` name.
 *
 * Single source of truth for the three spawn sites (update preflight, update
 * cache refresh, `/update`), each of which also needs `platform` afterwards to
 * pick the matching teardown.
 *
 * `platform` and `comspec` are injectable for tests; they default to the
 * running platform and `%ComSpec%`.
 */
export interface NpmLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  /** Only ever true for the `cmd.exe` launch below; ignored on POSIX. */
  readonly windowsVerbatimArguments: boolean;
  /**
   * The platform this plan was built for. Carried on the plan because the
   * caller needs it a second time, after the spawn: reaping a launch that timed
   * out is a different mechanism per platform (see `killProcessTree`), and
   * re-deriving it at the call site would be a second source of truth for the
   * same decision.
   */
  readonly platform: NodeJS.Platform;
}

export function npmLaunchPlan(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env['ComSpec'],
): NpmLaunchPlan {
  if (platform !== 'win32') {
    return { command: 'npm', args, windowsVerbatimArguments: false, platform };
  }
  return {
    command: comspec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', buildCmdCommandLine('npm.cmd', args)],
    windowsVerbatimArguments: true,
    platform,
  };
}
