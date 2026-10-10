/**
 * BackgroundProcessManager — manages background shell processes.
 *
 * Tracks background bash tasks spawned by `BashTool` when
 * `run_in_background=true`.
 *
 * Each task gets a unique ID, captures stdout+stderr to a ring buffer,
 * and supports status query / output retrieval / stop operations.
 *
 * Accepts `JianProcess` (not `ChildProcess`) so there is no unsafe cast
 * at the BashTool call site. Lifecycle detection uses `wait()` instead
 * of EventEmitter `on('exit')`.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { JianProcess } from '@scream-code/jian';

import { isAbortError } from '../../loop/errors';
import {
  appendTaskOutput,
  listTasks,
  readTaskOutput,
  readTaskOutputBytes,
  removeTask,
  taskOutputExists,
  taskOutputExistsSync,
  taskOutputFile,
  taskOutputSizeBytes,
  writeTask,
  type PersistedTask,
} from './persist';

// ── Types ────────────────────────────────────────────────────────────

/**
 * `'lost'` is a reconcile-only terminal state. Tasks loaded from disk
 * that were marked `running` at startup but have no live JianProcess
 * (the previous CLI process died) are reclassified as lost.
 */
export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

/** Terminal states tasks never leave once reached. */
const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'killed',
  'lost',
]);

export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Task kinds with distinct id prefixes. */
export type BackgroundTaskKind = 'bash' | 'agent';

/** Lifecycle phases observed by `onLifecycle` subscribers. */
export type BackgroundLifecycleEvent = 'started' | 'updated' | 'terminated';

export interface BackgroundTaskInfo {
  readonly taskId: string;
  readonly command: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** True when an agent task was aborted by its deadline. */
  readonly timedOut?: boolean | undefined;
  /** Reason recorded when a task is explicitly stopped. */
  readonly stopReason?: string | undefined;
  /**
   * Deadline (ms) supplied to `registerAgentTask`. Surfaced so shutdown
   * wait-caps and UI can read the originally-requested timeout without
   * round-tripping the call site. `undefined` means no deadline.
   */
  readonly timeoutMs?: number | undefined;
  /** Identifier of the spawned subagent (agent tasks only). */
  readonly agentId?: string | undefined;
  /** Profile name of the spawned subagent (agent tasks only). */
  readonly subagentType?: string | undefined;
  /**
   * Human-readable reason recorded when a non-terminal task is reclassified
   * via reconcile (e.g. "Task had no live process when the session was
   * restored"). Deliberately not a staleness/TTL check: a ghost is
   * reclassified because no process owns its exit anymore, never because a
   * heartbeat aged out (see `markLoadedTasksLost`).
   */
  readonly failureReason?: string | undefined;
}

interface ManagedProcess {
  readonly taskId: string;
  readonly command: string;
  readonly description: string;
  readonly proc: JianProcess;
  readonly outputChunks: string[];
  /** Total UTF-8 bytes observed, including chunks dropped from the live ring buffer. */
  outputSizeBytes: number;
  /** UTF-8 bytes currently held in `outputChunks` (never above `MAX_OUTPUT_BYTES`). */
  outputRingBytes: number;
  /**
   * True when the caller owns the process streams and forwards what it
   * captures through `appendCapturedOutput` (a parked foreground command)
   * instead of the manager attaching its own stdout/stderr listeners.
   */
  externalStreams?: boolean | undefined;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  readonly startedAt: number;
  endedAt: number | null;
  /** Listeners awaiting task completion. */
  readonly waiters: Array<() => void>;
  /** True once `fireTerminalCallbacks` has already run. */
  terminalFired: boolean;
  /** Set when a deadline fires before natural completion. */
  timedOut?: boolean | undefined;
  /** Reason recorded when a task is explicitly stopped. */
  stopReason?: string | undefined;
  /** Deadline supplied at registration; surfaced via task info. */
  timeoutMs?: number | undefined;
  /** Subagent identifier (agent tasks only). */
  agentId?: string | undefined;
  /** Subagent profile name (agent tasks only). */
  subagentType?: string | undefined;
  /** Non-terminal-reclassification reason (e.g. no live process at restore; see `markLoadedTasksLost`). */
  failureReason?: string | undefined;
  /** True after stop() has requested cancellation but before terminal status is chosen. */
  stopRequested: boolean;
  /** Session dir captured at registration for output.log writes. */
  readonly outputSessionDir?: string | undefined;
  lifecyclePromise: Promise<void>;
  persistWriteQueue: Promise<void>;
  outputWriteQueue: Promise<void>;
}

/**
 * Slim terminal record kept after `finalizeTerminal` evicts the live
 * `ManagedProcess`. Deliberately drops `proc` so a finished task cannot pin
 * process streams — the on-disk `output.log` remains the authoritative full
 * log. `outputChunks` is a last-known tail used only when the manager was
 * never attached to a session dir (detached managers).
 */
interface RetiredTask {
  readonly info: BackgroundTaskInfo;
  /**
   * Retained tail chunks (newest output), lazily joined on read. Bounded by
   * `MAX_OUTPUT_BYTES` exactly like the live ring, but stored as chunks so a
   * late post-retirement chunk never rebuilds the whole retained text.
   */
  readonly outputChunks: string[];
  /** UTF-8 byte total of `outputChunks`, maintained incrementally on append. */
  outputTextBytes: number;
  /**
   * Total UTF-8 bytes observed, including chunks dropped from the live ring /
   * the retained tail.
   */
  outputSizeBytes: number;
  readonly outputSessionDir: string | undefined;
  /**
   * The live `output.log` append chain. Deliberately mutable: `'exit'`
   * routinely beats stdio drain, so chunks can keep arriving after the task
   * was retired. Each late chunk republishes the extended queue here so
   * `flushOutput` / `readOutput` await the real tail instead of the snapshot
   * taken at retire time.
   */
  outputWriteQueue: Promise<void>;
}

/**
 * Maximum bytes of combined output kept in the in-memory ring buffer per
 * task — applies to the live ring AND to the retired record's retained tail.
 * When exceeded, the oldest chunks are dropped.
 *
 * The ring buffer is a lightweight tail intended for the `/tasks` UI and
 * terminal notifications only — it deliberately discards old output to
 * cap memory. It is NOT the authoritative full output: the complete,
 * never-truncated log lives on disk at `<sessionDir>/tasks/<id>/output.log`.
 * Callers that need the full output (e.g. `TaskOutput`) must read the
 * disk log via `getOutputSizeBytes` / `readOutputBytesFromDisk`.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

/**
 * How many terminal tasks stay addressable after eviction from `processes`.
 * The full output is on disk (`output.log`); the ring only keeps the metadata
 * needed to answer `getTask` / `getOutput` / `readOutput` for recently
 * finished tasks, FIFO-overflowing so long sessions stay bounded.
 */
const RETIRED_TASK_LIMIT = 20;

/**
 * Pre-cut bytes the bounded window read (`readOutput`) keeps as context for
 * `tailSlice`'s boundary rules, on top of the last `tail` code units it must
 * return. The rules inspect the text before the cut (the nearest ESC, a CSI
 * body run, a string-sequence opener), so a window starting exactly at the cut
 * would decide differently from the whole-file read in `getOutput`. Control
 * sequences in task output sit far closer to the cut than this margin; one
 * opened farther back is invisible to the window and is not worth paging the
 * rest of a multi-megabyte log for.
 */
const TAIL_WINDOW_LOOKBACK_BYTES = 4096;

/** Default SIGTERM→SIGKILL grace; `BackgroundProcessManagerOptions.killGracePeriodMs` overrides it. */
const SIGTERM_GRACE_MS = 5_000;
const EXIT_SETTLE_GRACE_MS = 10;

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate `{prefix}-{8 base36 chars}`.
 *
 * `randomBytes(8) % 36` has a modest modulo bias (256 % 36 = 4) but
 * over an 8-char suffix yields ~36^8 ≈ 2.8e12 distinct ids which is
 * more than enough uniqueness for per-session task ids.
 */
export function generateTaskId(kind: BackgroundTaskKind): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `${kind}-${suffix}`;
}

/**
 * Terminal-state info for tasks reconciled as lost on resume. They
 * have no live JianProcess and no captured output (the buffer died
 * with the previous process), so list/get returns this minimal record.
 */
