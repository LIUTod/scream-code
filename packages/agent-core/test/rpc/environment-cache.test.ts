import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readEnvironmentCache,
  writeEnvironmentCache,
} from '#/rpc/core-impl';

const FAKE_ENV = {
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: release(),
  shellName: 'bash' as const,
  shellPath: process.execPath, // a file that is guaranteed to exist
  homeDirectory: '/c/Users/test',
};

describe('environment cache', () => {
  let dir: string;
  let prevShellPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'env-cache-'));
    prevShellPath = process.env['SCREAM_SHELL_PATH'];
    delete process.env['SCREAM_SHELL_PATH'];
  });

  afterEach(async () => {
    if (prevShellPath === undefined) delete process.env['SCREAM_SHELL_PATH'];
    else process.env['SCREAM_SHELL_PATH'] = prevShellPath;
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a cached environment', async () => {
    await writeEnvironmentCache(dir, FAKE_ENV);
    const cached = await readEnvironmentCache(dir);
    expect(cached).toEqual({
      osKind: 'Windows',
      osArch: 'x64',
      osVersion: release(),
      shellName: 'bash',
      shellPath: process.execPath,
      homeDirectory: '/c/Users/test',
    });
  });

  it('returns undefined when the shell path no longer exists', async () => {
    await writeFile(
      join(dir, 'environment-cache.json'),
      JSON.stringify({ ...FAKE_ENV, shellPath: join(dir, 'missing-shell.exe'), cachedAt: Date.now() }),
      'utf8',
    );
    expect(await readEnvironmentCache(dir)).toBeUndefined();
  });

  it('returns undefined when the cached shell path is a directory', async () => {
    await writeFile(
      join(dir, 'environment-cache.json'),
      JSON.stringify({ ...FAKE_ENV, shellPath: dir, cachedAt: Date.now() }),
      'utf8',
    );
    expect(await readEnvironmentCache(dir)).toBeUndefined();
  });

  it('returns undefined when SCREAM_SHELL_PATH overrides to a different shell', async () => {
    const prev = process.env['SCREAM_SHELL_PATH'];
    process.env['SCREAM_SHELL_PATH'] = join(dir, 'override-shell.exe');
    try {
      await writeEnvironmentCache(dir, FAKE_ENV);
      expect(await readEnvironmentCache(dir)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['SCREAM_SHELL_PATH'];
      else process.env['SCREAM_SHELL_PATH'] = prev;
    }
  });

  it('honours a matching SCREAM_SHELL_PATH override', async () => {
    const prev = process.env['SCREAM_SHELL_PATH'];
    process.env['SCREAM_SHELL_PATH'] = FAKE_ENV.shellPath;
    try {
      await writeEnvironmentCache(dir, FAKE_ENV);
      expect(await readEnvironmentCache(dir)).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env['SCREAM_SHELL_PATH'];
      else process.env['SCREAM_SHELL_PATH'] = prev;
    }
  });

  it('returns undefined for an expired entry', async () => {
    await writeFile(
      join(dir, 'environment-cache.json'),
      JSON.stringify({ ...FAKE_ENV, cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
      'utf8',
    );
    expect(await readEnvironmentCache(dir)).toBeUndefined();
  });

  it('returns undefined when the OS version changed', async () => {
    await writeFile(
      join(dir, 'environment-cache.json'),
      JSON.stringify({ ...FAKE_ENV, osVersion: 'different-os-version', cachedAt: Date.now() }),
      'utf8',
    );
    expect(await readEnvironmentCache(dir)).toBeUndefined();
  });

  it('returns undefined for a missing or corrupt cache file', async () => {
    expect(await readEnvironmentCache(dir)).toBeUndefined();
    await writeFile(join(dir, 'environment-cache.json'), '{not json', 'utf8');
    expect(await readEnvironmentCache(dir)).toBeUndefined();
    await writeFile(join(dir, 'environment-cache.json'), 'null', 'utf8');
    expect(await readEnvironmentCache(dir)).toBeUndefined();
    await writeFile(join(dir, 'environment-cache.json'), '[]', 'utf8');
    expect(await readEnvironmentCache(dir)).toBeUndefined();
  });
});
