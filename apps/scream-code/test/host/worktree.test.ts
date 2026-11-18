import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { finishRunWorktree, holdRunWorktree, prepareRunWorktree, releaseHeldWorktree } from '#/host/worktree';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repo(): { repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'scream-wt-'));
  dirs.push(root);
  const repoDir = join(root, 'repo');
  mkdirSync(join(repoDir, 'pkg'), { recursive: true });
  git(root, 'init', '-q', repoDir);
  writeFileSync(join(repoDir, 'pkg', 'a.txt'), 'one\n');
  git(repoDir, 'add', '-A');
  git(repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return { repo: repoDir, home: join(root, 'home') };
}

const NOW = new Date(2026, 10, 18, 2, 0).getTime();

describe('run worktrees', () => {
  it('works on a branch of its own and leaves the checkout alone', async () => {
    const { repo: repoDir, home } = repo();
    const wt = await prepareRunWorktree(home, join(repoDir, 'pkg'), 'job-abc', NOW);
    expect(wt).toBeDefined();
    expect(wt!.branch).toBe('scream/job-abc/20261118-0200');
    expect(wt!.dir.endsWith(join('20261118-0200', 'pkg'))).toBe(true);

    writeFileSync(join(wt!.dir, 'a.txt'), 'two\n');
    const branch = await finishRunWorktree(wt!, 'scream: nightly run');

    expect(branch).toBe('scream/job-abc/20261118-0200');
    expect(readFileSync(join(repoDir, 'pkg', 'a.txt'), 'utf8')).toBe('one\n');
    expect(git(repoDir, 'status', '--porcelain')).toBe('');
    expect(git(repoDir, 'show', `${branch!}:pkg/a.txt`)).toBe('two');
    expect(existsSync(wt!.dir)).toBe(false);
  });

  it('deletes the branch of a run that changed nothing', async () => {
    const { repo: repoDir, home } = repo();
    const wt = await prepareRunWorktree(home, repoDir, 'job-abc', NOW);
    expect(await finishRunWorktree(wt!, 'scream: run')).toBeUndefined();
    expect(git(repoDir, 'branch', '--list', 'scream/*')).toBe('');
  });

  it('gives a second run in the same minute a branch of its own', async () => {
    const { repo: repoDir, home } = repo();
    const first = await prepareRunWorktree(home, repoDir, 'job-abc', NOW);
    const second = await prepareRunWorktree(home, repoDir, 'job-abc', NOW);
    expect(second!.branch).toBe('scream/job-abc/20261118-0200-2');
    await finishRunWorktree(first!, 'x');
    await finishRunWorktree(second!, 'x');
  });

  it('is skipped outside a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scream-nogit-'));
    dirs.push(root);
    expect(await prepareRunWorktree(join(root, 'home'), root, 'job-abc', NOW)).toBeUndefined();
  });
});

describe('held worktrees', () => {
  it('keeps a worktree for a waiting run and finishes it on release', async () => {
    const { repo: repoDir, home } = repo();
    const wt = await prepareRunWorktree(home, repoDir, 'job-h', NOW);
    expect(wt).toBeDefined();
    writeFileSync(join(wt!.dir, 'new.txt'), 'x');
    await holdRunWorktree(home, 'job-run-s1', wt!);
    expect(existsSync(wt!.dir)).toBe(true);
    expect(await releaseHeldWorktree(home, 'job-run-s1', 'scream: test')).toBe(wt!.branch);
    expect(existsSync(wt!.dir)).toBe(false);
    expect(await releaseHeldWorktree(home, 'job-run-s1', 'again')).toBeUndefined();
  });
});