export interface ReconcileResult {
  /** Task IDs that were marked `lost` because their process is gone. */
  readonly lost: readonly string[];
  /** Snapshot of each lost task's persisted info for terminal notifications. */
  readonly lostInfo: readonly BackgroundTaskInfo[];
}

export interface BackgroundProcessManagerOptions {
  readonly maxRunningTasks?: number;
  /** SIGTERM→SIGKILL grace used by `stop()`; defaults to `SIGTERM_GRACE_MS`. */
  readonly killGracePeriodMs?: number;
  readonly sessionDir?: string;
}

export interface BackgroundTaskReservation {
  release(): void;
}

export interface BackgroundTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

function emptyOutputSnapshot(): BackgroundTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

// ── Manager ──────────────────────────────────────────────────────────

export class BackgroundProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private reservedTaskSlots = 0;
  /**
   * Terminal tasks evicted from `processes`, bounded to
   * `RETIRED_TASK_LIMIT` (FIFO). They stay addressable for `getTask` /
   * output reads (disk-backed) so a just-finished task is still visible.
   */
  private readonly retiredTasks = new Map<string, RetiredTask>();
  /**
   * Ghosts: tasks loaded from disk during reconcile that have no live
   * JianProcess. They appear in `list()` / `getTask()` with status
   * `lost` so users see what was running before the crash/restart.
   */
  private readonly ghosts = new Map<string, BackgroundTaskInfo>();
  /** When set, register/lifecycle changes persist to disk. */
  private sessionDir: string | undefined;

  /**
   * Registered terminal-state callbacks. Fired once per task when the
   * task reaches a terminal state (completed / failed / killed).
   */
  private readonly terminalCallbacks: Array<(info: BackgroundTaskInfo) => void | Promise<void>> =
    [];

  /**
   * Registered lifecycle callbacks. Fired for every observable
   * transition (started / updated / terminated). Errors thrown by
   * callbacks are silently swallowed so the BPM main flow never breaks
   * because of a buggy subscriber.
   */
  private readonly lifecycleCallbacks: Array<
    (event: BackgroundLifecycleEvent, info: BackgroundTaskInfo) => void
  > = [];

  constructor(private readonly options: BackgroundProcessManagerOptions = {}) {
    this.sessionDir = options.sessionDir;
  }

  /**
   * Register a callback that fires when any task reaches a terminal
   * state. The callback receives the task's `BackgroundTaskInfo`
   * snapshot. Multiple callbacks may be registered; they are invoked in
   * registration order. Errors thrown by callbacks are silently swallowed.
   */
  onTerminal(callback: (info: BackgroundTaskInfo) => void | Promise<void>): void {
    this.terminalCallbacks.push(callback);
  }

  /**
   * Register a callback that fires on every lifecycle transition:
   *   - 'started':    task just registered (either bash or agent)
   *   - 'updated':    in-place state change of a non-terminal task;
   *                   nothing emits it today (no non-terminal state has a
   *                   producer), kept in the lifecycle contract for
   *                   subscribers that switch on it
   *   - 'terminated': task reached a terminal state (also triggers
   *                   onTerminal); fires exactly once per task.
   *
   * Synchronous callback. Errors are swallowed so the BPM lifecycle
   * machinery (status updates, persistence, waiters) cannot be blocked
   * by a buggy subscriber. Use it for fan-out to RPC events; do not put
   * heavy work in it (defer to microtask if needed).
   */
  onLifecycle(callback: (event: BackgroundLifecycleEvent, info: BackgroundTaskInfo) => void): void {
    this.lifecycleCallbacks.push(callback);
  }

  /** Fan out a lifecycle event to subscribers. */
  private fireLifecycle(event: BackgroundLifecycleEvent, info: BackgroundTaskInfo): void {
    for (const cb of this.lifecycleCallbacks) {
      try {
        cb(event, info);
      } catch {
        /* swallow callback errors */
      }
    }
  }

  /**
   * Subclasses can react to live task completion here. Restored disk
   * tasks reconciled as lost do not call this hook.
   */
  protected onLiveTaskTerminal(_info: BackgroundTaskInfo): void | Promise<void> {}

  /**
   * Fire all registered terminal callbacks for a task. Idempotent: the
   * second invocation for the same task is a no-op so `reconcile()` /
   * a lagging `wait()` resolver / a race between `stop()` and natural
   * exit cannot yield duplicate notifications. This is the manager-side
   * half of the dedupe pact with `NotificationManager.dedupe_key`.
   */
  private fireTerminalCallbacks(entry: ManagedProcess): void {
    if (entry.terminalFired) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    try {
      const result = this.onLiveTaskTerminal(info);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      /* swallow */
    }
    this.fireTerminalSubscribers(info);
  }

  private fireTerminalSubscribers(info: BackgroundTaskInfo): void {
    for (const cb of this.terminalCallbacks) {
      try {
        const result = cb(info);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch {
        /* swallow callback errors */
      }
    }
    this.fireLifecycle('terminated', info);
  }

  private resolveWaiters(entry: ManagedProcess): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  assertCanRegister(): void {
    const maxRunningTasks = this.options.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (this.activeTaskCount() + this.reservedTaskSlots < maxRunningTasks) return;
    throw new Error('Too many background tasks are already running.');
  }

  reserveSlot(): BackgroundTaskReservation {
    const maxRunningTasks = this.options.maxRunningTasks;
    if (maxRunningTasks === undefined) {
      return { release: () => {} };
    }
    this.assertCanRegister();
    this.reservedTaskSlots++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reservedTaskSlots--;
      },
    };
  }

  private activeTaskCount(): number {
    let count = 0;
    for (const entry of this.processes.values()) {
      if (!TERMINAL_STATUSES.has(entry.status)) count++;
    }
    return count;
  }

  /**
   * Register a JianProcess as a background task.
   * Starts capturing stdout/stderr and monitors lifecycle via `wait()`.
   * Returns the assigned task ID.
   *
   * `opts.kind` picks the id prefix. Defaults to `'bash'` because bash
   * subprocess registration is the only caller on the process path
   * today; agent tasks go through `registerAgentTask` which forces
   * `'agent'`.
   */
  register(
    proc: JianProcess,
    command: string,
    description: string,
    opts:
      | {
          kind?: BackgroundTaskKind;
          /**
           * Optional shell metadata. Carried so the `/task` UI and the
           * background persist snapshot can surface which dialect a
           * task was launched under. Legacy callers omitting this
           * field keep the implicit 'bash' default.
           */
          shellInfo?: {
            shellName: string;
            shellPath: string;
            cwd: string;
          };
          reservation?: BackgroundTaskReservation;
        }
      | undefined = undefined,
  ): string {
    if (opts?.reservation) {
      opts.reservation.release();
    } else {
      this.assertCanRegister();
    }
    const kind = opts?.kind;
    const taskId = generateTaskId(kind ?? 'bash');
    const entry: ManagedProcess = {
      taskId,
      command,
      description,
      proc,
      outputChunks: [],
      outputSizeBytes: 0,
      outputRingBytes: 0,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      stopRequested: false,
      outputSessionDir: this.sessionDir,
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
    };
    this.processes.set(taskId, entry);

    // Capture stdout + stderr into the ring buffer.
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        this.appendOutput(entry, chunk);
      });
    }

    // Initial persistence (snapshot at start).
    void this.persistLive(entry);
    this.fireLifecycle('started', this.toInfo(entry));

    // Monitor lifecycle via wait() — no EventEmitter dependency.
    entry.lifecyclePromise = proc
      .wait()
      .then((exitCode) => this.settleProcessExit(entry, exitCode))
      .catch(async (_err: unknown) => {
        // When `proc.wait()` rejects (launch failed / stream error),
        // still drive the task through the same terminal finalizer.
        await this.finalizeTerminal(entry, entry.stopRequested ? 'killed' : 'failed', null);
      });
    void entry.lifecyclePromise;

    return taskId;
  }

  /**
   * Adopt a foreground command that outlived its tool timeout.
   *
   * The caller (the Bash tool) has been reading the process streams since
   * spawn and keeps reading them, so this path deliberately does NOT attach
   * the manager's own stdout/stderr capture: the caller forwards what it
   * captures through `appendCapturedOutput`, and `completion` settles the
   * task through the same exit path as a spawned background command.
   * Everything else is the unified background base — a stable id, per-agent
   * capacity, the persisted record, lifecycle events, TaskList/TaskOutput/
   * TaskStop visibility, and the terminal notification that delivers the
   * result back to the agent that parked it (the only delivery channel for
   * a subagent that has no Task tools).
   *
   * Throws when this agent is already at `maxRunningTasks`, exactly like
   * `register()`: the caller owns what happens to a process it cannot park.
   */
  parkForegroundProcess(
    completion: Promise<{ exitCode: number }>,
    command: string,
    description: string,
    handles: {
      /** Caller-side escalation (SIGTERM → grace → SIGKILL). */
      readonly kill: () => Promise<void>;
      readonly pid?: number | undefined;
      /** Output captured before parking; the task's log continues from it. */
      readonly initialOutput?: string | undefined;
    },
  ): string {
    this.assertCanRegister();
    const taskId = generateTaskId('bash');
    const entry: ManagedProcess = {
      taskId,
      command,
      description,
      // Streamless process stand-in: the caller owns the pipes and its kill
      // handle carries the escalation, so `stop()`'s own SIGKILL call is a
      // second chance rather than the primary one. `completion` drives the
      // lifecycle below; the dummy `wait` only satisfies the shape. `exitCode`
      // starts null and is written back when the caller's completion reports
      // the exit, so the handle mirrors the two-step exit of a real process —
      // see the lifecycle chain below.
      proc: {
        stdin: { write: () => false, end: () => {} } as never,
        stdout: { setEncoding: () => {}, on: () => {} } as never,
        stderr: { setEncoding: () => {}, on: () => {} } as never,
        pid: handles.pid ?? 0,
        exitCode: null,
        wait: () => completion.then(({ exitCode }) => exitCode),
        kill: async () => {
          await handles.kill();
        },
      } as unknown as JianProcess,
      outputChunks: [],
      outputSizeBytes: 0,
      outputRingBytes: 0,
      externalStreams: true,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      stopRequested: false,
      outputSessionDir: this.sessionDir,
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
    };
    this.processes.set(taskId, entry);
    if (handles.initialOutput !== undefined && handles.initialOutput.length > 0) {
      this.appendOutput(entry, handles.initialOutput);
    }
    void this.persistLive(entry);
    this.fireLifecycle('started', this.toInfo(entry));

    entry.lifecyclePromise = completion
      // Publish the observed exit on the stand-in handle first, in its own
      // microtask: a real process reports its exit in two steps — the OS
      // 'exit' event makes `proc.exitCode` non-null, then `wait()` resolves
      // and the lifecycle settles — and `observedExitCompletions` selects
      // "just exited" tasks by exactly that non-null `proc.exitCode`. Without
      // this writeback a parked task is invisible to that selector, so a
      // caller settling right as the command exits (TaskOutput / TaskList /
      // TaskStop via `settlePendingExits`) reads the stale `running` instead
      // of waiting the last step out.
      .then(({ exitCode }) => {
        // The stand-in handle is ours: JianProcess types `exitCode` readonly
        // because a real handle's value comes from the OS, and the parked path
        // has no such event — this writeback is its stand-in.
        (entry.proc as { exitCode: number | null }).exitCode = exitCode;
        return exitCode;
      })
      .then((exitCode) => this.settleProcessExit(entry, exitCode))
      .catch(async () => {
        // The caller's completion is the process wait(): a rejection means
        // the wait itself failed, so the task ends unresolved instead of
        // borrowing an exit code that was never observed.
        await this.finalizeTerminal(entry, entry.stopRequested ? 'killed' : 'failed', null);
      });
    void entry.lifecyclePromise;

    return taskId;
  }

  /**
   * Forward output a caller captured for a task it parked
   * (`parkForegroundProcess`). A no-op for every other task: the manager
   * reads its streams itself for those, so appending a caller's copy would
   * duplicate the log.
   */
  appendCapturedOutput(taskId: string, chunk: string): void {
    const entry = this.processes.get(taskId);
    if (entry === undefined || entry.externalStreams !== true) return;
    this.appendOutput(entry, chunk);
  }

  /** Get info about a specific task. Falls back to retired, then reconcile ghosts. */
  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.processes.get(taskId);
    if (entry !== undefined) {
      return this.toInfo(entry);
    }
    const retired = this.retiredTasks.get(taskId);
    if (retired !== undefined) return retired.info;
    return this.ghosts.get(taskId);
  }

  /**
   * Give just-ended processes a short grace period to settle their `wait()`
   * promise, then return with whatever lifecycle state has been finalized.
   */
  async settlePendingExits(): Promise<void> {
    const pendingCompletions = this.observedExitCompletions();
    if (pendingCompletions.length === 0) return;
    await Promise.race([
      Promise.allSettled(pendingCompletions).then(() => {}),
      new Promise<void>((resolve) => {
        setTimeout(resolve, EXIT_SETTLE_GRACE_MS);
      }),
    ]);
  }

  /**
   * List tasks, optionally filtering to active-only.
   *
   * When `activeOnly=false`, includes reconcile ghosts (lost tasks
   * from a prior CLI process) so the user sees what survived the
   * restart. Active-only mode never shows ghosts (they're terminal).
   */
  list(activeOnly = true, limit?: number): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.processes.values()) {
      if (activeOnly && TERMINAL_STATUSES.has(entry.status)) continue;
      result.push(this.toInfo(entry));
      if (limit !== undefined && result.length >= limit) return result;
    }
    if (!activeOnly) {
      for (const retired of this.retiredTasks.values()) {
        result.push(retired.info);
        if (limit !== undefined && result.length >= limit) return result;
      }
      for (const ghost of this.ghosts.values()) {
        result.push(ghost);
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  /**
   * Await all pending `output.log` appends for a task to settle.
   *
   * Output chunks are persisted to disk on an async queue, so a task can
   * reach a terminal state before its final chunks have landed on disk.
   * Callers that read the on-disk log (`getOutputSizeBytes` /
   * `readOutputBytesFromDisk`) should `await flushOutput()` first so they
   * observe the complete log. No-op for unknown/ghost tasks.
   */
  async flushOutput(taskId: string): Promise<void> {
    const entry = this.processes.get(taskId);
    if (entry !== undefined) {
      await entry.outputWriteQueue;
      return;
    }
    const retired = this.retiredTasks.get(taskId);
    if (retired !== undefined) await retired.outputWriteQueue;
  }

  /**
   * Total byte size of a task's full output as stored on disk.
   *
   * Reads `<sessionDir>/tasks/<id>/output.log`, which is the complete,
   * never-truncated log — unlike the in-memory ring buffer it never drops
   * old chunks. Returns 0 when the manager is detached, the task is
   * unknown, or the task has produced no output yet.
   */
  async getOutputSizeBytes(taskId: string): Promise<number> {
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir === undefined) return 0;
    return taskOutputSizeBytes(outputSessionDir, taskId);
  }

  /**
   * Read a byte range of a task's full output from the on-disk log.
   *
   * Reads up to `maxBytes` bytes starting at `offset` of `output.log`,
   * straight from disk so it never loses the head of a large task the way
   * the in-memory ring buffer would. Callers derive `offset` and `maxBytes`
   * from a single `getOutputSizeBytes` snapshot, so the bytes returned stay
   * consistent with the size used for metadata even when a still-running
   * task keeps growing its log. Returns an empty string when the manager
   * is detached, the task is unknown, or the log is absent.
   */
  async readOutputBytesFromDisk(
    taskId: string,
    offset: number,
    maxBytes: number,
  ): Promise<string> {
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir === undefined) return '';
    return readTaskOutputBytes(outputSessionDir, taskId, offset, maxBytes);
  }

  /**
   * Return the output snapshot used by TaskOutput.
   *
   * Persisted logs are preferred when the task was registered with an
   * output session directory and `output.log` has actually been created,
   * because they are the complete, never-truncated source. Detached managers,
   * tasks registered before a session dir was attached, and silent tasks with
   * no persisted log fall back to the live ring buffer.
   */
  async getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<BackgroundTaskOutputSnapshot> {
    if (this.getTask(taskId) === undefined) return emptyOutputSnapshot();

    await this.flushOutput(taskId);

    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir !== undefined && (await taskOutputExists(outputSessionDir, taskId))) {
      const outputSizeBytes = await taskOutputSizeBytes(outputSessionDir, taskId);
      const previewOffset = Math.max(0, outputSizeBytes - previewLimit);
      const previewBytes = outputSizeBytes - previewOffset;
      const preview = await readTaskOutputBytes(
        outputSessionDir,
        taskId,
        previewOffset,
        previewBytes,
      );
      return {
        outputPath: taskOutputFile(outputSessionDir, taskId),
        outputSizeBytes,
        previewBytes,
        truncated: previewOffset > 0,
        fullOutputAvailable: true,
        preview,
      };
    }

    const entry = this.processes.get(taskId);
    const retired = entry === undefined ? this.retiredTasks.get(taskId) : undefined;
    const availableText =
      entry !== undefined ? entry.outputChunks.join('') : (retired?.outputChunks.join('') ?? '');
    const outputSizeBytes = entry !== undefined ? entry.outputSizeBytes : (retired?.outputSizeBytes ?? 0);
    if (entry === undefined && retired === undefined) return emptyOutputSnapshot();

    const available = Buffer.from(availableText, 'utf-8');
    const previewBytes = Math.min(previewLimit, available.byteLength, outputSizeBytes);
    const previewOffset = available.byteLength - previewBytes;
    return {
      outputSizeBytes,
      previewBytes,
      truncated: outputSizeBytes > previewBytes,
      fullOutputAvailable: false,
      preview: available.subarray(previewOffset).toString('utf-8'),
    };
  }

  /** Get the combined output of a task (live ring buffer, else the disk log). */
  getOutput(taskId: string, tail?: number): string {
    const entry = this.processes.get(taskId);
    if (entry) {
      const full = entry.outputChunks.join('');
      if (tail !== undefined && tail < full.length) {
        return tailSlice(full, tail);
      }
      return full;
    }
    // Retired tasks have their chunk array dropped at finalize. The disk log
    // is the authoritative full output (same file `readOutputBytesFromDisk`
    // reads); the retained tail copy covers detached managers with no disk.
    const retired = this.retiredTasks.get(taskId);
    if (retired === undefined) return '';
    let full = retired.outputChunks.join('');
    if (retired.outputSessionDir !== undefined) {
      try {
        const persisted = readFileSync(taskOutputFile(retired.outputSessionDir, taskId), 'utf-8');
        if (persisted.length > 0) full = persisted;
      } catch {
        /* fall back to the retained tail */
      }
    }
    if (tail !== undefined && tail < full.length) return tailSlice(full, tail);
    return full;
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const entry = this.processes.get(taskId);
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir !== undefined) {
      // A retired task has no live ManagedProcess; await the retired record's
      // queue so a late stdio append still in flight is on disk before we read.
      await (entry?.outputWriteQueue ?? this.retiredTasks.get(taskId)?.outputWriteQueue);
      if (tail !== undefined && tail > 0) {
        // Bounded window read: a task's output.log can grow unbounded, so
        // paging a tail must not load the whole file. UTF-8 needs at most 4
        // bytes per code point (+3 slack for a window that starts mid-
        // sequence) to cover the last `tail` code units; the look-back margin
        // on top of that is context only, and buys agreement with the
        // whole-file read in `getOutput` for every control sequence that
        // starts within it. One opened farther back is invisible to the
        // window, so the two reads can then differ in where the head starts
        // (never in whether the newest bytes are returned).
        const size = await taskOutputSizeBytes(outputSessionDir, taskId);
        if (size > 0) {
          const windowBytes = Math.min(size, tail * 4 + 7 + TAIL_WINDOW_LOOKBACK_BYTES);
          const start = size - windowBytes;
          let persisted = await readTaskOutputBytes(outputSessionDir, taskId, start, windowBytes);
          if (persisted.length > 0) {
            if (start > 0) {
              // A window that starts mid-sequence decodes its broken leading
              // bytes as replacement characters (one per broken run; a
              // 3-byte slack can strand at most 3). Strip the run so the
              // result matches the previous whole-file slice exactly.
              let lead = 0;
              while (lead < persisted.length && persisted.codePointAt(lead) === 0xfffd && lead < 3) {
                lead += 1;
              }
              if (lead > 0) persisted = persisted.slice(lead);
            }
            return tail < persisted.length ? tailSlice(persisted, tail) : persisted;
          }
          return this.getOutput(taskId, tail);
        }
      } else {
        const persisted = await readTaskOutput(outputSessionDir, taskId);
        if (persisted.length > 0) {
          return tail !== undefined && tail < persisted.length ? tailSlice(persisted, tail) : persisted;
        }
      }
    }
    return this.getOutput(taskId, tail);
  }

  getOutputPath(taskId: string): string | undefined {
    const outputSessionDir = this.outputSessionDirFor(taskId);
    if (outputSessionDir === undefined) return undefined;
    if (!taskOutputExistsSync(outputSessionDir, taskId)) return undefined;
    return taskOutputFile(outputSessionDir, taskId);
  }

  /** Stop a running task. SIGTERM → configured grace (5s by default) →
   *  SIGKILL. Active-only: a retired/ghost task is a pure no-op read of its
   *  terminal info. */
  async stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.processes.get(taskId);
    if (!entry) {
      return this.retiredTasks.get(taskId)?.info ?? this.ghosts.get(taskId);
    }
    // Normalize at this shared boundary: every public stop path (the TaskStop
    // tool, SDK/RPC) funnels through here, so a blank or whitespace-only
    // reason must never be recorded as an empty stopReason.
    const trimmedReason = reason?.trim();
    const stopReason =
      trimmedReason === undefined || trimmedReason.length === 0 ? undefined : trimmedReason;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    entry.stopRequested = true;
    entry.stopReason = stopReason;

    try {
      await entry.proc.kill('SIGTERM');
    } catch {
      /* process already gone */
    }

    // Wait out the configured grace for the lifecycle path to settle, then
    // SIGKILL. Waiting on lifecyclePromise, rather than proc.wait() directly,
    // lets a natural completion win the race instead of being overwritten.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, this.options.killGracePeriodMs ?? SIGTERM_GRACE_MS);
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (!graceful && entry.proc.exitCode === null) {
      try {
        await entry.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    // Agent tasks whose completion promise never settles (no timeoutMs,
    // or a truly hung coroutine) need an explicit terminal finalize here:
    // such a task is intentionally unbounded until stopped.
    await this.finalizeTerminal(entry, 'killed', null, { stopReason });

    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const taskIds = Array.from(this.processes.values())
      .filter((entry) => !TERMINAL_STATUSES.has(entry.status))
      .map((entry) => entry.taskId);
    const results = await Promise.all(taskIds.map((taskId) => this.stop(taskId, reason)));
    return results.filter((info): info is BackgroundTaskInfo => info !== undefined);
  }

  /**
   * Wait for a task to reach a terminal state.
   * Returns immediately if already terminal. Times out after `timeoutMs`.
   */
  async wait(taskId: string, timeoutMs = 30_000): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.processes.get(taskId);
    if (!entry) {
      return this.retiredTasks.get(taskId)?.info;
    }
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    let terminalWaiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          terminalWaiter = resolve;
          entry.waiters.push(resolve);
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (terminalWaiter !== undefined) {
        const index = entry.waiters.indexOf(terminalWaiter);
        if (index !== -1) entry.waiters.splice(index, 1);
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
    }
    return this.toInfo(entry);
  }

  /**
   * Register a Promise-based agent task (no JianProcess). Used by
   * AgentTool for background subagent dispatch. Agent tasks appear in
   * `list()` / `getTask()` but have pid=0 and empty output.
   *
   * `opts.timeoutMs` wraps the completion in an external deadline. On
   * deadline fire, the task is marked `failed` with `timedOut=true`
   * (distinct from a caller-driven `stop()` which uses `killed`, and
   * distinct from an internal `TimeoutError` rejection which is a
   * generic `failed` with `timedOut` left unset).
   */
  registerAgentTask(
    completion: Promise<{ result: string }>,
    description: string,
    opts: {
      timeoutMs?: number;
      abort?: () => void;
      reservation?: BackgroundTaskReservation;
      /** Subagent identifier; surfaced on task info. */
      agentId?: string;
      /** Subagent profile name; surfaced on task info. */
      subagentType?: string;
    } = {},
  ): string {
    if (opts.reservation) {
      opts.reservation.release();
    } else {
      this.assertCanRegister();
    }
    const taskId = generateTaskId('agent');
    const entry: ManagedProcess = {
      taskId,
      command: `[agent] ${description}`,
      description,
      timeoutMs: opts.timeoutMs,
      // Fall back to defaults that satisfy callers reading these fields
      // without forcing every call site to supply them. The dedicated
      // dispatch path in AgentTool passes the real handle.agentId /
      // handle.profileName.
      agentId: opts.agentId ?? taskId,
      subagentType: opts.subagentType ?? 'agent',
      // Dummy JianProcess — agent tasks are Promise-based, not process-based
      proc: {
        stdin: { write: () => false, end: () => {} } as never,
        stdout: { setEncoding: () => {}, on: () => {} } as never,
        stderr: { setEncoding: () => {}, on: () => {} } as never,
        pid: 0,
        exitCode: null,
        wait: () => completion.then(() => 0),
        kill: async () => {
          opts.abort?.();
        },
      } as unknown as JianProcess,
      outputChunks: [],
      outputSizeBytes: 0,
      outputRingBytes: 0,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
      stopRequested: false,
      outputSessionDir: this.sessionDir,
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
    };
    this.processes.set(taskId, entry);
    void this.persistLive(entry);
    this.fireLifecycle('started', this.toInfo(entry));

    // Deadline symbol distinguishes "external timeout fired" from "the
    // agent promise itself rejected with TimeoutError" (which must
    // remain a generic failure, not a deadline timeout).
    const deadlineTimeout = Symbol('deadline-timeout');
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const raceInputs: Array<Promise<unknown>> = [completion];
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      raceInputs.push(
        new Promise((resolve) => {
          deadlineTimer = setTimeout(() => {
            resolve(deadlineTimeout);
          }, opts.timeoutMs);
        }),
      );
    }

    const settleLifecycle = Promise.race(raceInputs)
      .then(async (outcome) => {
        if (outcome === deadlineTimeout) {
          // External deadline fired before the agent resolved.
          if (TERMINAL_STATUSES.has(entry.status)) return;
          opts.abort?.();
          await this.finalizeTerminal(entry, 'failed', 1, { timedOut: true });
          return;
        }
        // `completion` resolved before deadline.
        const r = outcome as { result: string };
        if (TERMINAL_STATUSES.has(entry.status)) return;
        this.appendOutput(entry, r.result);
        await this.finalizeTerminal(entry, 'completed', 0);
      })
      .catch(async (error: unknown) => {
        // Cancellation is attributed by the abort reason, not only by a
        // BPM-side `stopRequested` latch: a user interrupt (ESC / turn
        // cancel) aborts a background run through its own controller, and a
        // session close stops everything it can reach — neither may be
        // recorded as a failure, because a `failed` agent task advertises
        // Agent(resume=...) on work the user deliberately ended.
        if (isAbortError(error)) {
          await this.finalizeTerminal(entry, 'killed', null);
          return;
        }
        // Runner-initiated cancellation: the background agent runner
        // raises `RunCancelled` to signal "abort this run" (e.g. on a
        // Ctrl+C path with no BPM-side stop()). Map to `killed`
        // because cancellation is not a failure.
        if (error instanceof Error && error.name === 'RunCancelled') {
          await this.finalizeTerminal(entry, 'killed', null);
          return;
        }
        // Anything else is a real failure — including a non-abort error
        // that arrived while `stopRequested` was set, where recording the
        // failure is what keeps the user's cancellation from hiding it.
        // Internal rejection (including TimeoutError, model errors,
        // and stopRequested cases where a non-abort failure won the
        // race): generic failure. `timedOut` stays unset so consumers
        // can distinguish this from a true external deadline.
        await this.finalizeTerminal(entry, 'failed', 1);
      })
      .finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      });

    entry.lifecyclePromise = settleLifecycle;
    void entry.lifecyclePromise;

    return taskId;
  }

  // ── completion event (await lifecycle end) ────────────────────────

  /**
   * Resolve when the task reaches a terminal state. If the task is
   * already terminal, resolves synchronously on the next microtask.
   * Intended for integration code that wants to `await` a specific
   * task's exit without installing a full `onTerminal` subscriber.
   * Returns `undefined` for unknown ids (matching `getTask`). Retired
   * (evicted-but-recently-finished) and ghost (reconciled-lost) entries
   * are already terminal, so they resolve to their info instead.
   */
  async waitForTerminal(taskId: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.processes.get(taskId);
    if (entry === undefined) {
      return this.retiredTasks.get(taskId)?.info ?? this.ghosts.get(taskId);
    }
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }
    await new Promise<void>((resolve) => {
      entry.waiters.push(resolve);
    });
    await entry.persistWriteQueue;
    return this.toInfo(entry);
  }

  /** Reset internal state (for testing). */
  _reset(): void {
    this.processes.clear();
    this.retiredTasks.clear();
    this.ghosts.clear();
    this.sessionDir = undefined;
  }

  /** Live (non-terminal) task occupancy. */
  get liveTaskCount(): number {
    return this.processes.size;
  }

  /** Retired-ring occupancy (≤ `RETIRED_TASK_LIMIT`). */
  get retiredTaskCount(): number {
    return this.retiredTasks.size;
  }

  // ── persistence + reconcile ────────────────────────────────────────

  /**
   * Attach the manager to a session directory for persistence. Tasks
   * created via `register()` after this call are written to
   * `<sessionDir>/tasks/<task_id>.json` and updated on lifecycle change.
   * Tasks created before attach are NOT retroactively persisted.
   */
  attachSessionDir(sessionDir: string): void {
    this.sessionDir = sessionDir;
  }

  /**
   * Load persisted task records into the ghost map. Does NOT reconcile
   * (call `reconcile()` after `loadFromDisk()`). Idempotent; subsequent
   * calls overwrite the ghost map.
   *
   * Requires `attachSessionDir()` first; no-op otherwise.
   */
  async loadFromDisk(): Promise<void> {
    if (this.sessionDir === undefined) return;
    this.ghosts.clear();
    const persisted = await listTasks(this.sessionDir);
    for (const t of persisted) {
      // Skip ids that already exist as live processes — live wins.
      if (this.processes.has(t.task_id)) continue;
      this.ghosts.set(t.task_id, persistedToInfo(t));
    }
  }

  /**
   * Reconcile loaded ghost tasks. Any ghost still non-terminal is
   * reclassified as `lost`: the process that owned it died with the previous
   * CLI process, so nothing here can drive it to a terminal state — there are
   * no streams to read and no process to stop. Deliberately not a
   * staleness/TTL check: the persisted shape carries no heartbeat timestamp,
   * and a "recent enough" ghost would still have no process handle behind it.
   * Updates the on-disk record and returns the lost task ids so the caller can
   * emit user-facing notifications.
   */
  protected async markLoadedTasksLost(): Promise<ReconcileResult> {
    const lost: string[] = [];
    const lostInfo: BackgroundTaskInfo[] = [];
    for (const [id, info] of this.ghosts) {
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: BackgroundTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
        failureReason: 'Task had no live process when the session was restored',
      };
      this.ghosts.set(id, updated);
      if (this.sessionDir !== undefined) {
        await writeTask(this.sessionDir, infoToPersisted(updated));
      }
      lost.push(id);
      lostInfo.push(updated);
    }
    return { lost, lostInfo };
  }

  async reconcile(): Promise<ReconcileResult> {
    const result = await this.markLoadedTasksLost();
    // Fire onTerminal for newly-lost ghosts so NotificationManager
    // receives a `task.lost` notification. Dedupe on the consumer side
    // is by `dedupe_key`; a second reconcile() on the same ghost is a
    // no-op because the status flips to `lost` above and we guard on
    // TERMINAL_STATUSES on the next pass.
    for (const info of result.lostInfo) {
      this.fireTerminalSubscribers(info);
    }
    return result;
  }

  /** Drop a persisted task from disk and ghost/retired maps. */
  async forgetTask(taskId: string): Promise<void> {
    this.ghosts.delete(taskId);
    this.retiredTasks.delete(taskId);
    if (this.sessionDir !== undefined) {
      await removeTask(this.sessionDir, taskId);
    }
  }

  /**
   * Persist the current state of a live ManagedProcess. Called from
   * `register()` and the lifecycle finally block. No-op unless attached.
   */
  private persistLive(entry: ManagedProcess): Promise<void> {
    if (this.sessionDir === undefined) return Promise.resolve();
    const sessionDir = this.sessionDir;
    const isAgentTask = entry.taskId.startsWith('agent-');
    const task: PersistedTask = {
      task_id: entry.taskId,
      command: entry.command,
      description: entry.description,
      pid: entry.proc.pid,
      started_at: entry.startedAt,
      ended_at: entry.endedAt,
      exit_code: entry.exitCode,
      status: entry.status,
      timed_out: entry.timedOut,
      stop_reason: entry.stopReason,
      // Only persist subagent identifiers for agent tasks. The base-class
      // fallback `agentId ?? taskId` (registerAgentTask) makes them equal
      // for tasks registered without an explicit id — skip those too so the
      // disk record stays honest about whether we know a real agent_id.
      agent_id: isAgentTask && entry.agentId !== entry.taskId ? entry.agentId : undefined,
      subagent_type: isAgentTask ? entry.subagentType : undefined,
    };
    entry.persistWriteQueue = entry.persistWriteQueue
      .then(() => writeTask(sessionDir, task))
      .catch(() => {});
    return entry.persistWriteQueue;
  }

  private appendOutput(entry: ManagedProcess, chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, 'utf-8');
    let retired: RetiredTask | undefined;
    if (this.processes.get(entry.taskId) === entry) {
      entry.outputSizeBytes += chunkBytes;
      entry.outputChunks.push(chunk);
      entry.outputRingBytes += chunkBytes;
      this.trimLiveOutput(entry);
    } else {
      retired = this.retiredTasks.get(entry.taskId);
      if (retired === undefined) {
        // Late stdout for a task whose retired record already left the ring
        // (FIFO eviction) or was forgotten: no manager read path can reach
        // the task any more, so drop the chunk instead of piling it into the
        // dead entry's ring (an unbounded leak) or re-creating a deleted log.
        return;
      }
      retired.outputSizeBytes += chunkBytes;
      this.appendRetiredChunk(retired, chunk);
    }

    const outputSessionDir = entry.outputSessionDir;
    if (outputSessionDir === undefined) return;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => appendTaskOutput(outputSessionDir, entry.taskId, chunk))
      .catch(() => {});
    if (retired !== undefined) {
      // Keep the retired record's queue live: flushOutput / readOutput await
      // whatever promise is published here, so leaving the snapshot taken in
      // finalizeTerminal would let them settle before this append lands.
      retired.outputWriteQueue = entry.outputWriteQueue;
    }
  }

  /**
   * Head-trim the live ring back under `MAX_OUTPUT_BYTES` (tail = newest
   * output kept). Budgeted in UTF-8 bytes rather than UTF-16 code units, so
   * multi-byte output cannot exceed the cap the way a code-unit count would.
   */
  private trimLiveOutput(entry: ManagedProcess): void {
    while (entry.outputRingBytes > MAX_OUTPUT_BYTES && entry.outputChunks.length > 1) {
      const removed = entry.outputChunks.shift();
      if (removed === undefined) break;
      entry.outputRingBytes -= Buffer.byteLength(removed, 'utf-8');
    }
    if (entry.outputRingBytes > MAX_OUTPUT_BYTES) {
      // The one surviving chunk exceeds the whole budget on its own (a single
      // multi-MiB write): keep only its byte tail so the ring — presented to
      // callers as a bounded tail — stays within the budget in every case.
      const only = entry.outputChunks[0];
      if (only === undefined) return;
      const tail = utf8ByteTail(only, MAX_OUTPUT_BYTES);
      entry.outputChunks[0] = tail;
      entry.outputRingBytes = Buffer.byteLength(tail, 'utf-8');
    }
  }

  /**
   * Append a late post-retirement chunk to the retired tail under the same
   * `MAX_OUTPUT_BYTES` budget as the live ring: over budget the oldest chunks
   * are dropped from the head while the newest output is kept. The chunk array
   * is trimmed in place and joined lazily on read, so one late chunk costs
   * O(chunk) — never the O(retained) rebuild a per-chunk `text += chunk`
   * would pay.
   */
  private appendRetiredChunk(retired: RetiredTask, chunk: string): void {
    retired.outputChunks.push(chunk);
    retired.outputTextBytes += Buffer.byteLength(chunk, 'utf-8');
    this.trimRetiredOutput(retired);
  }

  /**
   * Head-trim the retired tail back under `MAX_OUTPUT_BYTES` (tail = newest
   * output kept), mirroring the live ring's policy. Accounts in UTF-8 bytes
   * rather than UTF-16 code units so multi-byte output cannot exceed the
   * budget either.
   */
  private trimRetiredOutput(retired: RetiredTask): void {
    while (retired.outputTextBytes > MAX_OUTPUT_BYTES && retired.outputChunks.length > 1) {
      const removed = retired.outputChunks.shift();
      if (removed === undefined) break;
      retired.outputTextBytes -= Buffer.byteLength(removed, 'utf-8');
    }
    if (retired.outputTextBytes > MAX_OUTPUT_BYTES) {
      // The one surviving chunk exceeds the whole budget on its own (a single
      // multi-MiB write drained after retirement): keep only its byte tail so
      // the retained text stays within the budget in every case.
      const only = retired.outputChunks[0];
      if (only === undefined) return;
      const tail = utf8ByteTail(only, MAX_OUTPUT_BYTES);
      retired.outputChunks[0] = tail;
      retired.outputTextBytes = Buffer.byteLength(tail, 'utf-8');
    }
  }

  private outputSessionDirFor(taskId: string): string | undefined {
    const entry = this.processes.get(taskId);
    if (entry !== undefined) return entry.outputSessionDir;
    const retired = this.retiredTasks.get(taskId);
    if (retired !== undefined) return retired.outputSessionDir;
    if (this.ghosts.has(taskId)) return this.sessionDir;
    return undefined;
  }

  private async settleProcessExit(entry: ManagedProcess, exitCode: number): Promise<void> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      if (entry.status === 'killed' && entry.exitCode === null) {
        entry.exitCode = exitCode;
        entry.endedAt = Date.now();
        await this.persistLive(entry);
        this.fireTerminalCallbacks(entry);
        this.resolveWaiters(entry);
        this.syncRetired(entry);
      }
      return;
    }
    const status = entry.stopRequested ? 'killed' : exitCode === 0 ? 'completed' : 'failed';
    await this.finalizeTerminal(entry, status, exitCode);
  }

  /** Refresh the retired-ring snapshot after a post-terminal field update. */
  private syncRetired(entry: ManagedProcess): void {
    const retired = this.retiredTasks.get(entry.taskId);
    if (retired === undefined) return;
    this.retiredTasks.set(entry.taskId, {
      ...retired,
      info: this.toInfo(entry),
    });
  }

  private observedExitCompletions(): Promise<void>[] {
    const completions: Promise<void>[] = [];
    for (const entry of this.processes.values()) {
      if (!TERMINAL_STATUSES.has(entry.status) && entry.proc.exitCode !== null) {
        completions.push(entry.lifecyclePromise);
      }
    }
    return completions;
  }

  private toInfo(entry: ManagedProcess): BackgroundTaskInfo {
    return {
      taskId: entry.taskId,
      command: entry.command,
      description: entry.description,
      status: entry.status,
      pid: entry.proc.pid,
      exitCode: entry.exitCode,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      timedOut: entry.timedOut,
      stopReason: entry.stopReason,
      timeoutMs: entry.timeoutMs,
      agentId: entry.agentId,
      subagentType: entry.subagentType,
      failureReason: entry.failureReason,
    };
  }

  private async finalizeTerminal(
    entry: ManagedProcess,
    status: BackgroundTaskStatus,
    exitCode: number | null,
    options: { readonly timedOut?: boolean; readonly stopReason?: string } = {},
  ): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) return false;
    entry.status = status;
    entry.exitCode = exitCode;
    entry.endedAt = Date.now();
    entry.timedOut = options.timedOut;
    entry.stopReason = status === 'killed' ? (options.stopReason ?? entry.stopReason) : undefined;
    entry.stopRequested = false;
    await this.persistLive(entry);
    this.fireTerminalCallbacks(entry);
    this.resolveWaiters(entry);
    // Disk is the authority once the ring is dropped: drain pending output.log
    // appends before the retired record is published, so a retired getOutput /
    // readOutput can never observe a gap. Deliberately AFTER the terminal
    // notification so subscriber latency stays off the disk-write path.
    await entry.outputWriteQueue;
    // Terminal eviction: drop the live process handle and keep a slim retired
    // record (metadata + disk-log coordinates) in a bounded FIFO ring.
    // `stopAll`/`stop` only ever see `processes`, so they act on active tasks
    // alone from here on. The chunk array is *handed over* (not joined): late
    // chunks arriving after `'exit'` keep landing in it via `appendOutput`,
    // which owns keeping the retired tail under the same byte budget.
    const retainedChunks = entry.outputChunks.splice(0);
    const retired: RetiredTask = {
      info: this.toInfo(entry),
      outputChunks: retainedChunks,
      outputTextBytes: entry.outputRingBytes,
      outputSizeBytes: entry.outputSizeBytes,
      outputSessionDir: entry.outputSessionDir,
      outputWriteQueue: entry.outputWriteQueue,
    };
    entry.outputRingBytes = 0;
    // The retained tail was already byte-budgeted as part of the live ring;
    // re-check so the invariant holds however the chunks arrived.
    this.trimRetiredOutput(retired);
    this.retiredTasks.set(entry.taskId, retired);
    while (this.retiredTasks.size > RETIRED_TASK_LIMIT) {
      const oldest = this.retiredTasks.keys().next().value;
      if (oldest === undefined) break;
      this.retiredTasks.delete(oldest);
    }
    this.processes.delete(entry.taskId);
    return true;
  }
}

