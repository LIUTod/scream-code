import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'pathe';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

function slugifyWorkDirName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 60);
}

function encodeWorkDirKey(workDir: string): string {
  const normalized = resolve(workDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

/**
 * Resolve the project-level directory for memory storage.
 *
 * Matches the session-store layout:
 *   <dataDir>/sessions/<workDirKey>/memory/
 */
export function resolveProjectDir(dataDir: string, workDir: string): string {
  const key = encodeWorkDirKey(workDir);
  return join(dataDir, 'sessions', key);
}
