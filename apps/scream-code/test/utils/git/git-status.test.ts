/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

import { createGitStatusCache } from '#/utils/git/git-status';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function mockGit(porcelain: string, branch = 'main'): void {
  mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('rev-parse')) {
      return { status: 0, stdout: 'true\n' };
    }
    if (args.includes('branch')) {
      return { status: 0, stdout: `${branch}\n` };
    }
    if (args.includes('status')) {
      return { status: 0, stdout: porcelain };
    }
    if (args.includes('diff')) {
      return { status: 0, stdout: '4\t1\tsrc/app.ts\n' };
    }
    return { status: 1, stdout: '' };
  });
}

describe('git status cache', () => {
  it('caches branch and status reads until their TTL expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    mockGit('## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n');

    const cache = createGitStatusCache('/tmp/repo');

    const expected = {
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      files: [{ status: 'M', path: 'src/app.ts' }],
    };
    expect(cache.getStatus()).toEqual(expected);
    expect(cache.getStatus()).toEqual(expected);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(4);

    vi.setSystemTime(new Date('2026-04-24T00:00:06Z'));
    cache.getStatus();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(5);

    vi.setSystemTime(new Date('2026-04-24T00:00:16Z'));
    cache.getStatus();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(8);
  });

  it('keeps the previous snapshot when a porcelain spawn fails', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    mockGit('## main...origin/main\n M src/app.ts\n');

    const cache = createGitStatusCache('/tmp/repo');
    const good = cache.getStatus();
    expect(good?.files).toEqual([{ status: 'M', path: 'src/app.ts' }]);

    // Simulate a transient git failure (e.g. slow filesystem / permission
    // hiccup) — the cache keeps the previous snapshot instead of flashing
    // an empty working tree.
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
      if (args.includes('branch')) return { status: 0, stdout: 'main\n' };
      if (args.includes('status')) return { status: 1, stdout: '' }; // fail
      return { status: 1, stdout: '' };
    });
    vi.setSystemTime(new Date('2026-04-24T00:00:16Z')); // past STATUS_TTL
    const after = cache.getStatus();
    expect(after?.files).toEqual([{ status: 'M', path: 'src/app.ts' }]);
    expect(after?.diffAdded).toBe(4);
  });

  it('returns null when the working directory is not a git repo', () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(createGitStatusCache('/tmp/not-a-repo').getStatus()).toBeNull();
  });
});