// ── boundary-safe tail slices ─────────────────────────────────────────

const ESC = '\u001B';

/**
 * Largest share of a retained tail the boundary rules may discard.
 *
 * Both rules trade content for a head that is whole by construction: rule 1
 * restarts after the next `\n` and drops the torn line, and rule 2 skips the
 * remainder of a torn sequence. The trade only pays while the tail keeps a
 * (non-strict) majority — with one 5000-char line ahead, a 100-unit budget
 * would come back with the few units after it, and the caller asked for the
 * newest output, not for a tidy head. Past the bound the raw cut keeps the
 * content: a string payload stays visible, and a torn CSI or two-byte escape
 * run keeps the fragment it left in view, because skipping that remainder
 * would cost more than the fragment it hides — unless the introducer ESC sits
 * immediately before the head *and* the sequence provably closes, where one
 * unit of look-back keeps the sequence whole and the fragment never surfaces.
 * An unclosed run keeps the raw cut: with no terminator to hand the sanitizer,
 * backing onto its ESC would surface a bare ESC the sanitizer cannot strip.
 */
const MAX_TAIL_DROP_SHARE = 0.5;

/**
 * `text.slice(-tail)` (clamping exactly like `slice` does for `tail` outside
 * `(0, text.length)`), with the head moved to a boundary no ANSI escape
 * sequence spans, so the first bytes a reader sees are never a torn fragment.
 */
