import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  docsSourceCandidates,
  ensureDocsInstalled,
  findDocsSource,
  isProductManaged,
} from '#/cli/ensure-docs';

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writeDocs(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'configuration.md'), body);
}

function markManaged(dir: string): void {
  writeFileSync(join(dir, '.product-managed.json'), '{"managedBy":"scream-code"}');
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('docsSourceCandidates', () => {
  it('covers installed, repo-build and checkout layouts', () => {
    const repoRoot = '/repo';
    const dist = join(repoRoot, 'apps', 'scream-code', 'dist');
    // The last candidate (four hops) only makes sense from src/cli; do not
    // assert it against a dist input.
    const fromDist = docsSourceCandidates(dist).slice(0, 2);
    expect(fromDist).toEqual([
      join(repoRoot, 'apps', 'scream-code', 'docs'),
      join(repoRoot, 'docs'),
    ]);

    const cli = join(repoRoot, 'apps', 'scream-code', 'src', 'cli');
    const fromCli = docsSourceCandidates(cli).slice(2, 3);
    expect(fromCli).toEqual([join(repoRoot, 'docs')]);
  });

  it('resolves the installed layout from <pkg>/dist', () => {
    const pkg = tempDir('scream-pkg-');
    writeDocs(join(pkg, 'docs'), '# installed');
    mkdirSync(join(pkg, 'dist'));

    expect(findDocsSource(join(pkg, 'dist'))).toBe(join(pkg, 'docs'));
  });

  it('resolves the repo-build layout from apps/scream-code/dist', () => {
    const repo = tempDir('scream-repo-');
    writeDocs(join(repo, 'docs'), '# repo build');
    const dist = join(repo, 'apps', 'scream-code', 'dist');
    mkdirSync(dist, { recursive: true });

    expect(findDocsSource(dist)).toBe(join(repo, 'docs'));
  });

  it('resolves the checkout layout from src/cli', () => {
    const repo = tempDir('scream-repo-');
    writeDocs(join(repo, 'docs'), '# checkout');
    const cli = join(repo, 'apps', 'scream-code', 'src', 'cli');
    mkdirSync(cli, { recursive: true });

    expect(findDocsSource(cli)).toBe(join(repo, 'docs'));
  });

  it('returns undefined when neither layout exists', () => {
    expect(findDocsSource(tempDir('scream-empty-'))).toBeUndefined();
  });
});

describe('ensureDocsInstalled', () => {
  it('copies docs into an empty home and marks the directory as product-managed', () => {
    const pkg = tempDir('scream-pkg-');
    writeDocs(join(pkg, 'docs'), '# fresh');
    mkdirSync(join(pkg, 'dist'));
    const home = tempDir('scream-home-');

    ensureDocsInstalled(home, join(pkg, 'dist'));

    const target = join(home, 'docs');
    expect(readFileSync(join(target, 'configuration.md'), 'utf8')).toBe('# fresh');
    expect(isProductManaged(target)).toBe(true);
  });

  it('overwrites a product-managed copy after an upgrade', () => {
    const pkg = tempDir('scream-pkg-');
    writeDocs(join(pkg, 'docs'), '# new');
    mkdirSync(join(pkg, 'dist'));
    const home = tempDir('scream-home-');
    writeDocs(join(home, 'docs'), '# stale');
    markManaged(join(home, 'docs'));

    ensureDocsInstalled(home, join(pkg, 'dist'));

    expect(readFileSync(join(home, 'docs', 'configuration.md'), 'utf8')).toBe('# new');
  });

  it('never touches a user-owned directory without the marker', () => {
    const pkg = tempDir('scream-pkg-');
    writeDocs(join(pkg, 'docs'), '# product');
    mkdirSync(join(pkg, 'dist'));
    const home = tempDir('scream-home-');
    writeDocs(join(home, 'docs'), '# user notes');

    ensureDocsInstalled(home, join(pkg, 'dist'));

    expect(readFileSync(join(home, 'docs', 'configuration.md'), 'utf8')).toBe('# user notes');
  });

  it('is a no-op when no source exists', () => {
    const home = tempDir('scream-home-');

    ensureDocsInstalled(home, tempDir('scream-empty-'));

    expect(existsSync(join(home, 'docs', 'configuration.md'))).toBe(false);
  });
});
