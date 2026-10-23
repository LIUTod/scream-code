import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'pathe';

import { slugifyWorkDirName } from '#/utils/workdir-slug';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function normalizeWorkDir(workDir: string): string {
  const resolved = resolve(workDir);
  let dir = resolved;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return resolved;
}

/**
 * Resolves the work directory a session is keyed and rooted on.
 *
 * Default behavior (no `exactWorkDir`) walks up to the nearest `.git` /
 * `package.json` ancestor via {@link normalizeWorkDir}. `exactWorkDir: true`
 * keeps the directory the caller named — bots get a workspace root of their
 * own instead of being folded into the enclosing repository.
 */
export function resolveWorkDir(workDir: string, exactWorkDir?: boolean | undefined): string {
  return exactWorkDir === true ? resolve(workDir) : normalizeWorkDir(workDir);
}

export function encodeWorkDirKey(workDir: string, exactWorkDir?: boolean | undefined): string {
  const normalized = resolveWorkDir(workDir, exactWorkDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}
