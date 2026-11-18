/**
 * Names for session process locks, shared by the core (which holds them) and
 * by anything that asks who has a session open or asks for it to be handed
 * over (the TUI, the background host).
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { readOrCreateControlToken } from './control-token';
import { queryProcessLock, requestProcessLock, type ProcessLockIdentity } from './process-lock';

export function sessionLockName(sessionId: string): string {
  return `session:${sessionId}`;
}

/** A home's lock scope: its real path, so a symlinked home is the same home. */
export function sessionLockScope(screamHomeDir: string): string {
  try {
    return realpathSync.native(screamHomeDir);
  } catch {
    return resolve(screamHomeDir);
  }
}

/** Who has `sessionId` open, or `undefined` when no process does. */
export async function sessionLockHolder(
  screamHomeDir: string,
  sessionId: string,
): Promise<ProcessLockIdentity | 'unknown' | undefined> {
  const query = await queryProcessLock({
    scope: sessionLockScope(screamHomeDir),
    name: sessionLockName(sessionId),
  });
  if (!query.held) return undefined;
  return query.holder ?? 'unknown';
}

/**
 * Ask the process holding `sessionId` to hand it over. Resolves true once the
 * holder agreed and its lock came free (within `timeoutMs`); false when it
 * refused, did not answer, or did not let go in time.
 */
export async function requestSessionHandover(
  screamHomeDir: string,
  sessionId: string,
  timeoutMs: number = 15_000,
): Promise<boolean> {
  const options = { scope: sessionLockScope(screamHomeDir), name: sessionLockName(sessionId) };
  const reply = (await requestProcessLock(options, {
    type: 'handover',
    token: readOrCreateControlToken(screamHomeDir),
  })) as { ok?: boolean } | undefined;
  if (reply?.ok !== true) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await queryProcessLock(options)).held) return true;
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 100);
    });
  }
  return false;
}
