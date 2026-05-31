import { chmod, rename, writeFile } from 'node:fs/promises';

/**
 * Write atomically: write to a temp sibling then rename over the target.
 *
 * A crashed or interrupted write leaves the temp file behind but never a
 * partially-written target — `rename` is atomic on POSIX. Use this for any
 * write that overwrites an existing user-owned file.
 */
export async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  // Migrated config/MCP files can carry provider API keys. Create them
  // private (0600) so they are never group/world-readable, even when the
  // target home directory itself has permissive permissions. `chmod` covers
  // the case where a stale temp file from a crashed run already exists.
  await writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
