/**
 * The background host's lifecycle: who runs, start, stop, log rotation.
 *
 * The host (`scream host`) is the one long-lived scream process of a Scream
 * home: it serves the Feishu/WeChat channels when they are configured,
 * continues interrupted or handed-off work, and runs scheduled tasks while no
 * terminal is open.
 *
 * "Is the host running" is answered by a process lock (`acquireProcessLock` in
 * the SDK): the host holds a listening socket named after the Scream home for
 * as long as it lives, and the operating system releases it when the process
 * dies, however it dies. Asking the socket also returns the holder's pid and
 * run id, so no file has to be trusted and no pid has to be guessed at — the
 * pidfile this replaces could not tell a live daemon from an unrelated process
 * that inherited its pid, least of all on Windows.
 *
 * Requests go through the same socket and carry the home's control token
 * (`<home>/run/control.token`, readable only by its owner): `stop` makes the
 * host run its own graceful shutdown, which lets the turn in flight finish (a
 * signal cannot do that on Windows, where SIGTERM ends a process at once);
 * `sweep` makes it look for work to continue now rather than at its next
 * check. A host that does not answer a stop, or does not finish within its own
 * grace window, is killed.
 *
 * Releases before the lock existed ran the channel daemon with a pidfile
 * (`line/daemon.pid`); a daemon of that kind, still running after an upgrade,
 * is found and stopped through it so that two processes never poll one chat.
 */

import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, open, readFile, rm, stat, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { t } from '@scream-code/config';
import {
  acquireProcessLock,
  queryProcessLock,
  readOrCreateControlToken,
  requestProcessLock,
  sessionLockScope,
  type BusyProcessLock,
  type HeldProcessLock,
} from '@scream-code/scream-code-sdk';

import { getLinePidFile } from '#/line/config';
import { getDataDir } from '#/utils/paths';

const execFileAsync = promisify(execFile);

export const HOST_LOCK_NAME = 'host';
/** The host waits this long for the turn in flight before it exits anyway. */
export const HOST_SHUTDOWN_GRACE_MS = 60_000;
/** `stop` waits for the host's own grace window plus this margin before it kills. */
const STOP_MARGIN_MS = 10_000;
const LEGACY_STOP_GRACE_MS = 8_000;
const STOP_POLL_MS = 250;
const START_TIMEOUT_MS = 10_000;
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export interface HostStatus {
  running: boolean;
  pid?: number;
  /** When the running host started (ms since epoch); absent for a legacy daemon. */
  startedAt?: number;
  /** Found through the pidfile of a release that predates the lock. */
  legacy?: boolean;
  /**
   * Whether the running host was launched by the resident service
   * (`SCREAM_CODE_HOST_SERVICE=1`). Absent for hosts that predate the flag.
   */
  service?: boolean;
  /** The build the running host loaded; absent for hosts that predate the flag. */
  version?: string;
}

export function getHostDir(): string {
  return join(getDataDir(), 'host');
}

export function getHostLogFile(): string {
  return join(getHostDir(), 'host.log');
}

/**
 * The lock scope: the same derivation the core uses for every lock of this
 * home (the session locks, the jobs store, the agent's "is the host running"
 * check), so all of them look at one address.
 */
function lockScope(): string {
  return sessionLockScope(getDataDir());
}

function lockOptions(): { scope: string; name: string } {
  return { scope: lockScope(), name: HOST_LOCK_NAME };
}

function controlToken(): string {
  return readOrCreateControlToken(getDataDir());
}

/**
 * Take the host lock for this process, or learn that another host holds it.
 * On success a legacy pidfile is removed.
 */
export async function claimHostLock(
  info: Readonly<Record<string, unknown>>,
): Promise<HeldProcessLock | BusyProcessLock> {
  const lock = await acquireProcessLock({ ...lockOptions(), info, token: controlToken() });
  if (lock.held) await rm(getLinePidFile(), { force: true }).catch(() => {});
  return lock;
}

