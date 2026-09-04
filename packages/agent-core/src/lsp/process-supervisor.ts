import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { JianProcess } from '@scream-code/jian';

/** Env var carrying the owning record id into a spawned LSP server. */
export const LSP_OWNER_TOKEN_ENV = 'SCREAM_LSP_OWNER_TOKEN';

/** How often a live owner record's heartbeat is rewritten. */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** Bounded grace for graceful SIGTERM before SIGKILL escalation. */
const STOP_GRACE_MS = 5_000;

const RECORD_VERSION = 1;
const OWNERS_DIR = join('runtime', 'lsp', 'owners');

export interface LspOwnerRecordEntry {
  readonly pid: number;
  readonly workspaceRoot: string;
  /** Command-name fingerprint used to positively identify the process at recovery. */
  readonly commandFingerprint: string;
  readonly launchedAt: string;
}

export interface LspOwnerRecord {
  readonly version: number;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly hostPid: number;
  /** Host process start identity (ps lstart); guards against PID reuse. */
  readonly hostStartFingerprint: string | null;
  readonly createdAt: string;
  readonly heartbeatAt: string;
  readonly entries: readonly LspOwnerRecordEntry[];
}

/** Injectable process-inspection seam (tests substitute a fake). */
export interface LspProcessOps {
  isAlive(pid: number): boolean;
  /** Returns null when the platform cannot inspect (fail-closed). */
  psInfo(pid: number): { readonly ppid: number | null; readonly command: string | null } | null;
  /** Host process start identity; null when unreadable. */
  hostStartFingerprint(pid: number): string | null;
  /** Synchronously signal the whole process group of `pid`. True = done/not found. */
  killGroupSync(pid: number): boolean;
  /** True when cross-process inspection (ps) is available on this platform. */
  psSupported(): boolean;
  /** Linux-only: verify the process carries the owner token via /proc environ. */
  envTokenMatches(pid: number, ownerId: string): boolean | undefined;
}

/** Real `ps`-based inspection. Fail-closed when ps is unavailable or errors. */
class PsProcessOps implements LspProcessOps {
  isAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  psInfo(pid: number): { readonly ppid: number | null; readonly command: string | null } | null {
    const line = psLine(pid);
    if (line === null) return null;
    // Output shape: "<pid> <ppid> <command...>"
    const parts = line.trim().split(/\s+/);
    const ppid = Number(parts[1] ?? NaN);
    return {
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
      command: parts.length > 2 ? parts.slice(2).join(' ') : null,
    };
  }

  hostStartFingerprint(pid: number): string | null {
    if (process.platform === 'win32') return null;
    try {
      const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 3_000,
      });
      if (result.status !== 0) return null;
      const line = result.stdout.trim();
      return line.length > 0 ? line : null;
    } catch {
      return null;
    }
  }

  killGroupSync(pid: number): boolean {
    if (pid <= 0) return true;
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        timeout: 5_000,
      });
      return result.status === 0 || result.status === 128; // 128 = not found
    }
    try {
      process.kill(-pid, 'SIGKILL');
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true; // Already gone.
      if (code === 'EPERM') {
        try {
          process.kill(pid, 'SIGKILL');
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  psSupported(): boolean {
    return process.platform !== 'win32';
  }

  envTokenMatches(pid: number, ownerId: string): boolean | undefined {
    if (process.platform !== 'linux') return undefined;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8');
      return env.split('\0').includes(`${LSP_OWNER_TOKEN_ENV}=${ownerId}`);
    } catch {
      return undefined; // Unreadable — skip the check rather than fail closed.
    }
  }
}

function psLine(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3_000,
    });
    if (result.status !== 0) return null;
    const line = result.stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** A registered, live LSP process tracked by one supervisor. */
interface TrackedProcess {
  readonly proc: JianProcess;
  readonly pid: number;
  readonly workspaceRoot: string;
  readonly commandFingerprint: string;
  readonly launchedAt: string;
}

/**
 * Session-scoped owner of LSP child processes.
 *
 * Responsibilities:
 * - Track every LSP process spawned on behalf of this runtime (exact PIDs).
 * - Persist an owner record with a heartbeat so a later startup can tell a
 *   crashed host's orphans from processes that still belong to a live host.
 * - Provide a synchronous `killAllSync()` used by the process-wide exit hooks.
 * - Recover stale owner records at startup, killing only processes that pass
 *   strict identity checks (reparented away from the recorded host AND command
 *   fingerprint match). Never scans or kills by process name.
 *
 * The module-level hook coordinator is reference-counted: hooks are installed
 * when the first supervisor starts tracking a process and removed when the
 * last one releases everything (so tests don't leak listeners).
 */
export class LspProcessSupervisor {
  readonly ownerId: string = randomUUID();
  private readonly entries = new Map<number, TrackedProcess>();
  private readonly ops: LspProcessOps;
  private readonly sessionId: string;
  private readonly ownersDir: string | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private recoveryPromise: Promise<void> | undefined;
  private disposed = false;
  private readonly installHooks: boolean;

