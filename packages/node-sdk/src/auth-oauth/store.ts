/**
 * Credential persistence for OAuth provider logins.
 *
 * One JSON file per provider under `<dir>/<providerId>.json` with `0600`
 * permissions and an atomic write pattern (temp file + fsync + rename),
 * mirroring the MCP OAuth store conventions. Read-modify-write is serialized
 * per provider in-process so concurrent refreshes cannot interleave, and a
 * direct `write`/`delete` (login / logout) supersedes any read-modify-write
 * that was already in flight.
 *
 * Reads never throw: a missing, corrupt or foreign-shaped file all read as
 * "no credential", so callers that only ask whether one exists (provider
 * pickers, request auth) cannot crash on a hand-edited or half-written file.
 * Writes and deletes still reject ids that cannot name a credential file.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { OAuthCredential } from './types';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Parses a stored credential; `undefined` when the file holds anything else. */
function parseCredential(raw: string): OAuthCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record['type'] !== 'oauth' ||
    typeof record['access'] !== 'string' ||
    typeof record['refresh'] !== 'string' ||
    typeof record['expires'] !== 'number'
  ) {
    return undefined;
  }
  return record as unknown as OAuthCredential;
}

export class FileOAuthCredentialStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Per-provider revision, bumped by every direct `write`/`delete`. A `modify`
   * captures it on entry and drops its own write-back when the revision has
   * moved: a login or logout that landed while the queued read-modify-write was
   * in flight owns the file from then on.
   */
  private readonly revisions = new Map<string, number>();

  constructor(private readonly dir: string) {}

  private revision(providerId: string): number {
    return this.revisions.get(providerId) ?? 0;
  }

  /** Credential file path, or `undefined` for ids that cannot name one. */
  private target(providerId: string): string | undefined {
    if (!PROVIDER_ID_PATTERN.test(providerId)) return undefined;
    return join(this.dir, `${providerId}.json`);
  }

  /** Credential file path for the mutating paths; rejects unusable ids. */
  private requireTarget(providerId: string): string {
    const target = this.target(providerId);
    if (target === undefined) {
      throw new Error(`Invalid OAuth provider id: ${providerId}`);
    }
    return target;
  }

  read(providerId: string): OAuthCredential | undefined {
    const target = this.target(providerId);
    if (target === undefined) return undefined;
    let raw: string;
    try {
      raw = readFileSync(target, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return parseCredential(raw);
  }

  write(providerId: string, credential: OAuthCredential): void {
    const target = this.requireTarget(providerId);
    this.revisions.set(providerId, this.revision(providerId) + 1);
    this.writeCredential(target, credential);
  }

  private writeCredential(target: string, credential: OAuthCredential): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best-effort; Windows / read-only FS may refuse
    }
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const buffer = Buffer.from(`${JSON.stringify(credential, null, 2)}\n`, 'utf-8');
    const fd = openSync(tmp, 'w', 0o600);
    try {
      let written = 0;
      while (written < buffer.length) {
        written += writeSync(fd, buffer, written, buffer.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  delete(providerId: string): void {
    const target = this.requireTarget(providerId);
    this.revisions.set(providerId, this.revision(providerId) + 1);
    try {
      unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  /**
   * Serialized read-modify-write for one provider. `fn` receives the current
   * credential (lock-scoped read, so a refresh that completed while queued is
   * observed) and returns the credential to persist, or `undefined` to leave
   * the stored value untouched.
   *
   * When a direct `write` or `delete` lands while `fn` is running, the
   * write-back is dropped and `undefined` is returned: the newer value owns the
   * file, and callers re-read it instead of persisting a superseded credential.
   */
  modify(
    providerId: string,
    fn: (current: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>,
  ): Promise<OAuthCredential | undefined> {
    const revision = this.revision(providerId);
    const previous = this.queues.get(providerId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return next;
      if (this.revision(providerId) !== revision) return undefined;
      this.writeCredential(this.requireTarget(providerId), next);
      return next;
    });
    this.queues.set(
      providerId,
      run.catch(() => undefined),
    );
    return run;
  }
}
