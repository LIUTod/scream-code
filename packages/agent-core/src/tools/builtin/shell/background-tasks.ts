import { randomUUID } from 'node:crypto';

interface PendingBackgroundTask {
  readonly command: string;
  readonly startedAt: number;
  /**
   * Session that parked this command — every agent's Bash tool stamps its
   * session id (see `Session.instantiateAgent`). Teardown sweeps by this key so
   * closing one session cannot kill another session's parked commands; a task
   * with no owner (a caller outside any session, or a session created without
   * an id) is reached only by a sweep that asks for exactly that — an id-less
   * session's own close, or the process-wide exit sweep.
   */
  readonly ownerId?: string;
  /** Resolves when the process exits with { exitCode, output }. */
  readonly completion: Promise<{ exitCode: number; output: string }>;
  /** Set when the completion promise resolves. */
  result?: { exitCode: number; output: string };
  /** Terminates the still-running process (eviction / sweep). Fire-and-forget. */
  readonly kill: () => Promise<void>;
  /** Process id when known; for diagnostics only. */
  readonly pid?: number;
}

/**
 * Lightweight store for foreground Bash commands that were moved to
 * background on timeout. The process continues running; when it exits
 * the result is stored here and surfaced to the model on the next Bash
 * call.
 *
 * This is intentionally simple - it does NOT use the full
 * BackgroundProcessManager (which assumes it owns the process streams
 * from spawn). Here the streams are already being read by the
 * foreground ToolResultBuilder, so we just wrap the pending
 * completion promise.
 */
const pendingTasks = new Map<string, PendingBackgroundTask>();
const MAX_PENDING = 10;

export function createBackgroundTask(
  command: string,
  completion: Promise<{ exitCode: number; output: string }>,
  handles: {
    readonly kill: () => Promise<void>;
    readonly pid?: number;
    /** Owning session, so a later teardown can sweep just this owner's tasks. */
    readonly ownerId?: string | undefined;
  },
): string {
  const id = randomUUID().slice(0, 8);
  const task: PendingBackgroundTask = {
    command,
    startedAt: Date.now(),
    completion,
    kill: handles.kill,
    pid: handles.pid,
    ownerId: handles.ownerId,
  };

  // Evict oldest if at capacity — kill it first, otherwise the process
  // loses its only kill handle and runs unbounded.
  if (pendingTasks.size >= MAX_PENDING) {
    const oldest = pendingTasks.keys().next().value;
    if (oldest !== undefined) {
      const evicted = pendingTasks.get(oldest);
      pendingTasks.delete(oldest);
      if (evicted !== undefined) void evicted.kill();
    }
  }

  pendingTasks.set(id, task);

  // Store result when the process exits.
  task.completion.then(
    (result) => {
      task.result = result;
    },
    () => {
      task.result = { exitCode: -1, output: 'Background process failed.' };
    },
  );

  return id;
}

/**
 * Collect results from background tasks that have completed since the
 * last check. Each completed task is returned once and then removed.
 */
export function drainCompletedBackgroundTasks(): Array<{
  id: string;
  command: string;
  exitCode: number;
  output: string;
  elapsedMs: number;
}> {
  const completed: Array<{ id: string; command: string; exitCode: number; output: string; elapsedMs: number }> = [];
  for (const [id, task] of pendingTasks) {
    if (task.result !== undefined) {
      completed.push({
        id,
        command: task.command,
        exitCode: task.result.exitCode,
        output: task.result.output,
        elapsedMs: Date.now() - task.startedAt,
      });
      pendingTasks.delete(id);
    }
  }
  return completed;
}

/**
 * Kill the parked commands one owner is responsible for and clear them.
 *
 * Strictly owner-matched, `undefined` included: the registry is module-level
 * while sessions are not, so a session teardown must reach exactly the tasks
 * its own agents parked (every agent's Bash tool stamps its session id — see
 * `Session.instantiateAgent`) and never another session's. The undefined match
 * is a real case, not a wildcard: `SessionOptions.id` is optional, so a session
 * created without an id stamps no owner, and matching it against "no owner" is
 * what keeps that session's close() from executing a foreign session's command.
 * Process-wide cleanup is `killAllPendingBackgroundTasks`, which only a real
 * exit path may call.
 */
export function stopAllPendingBackgroundTasks(ownerId: string | undefined): void {
  for (const [id, task] of pendingTasks) {
    if (task.ownerId !== ownerId) continue;
    void task.kill();
    pendingTasks.delete(id);
  }
}

/**
 * Kill every parked command regardless of owner and clear the registry — the
 * process-wide exit sweep, and the reset tests use between cases. Nothing
 * inside a live process may call it: it executes commands belonging to every
 * other session too.
 */
export function killAllPendingBackgroundTasks(): void {
  for (const [id, task] of pendingTasks) {
    void task.kill();
    pendingTasks.delete(id);
  }
}

export function getPendingBackgroundCount(): number {
  return pendingTasks.size;
}
