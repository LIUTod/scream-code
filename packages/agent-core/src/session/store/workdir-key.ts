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

export function encodeWorkDirKey(workDir: string): string {
  const normalized = normalizeWorkDir(workDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}
