/**
 * The control token of a Scream home: a secret every scream process of the
 * home's owner can read and nobody else can (`<home>/run/control.token`,
 * 0600 in a 0700 directory).
 *
 * Process locks (`process-lock.ts`) answer requests from other processes —
 * stop, hand a session over — and a named pipe or an abstract socket can be
 * reached by every user on the machine. A request that changes anything
 * carries this token, so being able to read the owner's home is what
 * authorizes it.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function controlTokenPath(screamHomeDir: string): string {
  return join(screamHomeDir, 'run', 'control.token');
}

function readToken(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return TOKEN_PATTERN.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The home's control token, created on first use. Two processes creating it
 * at the same moment agree on one value: the file is created exclusively, and
 * the loser reads the winner's.
 */
export function readOrCreateControlToken(screamHomeDir: string): string {
  const path = controlTokenPath(screamHomeDir);
  const existing = readToken(path);
  if (existing !== undefined) return existing;
  const dir = join(screamHomeDir, 'run');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, `${token}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows: the file inherits the profile directory's ACL.
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Another process created it first; it may still be writing, so read again
  // a few times before treating the file as damaged.
  for (let attempt = 0; attempt < 5; attempt++) {
    const winner = readToken(path);
    if (winner !== undefined) return winner;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  // Damaged (empty, truncated, edited): replace it whole.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return readToken(path) ?? token;
}