function tailSlice(text: string, tail: number): string {
  if (tail <= 0 || tail >= text.length) return text;
  return text.slice(safeTailStart(text, text.length - tail));
}

/**
 * Move a tail cut point forward to a boundary no ANSI escape sequence spans.
 *
 * A raw `slice(-tail)` can land inside a sequence (`…\u001b[31|m…`), leaving a
 * fragment (`m`, `0m`, `[31`) whose ESC byte was cut away — the TUI sanitizer
 * only recognizes complete sequences, so the fragment renders as text. Two
 * provable rules keep the head clean:
 *
 * 1. Line alignment: a CSI sequence cannot contain `\n` (LF is not a
 *    parameter, intermediate or final byte), so a cut that lands mid-line
 *    restarts after the next `\n`. The only loss is the torn partial line,
 *    whose head cannot be trusted; every escape after the newline is whole.
 *    Bounded by `MAX_TAIL_DROP_SHARE`, so one huge line cannot eat the budget.
 * 2. Torn-sequence skip: when the retained text is one line (no `\n` after
 *    the cut), or an OSC/DCS/PM/APC payload spans the newline the cut aligned
 *    to, the dropped prefix is inspected for a sequence still open at the cut
 *    — a run of CSI body bytes (0x20–0x3F) reaching back to `ESC [`, an `ESC`
 *    whose intermediate bytes were torn (`ESC ( B`), or a string-sequence
 *    opener the cut landed inside. The head then skips exactly the bytes a
 *    terminal would consume for that sequence, so no visible text is dropped —
 *    but only while that skip stays within `MAX_TAIL_DROP_SHARE` of the tail.
 *    A CSI body or escape-intermediate run can be arbitrarily long, so past
 *    the bound the head keeps the newest bytes and the fragment the raw cut
 *    left with them — or one unit earlier, onto an introducer ESC sitting
 *    immediately before the head, so the whole sequence survives and is
 *    stripped (`withinDropShare`) — but only when the skip proved the sequence
 *    closed: an unclosed run keeps the raw cut, because with no terminator to
 *    hand the sanitizer the ESC would surface bare and swallow what follows
 *    it. So does the head for a string that never ends or ended ahead of the
 *    cut. A sliver of the tail is worse than a fragment.
 *
 * The result never splits a surrogate pair, and a non-empty input never comes
 * back empty: the head is never below `cut` (a tail never grows) except in two
 * cases — the cut splits a trailing pair, where dropping the orphan half would
 * empty the tail, so the head backs onto the pair's first half and the last
 * character survives; and a torn sequence's introducer ESC sits immediately
 * before the head *and* the sequence's skip proved it closes, where backing
 * one unit onto it keeps the sequence whole and the fragment is stripped
 * instead of surfaced. An unclosed skip takes the raw cut.
 */