  constructor(options: {
    readonly screamHomeDir?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly ops?: LspProcessOps | undefined;
    readonly installProcessHooks?: boolean | undefined;
  }) {
    this.sessionId = options.sessionId ?? 'unknown';
    this.ops = options.ops ?? new PsProcessOps();
    this.ownersDir =
      options.screamHomeDir !== undefined ? join(options.screamHomeDir, OWNERS_DIR) : undefined;
    this.installHooks = options.installProcessHooks ?? true;
    if (this.installHooks) {
      installProcessHooks();
    }
  }

  /** Awaitable so the first register waits out a startup recovery sweep. */
  get recoveryReady(): Promise<void> {
    this.recoveryPromise ??= this.runRecovery();
    return this.recoveryPromise;
  }

  /** Reap stale owner records from previous runs. Idempotent; never throws. */
  async recoverStaleOwners(): Promise<void> {
    await this.recoveryReady;
  }

  private async runRecovery(): Promise<void> {
    if (!this.ops.psSupported() || this.ownersDir === undefined || !existsSync(this.ownersDir)) {
      return;
    }
    let names: string[];
    try {
      names = readdirSync(this.ownersDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue; // Skip tmp/reaping claim files.
      const path = join(this.ownersDir, name);
      let record: LspOwnerRecord;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as LspOwnerRecord;
        if (parsed.version !== RECORD_VERSION || !Array.isArray(parsed.entries)) continue;
        record = parsed;
      } catch {
        continue; // Malformed — fail closed, leave the file alone.
      }
      if (record.hostPid === process.pid) {
        // Usually our own live record — but a recycled PID could equal a
        // crashed host's PID (rare). Verify the start fingerprint before
        // trusting the skip; a mismatch means the record is stale and its
        // orphans should still be reaped.
        const fingerprint = this.ops.hostStartFingerprint(process.pid);
        if (
          record.hostStartFingerprint !== null &&
          fingerprint !== null &&
          fingerprint === record.hostStartFingerprint
        ) {
          continue; // Genuinely our own record.
        }
      }
      await this.reapRecord(path, record);
    }
  }