/** Whether the host runs for this Scream home, and its pid. */
export async function readHostStatus(): Promise<HostStatus> {
  const query = await queryProcessLock(lockOptions());
  if (query.held) {
    const info = query.holder?.info;
    return {
      running: true,
      ...(query.holder === undefined ? {} : { pid: query.holder.pid, startedAt: query.holder.startedAt }),
      // Read back what the host stamped when it claimed the lock: whether the
      // service launched it, and which build it loaded. Both absent for hosts
      // older than these flags, which is itself the signal that it is old.
      ...(info?.['service'] === true ? { service: true } : {}),
      ...(typeof info?.['version'] === 'string' ? { version: info['version'] } : {}),
    };
  }
  const legacyPid = await readLegacyPid();
  if (legacyPid !== undefined && (await isLegacyDaemon(legacyPid))) {
    return { running: true, pid: legacyPid, legacy: true };
  }
  // Dead, unrelated or unreadable: the pidfile only misleads from here on.
  await rm(getLinePidFile(), { force: true }).catch(() => {});
  return { running: false };
}

/**
 * Ask the running host to look for work to continue now (after a terminal
 * handed it a session, say). Resolves false when no host answered.
 */
export async function wakeHost(): Promise<boolean> {
  const reply = (await requestProcessLock(lockOptions(), { type: 'sweep', token: controlToken() })) as
    | { ok?: boolean }
    | undefined;
  return reply?.ok === true;
}

export interface HostSessionPeek {
  readonly title?: string | undefined;
  readonly running: boolean;
  readonly lastReply: string;
  readonly goal?: { readonly objective: string; readonly status: string } | undefined;
}

/**
 * What the running host is doing in a session it has open, without taking it
 * over ("just watch"). Undefined when no host answered or it does not have
 * the session open.
 */
export async function peekHostSession(sessionId: string): Promise<HostSessionPeek | undefined> {
  const reply = (await requestProcessLock(lockOptions(), { type: 'peek', sessionId, token: controlToken() })) as
    | (HostSessionPeek & { ok?: boolean })
    | undefined;
  return reply?.ok === true ? reply : undefined;
}

/** Start the host detached; no-op when it already runs. */
export async function startHostDetached(): Promise<{ pid: number; alreadyRunning: boolean }> {
  const status = await readHostStatus();
  if (status.running && status.pid !== undefined) {
    return { pid: status.pid, alreadyRunning: true };
  }
  await rotateHostLogIfNeeded();
  const entry = process.argv[1];
  if (!entry) {
    throw new Error(t('host.err.no_entry'));
  }
  // The log target may not exist yet (fresh install): create its directory
  // before opening the fd.
  await mkdir(dirname(getHostLogFile()), { recursive: true });
  const logFd = await open(getHostLogFile(), 'a');
  try {
    // Reproduce the current runtime (dev tsx loader flags included via
    // execArgv; empty in the bundled dist) so the child runs the same path.
    const child = spawn(process.execPath, [...process.execArgv, entry, 'host'], {
      detached: true,
      // A detached child gets a console window of its own on Windows unless
      // it is hidden; the host has nothing to show there.
      windowsHide: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      env: { ...process.env, SCREAM_CODE_HOST: '1' },
    });
    child.unref();
    if (typeof child.pid !== 'number') {
      throw new TypeError(t('host.err.no_pid'));
    }
    // The host takes the lock itself on boot. Wait briefly so the caller can
    // verify startup; if another host won a concurrent start, report that one.
    const holder = await waitForHolder(START_TIMEOUT_MS);
    if (holder === undefined) {
      throw new Error(t('host.err.start_timeout', { seconds: String(START_TIMEOUT_MS / 1000), log: getHostLogFile() }));
    }
    return { pid: holder, alreadyRunning: holder !== child.pid };
  } finally {
    // spawn dup(2)-ed the fd into the child before returning; closing our
    // copy is safe.
    await logFd.close().catch(() => {});
  }
}

/**
 * After scream itself was updated: a running host still runs the old code, so
 * restart it in a process of its own (`scream host restart`) — the caller may
 * be about to exit, and a graceful stop can take up to a minute.
 */