function safeTailStart(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const tail = text.length - cut;
  let start = cut;
  if (text[start - 1] !== '\n') {
    const newline = text.indexOf('\n', start);
    // Bounded alignment: past `MAX_TAIL_DROP_SHARE` the torn line is worth
    // more than the clean head, and rule 2 still strips the fragment the raw
    // cut leaves behind.
    if (newline !== -1 && newline + 1 - cut <= tail * MAX_TAIL_DROP_SHARE) {
      start = newline + 1;
    }
  }
  start = skipOpenEscape(text, start);
  // A cut between the halves of a surrogate pair surfaces as a lone low
  // surrogate at the head (rendered as U+FFFD): drop the orphan half — unless
  // the orphan is the last unit, where dropping it would empty the tail of a
  // non-empty log. Backing onto the pair's first half keeps the character.
  const head = text.codePointAt(start);
  if (head !== undefined && head >= 0xdc00 && head <= 0xdfff) {
    return start + 1 < text.length ? start + 1 : start - 1;
  }
  return start;
}

/** CSI parameter (0x30–0x3F) / intermediate (0x20–0x2F) bytes — everything before the final byte. */
function isCsiBody(code: number | undefined): boolean {
  return code !== undefined && code >= 0x20 && code <= 0x3f;
}

/** CSI final byte (0x40–0x7E) — the sequence ends here. */
function isCsiFinal(code: number | undefined): boolean {
  return code !== undefined && code >= 0x40 && code <= 0x7e;
}

