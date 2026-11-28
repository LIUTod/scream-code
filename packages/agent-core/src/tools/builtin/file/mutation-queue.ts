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

/**
 * Sees every mutation of a file by the structured write tools, inside the
 * path's lock: `beforeMutation` before the write (so the original content can
 * be kept for an undo), `afterMutation` after it, whether it succeeded or not.
 * A recorder never fails a write: its errors are swallowed.
 */
export interface FileMutationRecorder {
  beforeMutation(filePath: string): Promise<void>;
  afterMutation(filePath: string): Promise<void>;
}

async function quietly(step: (() => Promise<void>) | undefined): Promise<void> {
  if (step === undefined) return;
  try {
    await step();
  } catch {
    // The history is a convenience; the write itself must go on.
  }
}

export function withFileMutationLock<T>(
  filePath: string,
  task: () => Promise<T>,
  recorder?: FileMutationRecorder,
): Promise<T> {
  const key = path.resolve(filePath);
  const previous = tails.get(key) ?? Promise.resolve();
  const recorded =
    recorder === undefined
      ? task
      : async (): Promise<T> => {
          await quietly(() => recorder.beforeMutation(key));
          try {
            return await task();
          } finally {
            await quietly(() => recorder.afterMutation(key));
          }
        };
  // Chain behind the previous mutation whether it succeeded or failed: a failed
  // write must not block every later write to the same file.
  const result = previous.then(recorded, recorded);
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
