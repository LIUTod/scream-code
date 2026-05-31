import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readUpdateCache, writeUpdateCache } from '#/cli/update/cache';
import { emptyUpdateCache } from '#/cli/update/types';
import { getUpdateStateFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scream-update-cache-'));
  process.env['SCREAM_CODE_HOME'] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('update cache', () => {
  it('returns an empty cache when the file is missing', async () => {
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('falls back to an empty cache when the file is corrupt', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(getUpdateStateFile(), '{"broken"', 'utf-8');
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('falls back to an empty cache when the file has the old npm.json shape', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      getUpdateStateFile(),
      JSON.stringify({
        packageName: '@scream-cli/scream-code',
        checkedAt: '2026-04-23T08:00:00.000Z',
        distTags: { beta: '0.0.1-beta.1' },
      }),
      'utf-8',
    );
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('writes and reads back the cache from updates/latest.json', async () => {
    const cache = {
      source: 'cdn',
      checkedAt: '2026-04-23T08:00:00.000Z',
      latest: '0.5.0',
    } as const;

    await writeUpdateCache(cache);

    expect(getUpdateStateFile()).toBe(join(dir, 'updates', 'latest.json'));
    await expect(readUpdateCache()).resolves.toEqual(cache);
  });
});