export async function restartHostInBackground(): Promise<boolean> {
  if (!(await readHostStatus()).running) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  const child = spawn(process.execPath, [...process.execArgv, entry, 'host', 'restart'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  return true;
}

/**
 * Stop a running host; returns false when none was running.
 *
 * Asks the host to shut down (it lets the turn in flight finish, up to its own
 * grace window), waits for the lock to come free, and kills it only when it
 * did not answer or did not finish in time.
 */
export async function stopHost(options: { readonly onWaiting?: () => void } = {}): Promise<boolean> {
  const query = await queryProcessLock(lockOptions());
  if (!query.held) return stopLegacyDaemon();

  const reply = (await requestProcessLock(lockOptions(), { type: 'stop', token: controlToken() })) as
    | { ok?: boolean }
    | undefined;
  const asked = reply?.ok === true;
  if (asked) options.onWaiting?.();
  const deadline = Date.now() + (asked ? HOST_SHUTDOWN_GRACE_MS + STOP_MARGIN_MS : 0);
  while (Date.now() < deadline) {
    if (!(await queryProcessLock(lockOptions())).held) return true;
    await sleep(STOP_POLL_MS);
  }
  // Not answering, or past its grace window: kill the process that holds the
  // lock right now (asked again, so a pid handed to another process meanwhile
  // is never the one killed).
  const current = await queryProcessLock(lockOptions());
  if (!current.held) return true;
  const pid = current.holder?.pid;
  if (pid !== undefined && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return true;
}

/**
 * Keep `host.log` bounded while the host runs. The host writes through an
 * append-mode descriptor its parent opened, so the file is copied to
 * `host.log.1` and truncated in place: an append-mode writer continues at the
 * new end, and nothing has to reopen the file (a rename would leave the host
 * writing into the rotated copy, and Windows refuses to rename an open file).
 * Lines written between the copy and the truncate are lost; at 5 MB per
 * rotation that is a few lines at most.
 */
export async function rotateHostLogIfNeeded(limitBytes: number = LOG_ROTATE_BYTES): Promise<boolean> {
  const log = getHostLogFile();
  try {
    const info = await stat(log);
    if (info.size < limitBytes) return false;
    await copyFile(log, `${log}.1`);
    await truncate(log, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Legacy pidfile (releases before the lock) ───────────────────────────

async function readLegacyPid(): Promise<number | undefined> {
  let raw: string;
  try {
    raw = (await readFile(getLinePidFile(), 'utf-8')).trim();
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Whether `pid` is a scream daemon process. `kill(pid, 0)` only says a process
 * exists, so the command line (POSIX) or image name (Windows) is checked too;
 * when neither can be read, the pid is not trusted.
 */
async function isLegacyDaemon(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
        { timeout: 5_000, windowsHide: true },
      );
      const image = stdout.trim().toLowerCase();
      return image.includes('node') || image.includes('scream');
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 3_000,
    });
    const commandLine = stdout.trim().toLowerCase();
    return commandLine.includes('node') || commandLine.includes('scream');
  } catch {
    return false;
  }
}

async function stopLegacyDaemon(): Promise<boolean> {
  const pid = await readLegacyPid();
  if (pid === undefined || !(await isLegacyDaemon(pid))) {
    await rm(getLinePidFile(), { force: true }).catch(() => {});
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    await rm(getLinePidFile(), { force: true }).catch(() => {});
    return true;
  }
  const deadline = Date.now() + LEGACY_STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!(await isLegacyDaemon(pid))) break;
    await sleep(STOP_POLL_MS);
  }
  if (await isLegacyDaemon(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await rm(getLinePidFile(), { force: true }).catch(() => {});
  return true;
}

// ─── Internals ────────────────────────────────────────────────────────────

/** The pid of the host holding the lock, once one does. */
async function waitForHolder(timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const query = await queryProcessLock(lockOptions());
    if (query.held && query.holder !== undefined) return query.holder.pid;
    await sleep(100);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