/** OSC / DCS / PM / APC introducers — string sequences ended by BEL or ST. */
function isStringIntro(intro: string | undefined): boolean {
  return intro === ']' || intro === 'P' || intro === '^' || intro === '_';
}

/** ESC-intermediate byte (0x20–0x2F) of a two-byte escape sequence. */
function isEscapeIntermediate(code: number | undefined): boolean {
  return code !== undefined && code >= 0x20 && code <= 0x2f;
}

/** Final byte (0x30–0x7E) that closes a two-byte escape sequence. */
function isEscapeFinal(code: number | undefined): boolean {
  return code !== undefined && code >= 0x30 && code <= 0x7e;
}

/** True when every code point in the half-open range `[from, to)` is an ESC intermediate (0x20–0x2F). */
function allEscapeIntermediates(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (!isEscapeIntermediate(text.codePointAt(i))) return false;
  }
  return true;
}

/**
 * When the dropped prefix proves an escape sequence is still open at `cut`,
 * return the index after its remainder; otherwise return `cut` unchanged.
 */
function skipOpenEscape(text: string, cut: number): number {
  // `ESC [ body… | cut` — the body bytes run straight back to the opener.
  let run = cut;
  while (run > 0 && isCsiBody(text.codePointAt(run - 1))) run -= 1;
  if (run >= 2 && text[run - 1] === '[' && text[run - 2] === ESC) {
    const skip = skipCsiRest(text, cut);
    return withinDropShare(text, cut, skip.end, skip.closed);
  }
  // `ESC intermediates… | cut` — the introducer was cut away (`[31m`, `m`) or
  // the torn run is an escape's own intermediate bytes (`ESC ( B`).
  if (text[run - 1] === ESC && allEscapeIntermediates(text, run, cut)) {
    return skipEscapeRest(text, cut);
  }
  // `ESC ] P ^ _ … | cut` — a string sequence the cut landed inside; payloads
  // may contain `\n`, so it can span the newline the head aligned to.
  const open = text.lastIndexOf(ESC, cut - 1);
  if (open !== -1 && isStringIntro(text[open + 1])) {
    return stringSequenceHead(text, open, cut);
  }
  return cut;
}

