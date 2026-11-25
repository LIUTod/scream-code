/**
 * After an upgrade the background keeps running the build it loaded: an
 * upgrade replaces the files, not the running process. The person installs a
 * fix, sees the old behaviour, and reports the bug again. `/update` restarts
 * the background itself; an upgrade done any other way (`npm i -g`, a package
 * manager) did not.
 *
 * A terminal of a newer build therefore restarts the background once it has
 * nothing in flight (`restart-if-idle`): a service-launched host exits to be
 * restarted by its service, which runs the installed scream; any other host
 * is started again by this terminal. Asked again every few minutes while it
 * is busy, never in a loop:
 *
 * - only when the background is *older* than this terminal — an old terminal
 *   still open after the upgrade must not take the background back down to
 *   its own build every few minutes;
 * - never from a checkout run from its sources (`screambeta`), whose version
 *   says nothing about what is installed;
 * - a service is restarted only when it runs this very scream, or the restart
 *   would bring up the same old build again.
 */

import { resolve } from 'node:path';

import { gt, valid } from 'semver';

import { getVersion } from '#/cli/version';

import { HOST_SHUTDOWN_GRACE_MS, readHostStatus, restartHostIfIdle, stopHost, type HostStatus } from './control';
import { isSourceEntry, restartService, serviceRunsEntry, startBackground } from './service';

/** How often a terminal asks a busy background again. */
export const STALE_BUILD_RETRY_MS = 5 * 60 * 1000;
/** How long a service gets to bring the new host up (systemd waits 10 s before a restart). */
const SERVICE_RESTART_WAIT_MS = 20_000;
const POLL_MS = 250;

/**
 * Whether a host that loaded `running` is older than `current`. A host that
 * names no build predates the stamp, which is older than any build that has
 * it; a version that is not semver says nothing either way.
 */
export function hostBuildIsOlder(running: string | undefined, current: string): boolean {
  if (valid(current) === null) return false;
  if (running === undefined) return true;
  if (valid(running) === null) return false;
  return gt(current, running);
}

export type StaleBuildOutcome = 'restarted' | 'busy' | 'current' | 'skipped' | 'failed';

export interface StaleBuildDeps {
  readonly entry?: string | undefined;
  readonly version?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly status?: (() => Promise<HostStatus>) | undefined;
  readonly restartIfIdle?: typeof restartHostIfIdle | undefined;
  readonly start?: (() => Promise<unknown>) | undefined;
  readonly stop?: (() => Promise<unknown>) | undefined;
  readonly restartService?: (() => Promise<unknown>) | undefined;
  readonly serviceRunsEntry?: ((entry: string) => Promise<boolean>) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

let lastAskedAt = 0;

/** For tests. */
export function resetStaleBuildForTests(): void {
  lastAskedAt = 0;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** Restart the background onto this terminal's build when it runs an older one and is idle. Never throws. */
export async function restartStaleBackground(deps: StaleBuildDeps = {}): Promise<StaleBuildOutcome> {
  try {
    const entry = resolve(deps.entry ?? process.argv[1] ?? '');
    const version = deps.version ?? getVersion();
    const now = deps.now ?? Date.now;
    const status = deps.status ?? readHostStatus;
    const sleep =
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((done) => {
          setTimeout(done, ms);
        }));
    if (isSourceEntry(entry)) return 'skipped';
    const host = await status();
    if (!host.running || host.legacy === true) return 'skipped';
    if (!hostBuildIsOlder(host.version, version)) return 'current';
    if (now() - lastAskedAt < STALE_BUILD_RETRY_MS) return 'skipped';
    lastAskedAt = now();
    if (host.service === true && !(await (deps.serviceRunsEntry ?? serviceRunsEntry)(entry))) return 'skipped';

    const reply = await (deps.restartIfIdle ?? restartHostIfIdle)();
    if (!reply.ok && reply.unsupported === true) {
      // A host from before `restart-if-idle` (the very first upgrade onto
      // this code) cannot say whether it is idle: restart it the way
      // `/update` does. A stop hands work in flight over, and the next host
      // continues it.
      if (host.service === true) await (deps.restartService ?? restartService)();
      else {
        await (deps.stop ?? stopHost)();
        await (deps.start ?? startBackground)();
      }
      return 'restarted';
    }
    if (!reply.ok) return reply.busy === true ? 'busy' : 'failed';
    // Replaced: a host with another pid holds the lock — a service can bring
    // the new one up faster than a poll would ever see the lock free.
    const oldPid = host.pid;
    const replaced = (next: HostStatus): boolean => next.running && next.pid !== oldPid;
    // It is idle, so it leaves quickly; the grace window bounds a slow exit.
    const left = await waitFor(
      async () => {
        const next = await status();
        return !next.running || replaced(next);
      },
      HOST_SHUTDOWN_GRACE_MS + 5_000,
      now,
      sleep,
    );
    if (!left) return 'failed';
    if (reply.service === true) {
      if (await waitFor(async () => replaced(await status()), SERVICE_RESTART_WAIT_MS, now, sleep)) return 'restarted';
    } else if (replaced(await status())) {
      // Another terminal started it meanwhile.
      return 'restarted';
    }
    // Not a service host — or a service (a Windows logon task) that does not
    // restart by itself: start it, the way any terminal start does.
    await (deps.start ?? startBackground)();
    return 'restarted';
  } catch {
    return 'failed';
  }
}
