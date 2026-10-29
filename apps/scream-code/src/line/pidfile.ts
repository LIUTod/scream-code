/**
 * Line daemon lifecycle via a pidfile (`~/.scream-code/line/daemon.pid`).
 *
 * P1 design: the daemon is a detached node process (works on macOS/Linux/
 * Windows without launchd/systemd/schtasks). The daemon itself claims the
 * pidfile with O_EXCL on boot; a stale pidfile (dead pid, or a pid reused by
 * an unrelated process) is cleaned up on the next check. OS-level autostart
 * (launchd/schtasks, ported from the reference `daemon/`) is P2.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import { getLineDir, getLineLogFile, getLinePidFile } from './config';

const execFileAsync = promisify(execFile);

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const STOP_GRACE_MS = 8_000;
const STOP_POLL_MS = 250;
const START_TIMEOUT_MS = 10_000;

export interface LineDaemonStatus {
  running: boolean;
  pid?: number;
  /** Set when a pidfile existed but the pid is dead or unrelated. */
  stale?: boolean;
}

/** Read the pidfile and check whether that process is a live line daemon. */
export async function readLineDaemonStatus(): Promise<LineDaemonStatus> {
  let raw: string;
  try {
    raw = (await readFile(getLinePidFile(), 'utf-8')).trim();
  } catch {
    return { running: false };
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    await rm(getLinePidFile(), { force: true }).catch(() => {});
    return { running: false, stale: true };
  }
  if (await isProcessAlive(pid)) {
    return { running: true, pid };
  }
  await rm(getLinePidFile(), { force: true }).catch(() => {});
  return { running: false, pid, stale: true };
}

/** Start the daemon detached; no-op when it already runs. */
export async function startLineDaemonDetached(): Promise<{ pid: number; alreadyRunning: boolean }> {
  const status = await readLineDaemonStatus();
  if (status.running && status.pid) {
    return { pid: status.pid, alreadyRunning: true };
  }
  await rotateLogIfNeeded();
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('无法确定 scream 入口文件，无法拉起 line 守护进程');
  }
  // The log target lives under the line dir; it may not exist yet (fresh
  // install or after an uninstall) — create it before opening the fd.
  await mkdir(getLineDir(), { recursive: true });
  const logFd = await open(getLineLogFile(), 'a');
  try {
    // Reproduce the current runtime (dev tsx loader flags included via
    // execArgv; empty in the bundled dist) so the child runs the same path.
    const child = spawn(process.execPath, [...process.execArgv, entry, 'line'], {
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      env: { ...process.env, SCREAM_CODE_LINE_DAEMON: '1' },
    });
    child.unref();
    if (typeof child.pid !== 'number') {
      throw new TypeError('line 守护进程拉起失败（未获得 pid）');
    }
    // The daemon writes its own pidfile on boot (O_EXCL — pre-writing here
    // would race with it). Wait briefly so the caller can verify startup. If
    // the wait times out but SOME daemon is running (a concurrent start won
    // the race and our child exited with "already running"), report that
    // instead of a confusing startup failure.
    try {
      await waitForPidfile(child.pid);
    } catch (error) {
      const current = await readLineDaemonStatus();
      if (current.running && current.pid !== undefined) {
        return { pid: current.pid, alreadyRunning: true };
      }
      throw error;
    }
    return { pid: child.pid, alreadyRunning: false };
  } finally {
    // spawn dup(2)-ed the fd into the child before returning; closing our
    // copy is safe.
    await logFd.close().catch(() => {});
  }
}

/** Stop a running daemon; returns false when it was not running. */
export async function stopLineDaemon(): Promise<boolean> {
  const status = await readLineDaemonStatus();
  if (!status.running || status.pid === undefined) {
    await rm(getLinePidFile(), { force: true }).catch(() => {});
    return false;
  }
  const pid = status.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    await rm(getLinePidFile(), { force: true }).catch(() => {});
    return true;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) {
      await rm(getLinePidFile(), { force: true }).catch(() => {});
      return true;
    }
    await sleep(STOP_POLL_MS);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await rm(getLinePidFile(), { force: true }).catch(() => {});
  return true;
}

// ─── Internals ────────────────────────────────────────────────────────────

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // exists, owned by another user
    return false; // ESRCH — no such process
  }
  // PID reuse guard: the pid is alive, but is it a line daemon? Match the full
  // command line (works on every POSIX platform; `comm` is kernel-truncated
  // and varies between environments). kill(0) stays the primary signal — an
  // unavailable `ps` must not turn a live daemon into a "dead" one.
  if (process.platform === 'win32') return true;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 3_000,
    });
    const commandLine = stdout.trim().toLowerCase();
    if (commandLine === '') return true;
    return commandLine.includes('node') || commandLine.includes('scream');
  } catch {
    return true; // `ps` unavailable — trust kill(0)
  }
}

async function rotateLogIfNeeded(): Promise<void> {
  const log = getLineLogFile();
  try {
    const info = await stat(log);
    if (info.size >= LOG_ROTATE_BYTES) {
      await rename(log, `${log}.1`).catch(() => {});
    }
  } catch {
    // no log yet
  }
}

async function waitForPidfile(pid: number): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const raw = (await readFile(getLinePidFile(), 'utf-8')).trim();
      if (raw === String(pid)) return;
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new Error(
    `line 守护进程未在 ${START_TIMEOUT_MS / 1000}s 内完成启动，请查看日志：~/.scream-code/line/daemon.log`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
