import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isSameProject, resolveProjectRoot, stampProject } from '../src/project.js';

const roots: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memo-project-'));
  roots.push(dir);
  return dir;
}

function makeDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveProjectRoot', () => {
  it('finds the checkout above a nested directory', () => {
    const root = sandbox();
    makeDir(join(root, 'repo', '.git'));
    const nested = makeDir(join(root, 'repo', 'apps', 'cli'));
    expect(resolveProjectRoot(nested, join(root, 'home'))).toBe(join(root, 'repo'));
  });

  it('accepts a .git file, the way a worktree or submodule records it', () => {
    const root = sandbox();
    makeDir(join(root, 'wt'));
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    expect(resolveProjectRoot(join(root, 'wt'), join(root, 'home'))).toBe(join(root, 'wt'));
  });

  it('returns nothing outside a checkout', () => {
    const root = sandbox();
    const plain = makeDir(join(root, 'plain', 'src'));
    expect(resolveProjectRoot(plain, join(root, 'home'))).toBeUndefined();
  });

  it('stops at home instead of claiming a dotfiles repository as the project', () => {
    const root = sandbox();
    const home = join(root, 'home');
    makeDir(join(home, '.git'));
    // The session runs in home itself: no project, even though home is a repo.
    expect(resolveProjectRoot(home, home)).toBeUndefined();
    // ...but a checkout created inside home is a real project.
    makeDir(join(home, 'proj', '.git'));
    expect(resolveProjectRoot(join(home, 'proj'), home)).toBe(join(home, 'proj'));
  });

  it('answers from the cache on a second call', () => {
    const root = sandbox();
    makeDir(join(root, 'repo', '.git'));
    const first = resolveProjectRoot(join(root, 'repo'), join(root, 'home'));
    // Removing the marker would change a filesystem walk; the cache keeps the
    // answer stable for the life of the process, which is what recall relies on
    // to stay off the filesystem on every prompt.
    rmSync(join(root, 'repo', '.git'), { recursive: true, force: true });
    expect(resolveProjectRoot(join(root, 'repo'), join(root, 'home'))).toBe(first);
  });
});

describe('stampProject', () => {
  it('records the cwd and its project in one call', () => {
    const root = sandbox();
    makeDir(join(root, 'repo', '.git'));
    const memo: { projectDir: string; projectRoot?: string | undefined } = { projectDir: '' };
    stampProject(memo, join(root, 'repo', 'src'));
    expect(memo.projectDir).toBe(join(root, 'repo', 'src'));
    expect(memo.projectRoot).toBe(join(root, 'repo'));
  });
});

describe('isSameProject precedence', () => {
  it('prefers roots, then falls back to directories', () => {
    // Roots known on both sides: equal roots, different directories.
    expect(
      isSameProject(
        { projectDir: '/a/repo/tools', projectRoot: '/a/repo' },
        { projectDir: '/a/repo/src', projectRoot: '/a/repo' },
        '/home/x',
      ),
    ).toBe(true);
    // Roots known and different, even though one directory contains the other.
    expect(
      isSameProject(
        { projectDir: '/a/repo', projectRoot: '/a/repo' },
        { projectDir: '/a/repo', projectRoot: '/a/repo-fork' },
        '/home/x',
      ),
    ).toBe(false);
  });
});
