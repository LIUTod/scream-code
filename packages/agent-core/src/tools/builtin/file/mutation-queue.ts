import * as path from 'node:path';

/**
 * Per-path serialization for file mutations.
 *
 * Within one turn a tool batch runs concurrently (`runToolCallBatch` settles
 * it with `Promise.allSettled`), and sub-agents share this process. Two writes
 * to the same file can therefore interleave their read→modify→write steps and
 * lose an update — most visibly two edits whose `old_string` windows overlap.
 * Mutations against the same resolved path run one after another; different
 * paths still run in parallel, so throughput is unchanged in the common case.
 *
 * Scope: structured write tools only (`Write`, `Edit`). Shell commands that
 * write files themselves (redirection, scripts) are outside the reach of an
 * in-process queue, exactly like every other file-tool guarantee.
 *
 * Keys are `path.resolve`d so relative and absolute spellings of the same
 * target share one chain. Symlinked aliases of one target are not merged; the
 * tools resolve access paths before calling this anyway.
 */

const tails = new Map<string, Promise<void>>();

export function withFileMutationLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = tails.get(key) ?? Promise.resolve();
  // Chain behind the previous mutation whether it succeeded or failed: a failed
  // write must not block every later write to the same file.
  const result = previous.then(task, task);
  const tail: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Only the current tail may drop the entry — a mutation queued behind this
    // one has already replaced `tails.get(key)`.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

/** Number of paths with an in-flight mutation chain (test seam / diagnostics). */
export function pendingMutationKeys(): number {
  return tails.size;
}
