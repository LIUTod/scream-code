import { randomUUID } from 'node:crypto';

interface PendingBackgroundTask {
  readonly command: string;
  readonly startedAt: number;
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
  },
): string {
  const id = randomUUID().slice(0, 8);
  const task: PendingBackgroundTask = {
    command,
    startedAt: Date.now(),
    completion,
    kill: handles.kill,
    pid: handles.pid,
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
 * Kill every pending background task and clear the registry. Intended for
 * session teardown / process exit; not wired up by this module itself.
 */
export function stopAllPendingBackgroundTasks(): void {
  for (const task of pendingTasks.values()) {
    void task.kill();
  }
  pendingTasks.clear();
}

export function getPendingBackgroundCount(): number {
  return pendingTasks.size;
}
