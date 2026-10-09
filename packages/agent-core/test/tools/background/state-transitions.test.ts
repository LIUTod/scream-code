/**
 * Cancellation attribution for background tasks.
 *
 * A cancellation is not a failure: `killed` is the status the notification
 * layer reads as "the user ended this deliberately" — it never advertises
 * Agent(resume=...) — so every cancel path must land there.
 *
 * Semantics:
 *   - an abort-shaped rejection is a cancellation whether or not a BPM-side
 *     `stop()` latched `stopRequested` first: a user interrupt (ESC / turn
 *     cancel) aborts a background run through its own controller, without
 *     ever calling `stop()`
 *   - a runner-raised `RunCancelled` is the same signal arriving as an error
 *     name
 *   - a non-abort rejection that arrives while a stop is in flight stays a
 *     failure: the user's cancellation must not hide a real error
 */

import { afterEach, describe, expect, it } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager';

/** Reject a completion on the next tick so registration has returned. */
function rejectSoon(error: unknown): Promise<{ result: string }> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(error);
    }, 0);
  });
}

describe('BackgroundProcessManager — cancellation attribution', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
  });

  it('an abort rejection without a stop() marks the task killed, not failed', async () => {
    // The user-interrupt shape: the run's own controller aborts and the
    // completion rejects with an AbortError, while no BPM stop() ever ran.
    const abortError = new Error('Aborted by the user');
    abortError.name = 'AbortError';
    const taskId = manager.registerAgentTask(rejectSoon(abortError), 'interrupted run');

    const info = await manager.waitForTerminal(taskId);

    expect(info?.status).toBe('killed');
    expect(info?.stopReason).toBeUndefined();
  });

  it('treats a session-cancelled run the same way (abort reason, no stop latch)', async () => {
    const cancelReason = new Error('Aborted by the user');
    cancelReason.name = 'AbortError';
    (cancelReason as Error & { userCancelled?: boolean }).userCancelled = true;
    const taskId = manager.registerAgentTask(rejectSoon(cancelReason), 'session cancel');

    const info = await manager.waitForTerminal(taskId);

    expect(info?.status).toBe('killed');
  });

  it('RunCancelled in an agent run marks the task as killed (not failed)', async () => {
    class RunCancelled extends Error {
      constructor() {
        super('run cancelled');
        this.name = 'RunCancelled';
      }
    }
    const taskId = manager.registerAgentTask(
      Promise.reject(new RunCancelled()),
      'run cancelled bg',
    );
    const info = await manager.waitForTerminal(taskId);
    expect(info?.status).toBe('killed');
  });

  it('a real failure racing an in-flight stop stays failed', async () => {
    // stopRequested is set, but the rejection is not abort-shaped: a model
    // error won the race, and recording it as a kill would file a genuine
    // failure as a user cancellation.
    let rejectCompletion!: (err: unknown) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const taskId = manager.registerAgentTask(completion, 'racy failure', {
      abort: () => {
        rejectCompletion(new Error('model error'));
      },
    });

    const info = await manager.stop(taskId);

    expect(info?.status).toBe('failed');
  });
});
