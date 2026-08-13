import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalJian } from '@scream-code/jian';
import { readEnvironmentCache, writeEnvironmentCache } from '#/rpc/core-impl';

describe('live environment cache round-trip', () => {
  it('detects once, caches, and reuses the cached environment on the next process', async () => {
    const prevShellPath = process.env['SCREAM_SHELL_PATH'];
    delete process.env['SCREAM_SHELL_PATH'];
    const dir = await mkdtemp(join(tmpdir(), 'envcache-live-'));
    try {
      // 1. First process: full detection (no cache).
      const jian = await LocalJian.create();
      expect(jian.osEnv.shellPath.length).toBeGreaterThan(0);

      // 2. Persist the detected environment.
      await writeEnvironmentCache(dir, jian.osEnv);

      // 3. Next process: read the cache (hit) and build LocalJian from it.
      const cached = await readEnvironmentCache(dir);
      expect(cached).toBeDefined();
      const jian2 = await LocalJian.create(undefined, undefined, cached!);
      expect(jian2.osEnv).toEqual(jian.osEnv);

      // 4. The cached shell is the same one the full detection resolved.
      expect(jian2.osEnv.shellPath).toBe(jian.osEnv.shellPath);

      // 5. A fresh dir with no cache file misses cleanly.
      const dir2 = await mkdtemp(join(tmpdir(), 'envcache-miss-'));
      try {
        expect(await readEnvironmentCache(dir2)).toBeUndefined();
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (prevShellPath === undefined) delete process.env['SCREAM_SHELL_PATH'];
      else process.env['SCREAM_SHELL_PATH'] = prevShellPath;
    }
  });
});
