/**
 * Who has a session open, and taking a session back from the background host.
 *
 * Every process that opens a session holds its lock (see the SDK's
 * `sessionLockHolder`). When the TUI cannot open a session because another
 * process holds it, that holder is either the background host — which hands
 * sessions over on request — or another terminal, which never does: one
 * terminal must not pull a session out of the person's other window.
 */

import {
  readRunningWork,
  removeRunningWork,
  requestSessionHandover,
  sessionLockHolder,
} from '@scream-code/scream-code-sdk';

import { readHostStatus } from '#/host/control';
import { getDataDir } from '#/utils/paths';

export type SessionHolder =
  | { readonly kind: 'none' }
  | { readonly kind: 'host'; readonly pid: number }
  | { readonly kind: 'other'; readonly pid?: number | undefined };

export async function sessionHolder(sessionId: string): Promise<SessionHolder> {
  const holder = await sessionLockHolder(getDataDir(), sessionId);
  if (holder === undefined) return { kind: 'none' };
  const pid = holder === 'unknown' ? undefined : holder.pid;
  const host = await readHostStatus();
  if (pid !== undefined && host.running && host.pid === pid) return { kind: 'host', pid };
  return { kind: 'other', pid };
}

/** Ask the background host to hand `sessionId` over; true once it let go. */
export function takeOverFromHost(sessionId: string): Promise<boolean> {
  return requestSessionHandover(getDataDir(), sessionId);
}

/** Whether an error is the core's "another process has this session open". */
export function isSessionInUse(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'session.in_use';
}

/**
 * After this process opened a session: whether the session's last turn was
 * cut off (a running-work record nobody was holding the session for), and
 * forget the record — this process now owns the session and its next turn
 * writes a fresh one.
 */
export function consumeInterruptedTurn(sessionId: string): boolean {
  const home = getDataDir();
  const record = readRunningWork(home, sessionId);
  if (record === undefined) return false;
  removeRunningWork(home, sessionId);
  return true;
}