  private async reapRecord(path: string, record: LspOwnerRecord): Promise<void> {
    // Claim the record atomically so a concurrent starter can't reap it twice.
    const claimPath = `${path}.reaping.${randomUUID()}`;
    try {
      renameSync(path, claimPath);
    } catch {
      return; // Someone else claimed (or the file vanished).
    }
    const remaining: LspOwnerRecordEntry[] = [];
    for (const entry of record.entries) {
      if (!this.ops.isAlive(entry.pid)) continue; // Dead — drop silently.
      const info = this.ops.psInfo(entry.pid);
      if (info === null) {
        remaining.push(entry); // Uninspectable — fail closed, keep the record.
        continue;
      }
      const stillWithHost = info.ppid === record.hostPid;
      if (stillWithHost) {
        // Host still owns it. Double-check the host identity didn't get
        // recycled (PID reuse): keep the entry when the start fingerprint
        // matches. When it does NOT match (or is unavailable) the identity is
        // ambiguous — the entry could be a live child of a process that
        // merely recycled the recorded pid, so fail closed and never kill.
        const fingerprint = this.ops.hostStartFingerprint(record.hostPid);
        if (
          record.hostStartFingerprint !== null &&
          fingerprint !== null &&
          fingerprint === record.hostStartFingerprint
        ) {
          remaining.push(entry); // Live host, verified — keep.
        } else {
          remaining.push(entry); // Ambiguous identity — fail closed, keep.
        }
        continue;
      }
      // Orphan (reparented away from the recorded host) or host identity
      // cannot be confirmed: kill only when the command fingerprint matches.
      const commandMatches =
        info.command !== null && info.command.includes(entry.commandFingerprint);
      const tokenOk = this.ops.envTokenMatches(entry.pid, record.ownerId);
      if (commandMatches && tokenOk !== false) {
        this.ops.killGroupSync(entry.pid);
      } else {
        remaining.push(entry); // PID reuse / unknown identity — never kill.
      }
    }
    if (remaining.length === 0) {
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone.
      }
      return;
    }
    // Live entries remain — restore the record (best effort) or drop the claim.
    try {
      renameSync(claimPath, join(this.ownersDir ?? '', `${record.ownerId}.json`));
    } catch {
      try {
        unlinkSync(claimPath);
      } catch {
        // Ignore.
      }
    }
  }

  /**
   * Register a freshly spawned LSP process. Called synchronously right after
   * spawn so the exit hooks and owner record are in place before the LSP
   * handshake begins.
   */
  register(proc: JianProcess, workspaceRoot: string, commandFingerprint: string): void {
    if (this.disposed || proc.pid <= 0) return;
    if (this.entries.has(proc.pid)) return;
    const entry: TrackedProcess = {
      proc,
      pid: proc.pid,
      workspaceRoot,
      commandFingerprint,
      launchedAt: new Date().toISOString(),
    };
    this.entries.set(proc.pid, entry);
    activeSupervisors.add(this);
    if (this.installHooks) {
      installProcessHooks();
    }
    this.ensureHeartbeat();
    this.writeRecord();
    // Natural exit (server quit on its own, killed externally, …): release
    // the ownership entry so nothing leaks and hooks detach when idle.
    void proc
      .wait()
      .then(() => this.unregister(proc.pid))
      .catch(() => this.unregister(proc.pid));
  }

  /** Release an entry. Idempotent. */
  unregister(pid: number): void {
    if (!this.entries.delete(pid)) return;
    if (this.entries.size === 0) {
      this.stopHeartbeat();
      this.deleteRecord();
      activeSupervisors.delete(this);
      uninstallProcessHooks();
    } else {
      this.writeRecord();
    }
  }

  /** Bounded graceful shutdown of every tracked process group. */
  async stopAll(): Promise<void> {
    const procs = Array.from(this.entries.values(), (entry) => entry.proc);
    for (const proc of procs) {
      const pid = proc.pid;
      try {
        await proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      try {
        await Promise.race([proc.wait(), sleep(STOP_GRACE_MS)]);
      } catch {
        // Ignore wait failures.
      }
      if (proc.exitCode === null) {
        try {
          await proc.kill('SIGKILL');
        } catch {
          // Ignore.
        }
      }
      this.unregister(pid);
    }
  }

  /** Synchronous hard kill of every tracked group — for exit-path hooks only. */
  killAllSync(): void {
    for (const entry of this.entries.values()) {
      this.ops.killGroupSync(entry.pid);
    }
    this.entries.clear();
    this.stopHeartbeat();
    this.deleteRecord();
    activeSupervisors.delete(this);
    uninstallProcessHooks();
  }

  /** Stop heartbeats and release everything (session teardown). */
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.stopHeartbeat();
    this.deleteRecord();
    activeSupervisors.delete(this);
    uninstallProcessHooks();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.entries.size > 0) this.writeRecord();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private writeRecord(): void {
    if (this.ownersDir === undefined || this.entries.size === 0) return;
    try {
      mkdirSync(this.ownersDir, { recursive: true, mode: 0o700 });
    } catch {
      return; // Read-only home etc. — ownership is still tracked in memory.
    }
    const record: LspOwnerRecord = {
      version: RECORD_VERSION,
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      hostPid: process.pid,
      hostStartFingerprint: this.ops.hostStartFingerprint(process.pid),
      createdAt: this.createdAt,
      heartbeatAt: new Date().toISOString(),
      entries: Array.from(this.entries.values(), (entry) => ({
        pid: entry.pid,
        workspaceRoot: entry.workspaceRoot,
        commandFingerprint: entry.commandFingerprint,
        launchedAt: entry.launchedAt,
      })),
    };
    const target = join(this.ownersDir, `${this.ownerId}.json`);
    const tmp = join(this.ownersDir, `.${this.ownerId}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      fchmodSync(fd, 0o600);
      writeSync(fd, JSON.stringify(record, null, 2));
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, target);
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore.
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // Ignore.
      }
    }
  }

  private deleteRecord(): void {
    if (this.ownersDir === undefined) return;
    try {
      unlinkSync(join(this.ownersDir, `${this.ownerId}.json`));
    } catch {
      // Already gone / never written.
    }
  }

  private readonly createdAt = new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── Process-wide hook coordinator ────────────────────────────────────────────

const activeSupervisors = new Set<LspProcessSupervisor>();
let hooksInstalled = false;

const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

function installProcessHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', onProcessExit);
  process.on('uncaughtExceptionMonitor', onFatalError);
  for (const signal of SIGNALS) {
    // Only take over a signal the host hasn't bound yet. If the host installs
    // its own handler later, ours still runs (prepend) and re-raises the
    // signal so the host's exit path also gets to run.
    if (process.listenerCount(signal) === 0) {
      process.prependListener(signal, onSignal);
    }
  }
}

function uninstallProcessHooks(): void {
  if (!hooksInstalled || activeSupervisors.size > 0) return;
  hooksInstalled = false;
  process.removeListener('exit', onProcessExit);
  process.removeListener('uncaughtExceptionMonitor', onFatalError);
  for (const signal of SIGNALS) {
    process.removeListener(signal, onSignal);
  }
}

function onProcessExit(): void {
  for (const supervisor of activeSupervisors) {
    supervisor.killAllSync();
  }
}

function onFatalError(): void {
  // Runs before the default uncaught-exception handling, so orphaned LSP
  // children are reaped even when the process is about to die. Does not
  // change the exception semantics (the default handler still runs).
  for (const supervisor of activeSupervisors) {
    supervisor.killAllSync();
  }
}

function onSignal(signal: NodeJS.Signals): void {
  for (const supervisor of activeSupervisors) {
    supervisor.killAllSync();
  }
  process.removeListener(signal, onSignal);
  // Re-raise so the process exits with the conventional 128+signal status.
  process.kill(process.pid, signal);
}