/**
 * Keep a provable skip only while it stays within `MAX_TAIL_DROP_SHARE` of the
 * tail that starts at `from`: the skipped bytes are exactly what the reader
 * loses from the tail it asked for. A CSI body or escape-intermediate run can
 * be arbitrarily long, so past the bound the raw cut is worth more than the
 * clean head — except when the sequence's introducer ESC sits immediately
 * before the head (`…\u001b|[31m…`) *and* `closed` says the skip found the
 * sequence's terminator, where one unit of look-back keeps the sequence whole
 * instead: the sanitizer strips it and the visible text is the skip's, for
 * that one unit rather than a sliver of the tail. An unclosed run must keep
 * the raw cut even with that ESC one unit ahead: nothing terminates it, so
 * look-back would hand the reader a bare ESC whose sequence run a terminal
 * swallows along with the bytes behind it.
 */
function withinDropShare(text: string, from: number, target: number, closed: boolean): number {
  if (target - from <= (text.length - from) * MAX_TAIL_DROP_SHARE) return target;
  return closed && from > 0 && text[from - 1] === ESC ? from - 1 : from;
}

/** Where a torn sequence's remainder ends, and whether it provably closed. */
interface SequenceEnd {
  /** Index just past the sequence's remainder. */
  end: number;
  /** True when a terminator was found inside `text` — false when the run hit `text.length` or a byte that cannot end it. */
  closed: boolean;
}

