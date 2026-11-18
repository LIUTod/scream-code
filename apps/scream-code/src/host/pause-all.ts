/**
 * "Stop everything in the background": pause every background task and stop
 * what the host is running right now (task runs, continued work). A chat the
 * person is in is not touched. Tasks stay paused until turned back on in
 * `/jobs`; nothing resumes by itself.
 */


import {
  JobStore,
  readOrCreateControlToken,
  requestProcessLock,
  sessionLockScope,
  type Job,
} from '@scream-code/scream-code-sdk';

import { getDataDir } from '#/utils/paths';

import { HOST_LOCK_NAME } from './control';

/** Pause every enabled job in the store; returns the ones paused. */
export async function pauseAllJobs(screamHomeDir: string): Promise<Job[]> {
  const store = new JobStore(screamHomeDir);
  const paused: Job[] = [];
  for (const job of store.list()) {
    if (!job.enabled) continue;
    paused.push(await store.setEnabled(job.id, false));
  }
  return paused;
}

/** The host lock's scope, derived exactly as the core derives it. */
function scope(): string {
  return sessionLockScope(getDataDir());
}

/**
 * Pause all background work. Asks the running host (it also stops its runs in
 * flight); with no host running, pauses the tasks in the store directly.
 */
export async function pauseAllBackgroundWork(): Promise<{ paused: number; stoppedRuns: boolean }> {
  const reply = (await requestProcessLock(
    { scope: scope(), name: HOST_LOCK_NAME },
    { type: 'pause-all', token: readOrCreateControlToken(getDataDir()) },
    10_000,
  )) as { ok?: boolean; paused?: number } | undefined;
  if (reply?.ok === true) return { paused: reply.paused ?? 0, stoppedRuns: true };
  return { paused: (await pauseAllJobs(getDataDir())).length, stoppedRuns: false };
}