/**
 * The rest of a CSI sequence whose body was torn at `cut`, with the closure
 * its skip proved: `closed` holds only when a final byte (0x40–0x7E) was
 * actually found, so a parameter run that reaches the end of `text` — or stops
 * on a byte no CSI can end with — reports the sequence as open.
 */
function skipCsiRest(text: string, cut: number): SequenceEnd {
  let end = cut;
  while (end < text.length && isCsiBody(text.codePointAt(end))) end += 1;
  const closed = end < text.length && isCsiFinal(text.codePointAt(end));
  return { end: closed ? end + 1 : end, closed };
}

/** Index after the escape sequence whose introducer ESC sits at `cut - 1`. */
function skipEscapeRest(text: string, cut: number): number {
  const intro = text[cut];
  if (intro === '[') {
    const skip = skipCsiRest(text, cut + 1);
    return withinDropShare(text, cut, skip.end, skip.closed);
  }
  if (isStringIntro(intro)) return stringSequenceHead(text, cut - 1, cut + 1);
  // Two-byte escape: intermediates (0x20–0x2F), then one final byte (0x30–0x7E).
  let end = cut;
  while (end < text.length && isEscapeIntermediate(text.codePointAt(end))) end += 1;
  // Same closure test as the CSI skip: a torn intermediate run that never
  // reaches a final byte leaves the escape open.
  const closed = end < text.length && isEscapeFinal(text.codePointAt(end));
  return withinDropShare(text, cut, closed ? end + 1 : end, closed);
}

/**
 * Head index for a cut that lands inside the string sequence opened at `open`.
 *
 * `stringEnd` gives the byte a terminal stops at; skipping to it hides the
 * payload's remainder, which is what a terminal shows — but only while that
 * costs at most `MAX_TAIL_DROP_SHARE` of the tail. A long OSC 8 URL, or any
 * payload longer than the budget, would otherwise hand the caller a sliver of
 * the tail it asked for; a payload whose extent exceeds the budget stays
 * visible instead. A cut the string already ended ahead of needs no skip, and
 * an unterminated one must not swallow the tail (`stringPayloadHead`).
 */
function stringSequenceHead(text: string, open: number, cut: number): number {
  const drop = stringEnd(text, open + 2) - cut;
  if (drop >= 0 && drop <= (text.length - cut) * MAX_TAIL_DROP_SHARE) {
    return cut + drop;
  }
  return stringPayloadHead(text, open, cut);
}

/**
 * Head index that keeps a string sequence's payload visible, moving the cut
 * only past the opener's own bytes when the cut landed inside them.
 *
 * A terminal swallows an unterminated payload, but a viewer must never render
 * a blank body: `tailSlice` backs the tasks-browser tail read, and a log that
 * opens with an unterminated OSC — a run killed mid-title, a truncated write —
 * would otherwise come back empty. The head stays at `cut` unless the cut
 * landed inside the opener (`\u001b]0;` would leave `0;` in front of the
 * payload), and never reaches `text.length` — the clamp to the last unit steps
 * back onto the pair's first half when that unit is a trailing surrogate
 * pair's low half — so the tail is empty only for empty input.
 */
function stringPayloadHead(text: string, open: number, cut: number): number {
  const head = Math.min(Math.max(cut, stringPayloadStart(text, open)), text.length - 1);
  // `text.length - 1` can be the low half of a trailing surrogate pair; the
  // head must sit on a code point boundary, or the orphan-half drop in
  // `safeTailStart` would push it past `text.length` and empty the tail.
  const code = text.codePointAt(head);
  return head > 0 && code !== undefined && code >= 0xdc00 && code <= 0xdfff ? head - 1 : head;
}

/**
 * Index after the byte that ends the string sequence whose payload starts at
 * `from` — its BEL or `ESC \` terminator, or a CAN (0x18) / SUB (0x1A), which
 * a terminal reads as "string over, resume normal parsing". `-1` when the
 * string never ends.
 */
function stringEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === 0x07) return i + 1;
    if (code === 0x1b && text[i + 1] === '\\') return i + 2;
    if (code === 0x18 || code === 0x1a) return i + 1;
  }
  return -1;
}

/**
 * Index where the payload of the string sequence opened at `open` starts: for
 * OSC after `ESC ] Ps ;`, for DCS/PM/APC after their parameter and
 * intermediate bytes and the final byte that opens the payload.
 */
function stringPayloadStart(text: string, open: number): number {
  let i = open + 2;
  if (text[open + 1] === ']') {
    while (i < text.length && isOscParam(text.codePointAt(i))) i += 1;
    if (text[i] === ';') i += 1;
    return i;
  }
  while (i < text.length && isCsiBody(text.codePointAt(i))) i += 1;
  const final = text.codePointAt(i);
  return i < text.length && isCsiFinal(final) ? i + 1 : i;
}

/** OSC numeric parameter byte (0x30–0x39) — the `Ps` before the `;` separator. */
function isOscParam(code: number | undefined): boolean {
  return code !== undefined && code >= 0x30 && code <= 0x39;
}

// ── persistence shape <-> in-memory shape ──────────────────────────────

/**
 * Longest suffix of `text` whose UTF-8 encoding fits in `maxBytes`. Encoding
 * through a Buffer keeps lone surrogates accounted as the 3-byte replacement
 * character, and the cut is moved to the next code point boundary (continuation
 * bytes `10xxxxxx` skipped) so the tail never starts mid-sequence.
 */
function utf8ByteTail(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf-8');
  if (encoded.byteLength <= maxBytes) return text;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && ((encoded.at(start) ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return encoded.subarray(start).toString('utf-8');
}

function persistedToInfo(t: PersistedTask): BackgroundTaskInfo {
  return {
    taskId: t.task_id,
    command: t.command,
    description: t.description,
    status: t.status,
    pid: t.pid,
    exitCode: t.exit_code,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    timedOut: t.timed_out,
    stopReason: t.stop_reason,
    agentId: t.agent_id,
    subagentType: t.subagent_type,
  };
}

function infoToPersisted(info: BackgroundTaskInfo): PersistedTask {
  return {
    task_id: info.taskId,
    command: info.command,
    description: info.description,
    pid: info.pid,
    started_at: info.startedAt,
    ended_at: info.endedAt,
    exit_code: info.exitCode,
    status: info.status,
    timed_out: info.timedOut,
    stop_reason: info.stopReason,
    agent_id: info.agentId === info.taskId ? undefined : info.agentId,
    subagent_type: info.subagentType,
  };
}
