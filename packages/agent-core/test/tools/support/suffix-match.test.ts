import type { Jian } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import {
  escapeGlobMetachars,
  findUniqueSuffixMatch,
  partitionExistingPaths,
  suffixResolutionNotice,
} from '../../../src/tools/support/suffix-match';
import { createFakeJian } from '../fixtures/fake-jian';

const REGULAR_FILE_STAT = {
  stMode: 0o100_644,
  stIno: 1,
  stDev: 1,
  stNlink: 1,
  stUid: 1000,
  stGid: 1000,
  stSize: 0,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
} satisfies Awaited<ReturnType<Jian['stat']>>;

const ENOENT_ERROR = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('escapeGlobMetachars', () => {
  it('escapes glob metacharacters using character classes', () => {
    expect(escapeGlobMetachars('foo*bar')).toBe('foo[*]bar');
    expect(escapeGlobMetachars('foo?bar')).toBe('foo[?]bar');
    expect(escapeGlobMetachars('foo[bar')).toBe('foo[[]bar');
    expect(escapeGlobMetachars('foo{bar')).toBe('foo[{]bar');
  });

  it('leaves plain filenames unchanged', () => {
    expect(escapeGlobMetachars('foo.ts')).toBe('foo.ts');
    expect(escapeGlobMetachars('src/utils/foo.ts')).toBe('src/utils/foo.ts');
  });
});

describe('findUniqueSuffixMatch', () => {
  function jianWithGlob(paths: string[]): Jian {
    return createFakeJian({
      glob: async function* (): AsyncGenerator<string> {
        for (const p of paths) yield p;
      },
    });
  }

  it('returns the match when exactly one candidate exists', async () => {
    const jian = jianWithGlob(['/workspace/src/utils/foo.ts']);
    const result = await findUniqueSuffixMatch('src/tils/foo.ts', '/workspace', jian);
    expect(result).not.toBeNull();
    expect(result!.absolutePath).toBe('/workspace/src/utils/foo.ts');
  });

  it('returns null when multiple candidates exist', async () => {
    const jian = jianWithGlob(['/workspace/a/foo.ts', '/workspace/b/foo.ts']);
    const result = await findUniqueSuffixMatch('foo.ts', '/workspace', jian);
    expect(result).toBeNull();
  });

  it('returns null when no candidates exist', async () => {
    const jian = jianWithGlob([]);
    const result = await findUniqueSuffixMatch('missing.ts', '/workspace', jian);
    expect(result).toBeNull();
  });

  it('returns null for empty normalized path', async () => {
    const jian = jianWithGlob(['/workspace/foo.ts']);
    const result = await findUniqueSuffixMatch('./', '/workspace', jian);
    expect(result).toBeNull();
  });

  it('caches results within a single cache map', async () => {
    const globFn = vi.fn(async function* (): AsyncGenerator<string> {
      yield '/workspace/foo.ts';
    });
    const jian = createFakeJian({ glob: globFn });
    const cache = new Map();
    await findUniqueSuffixMatch('foo.ts', '/workspace', jian, cache);
    await findUniqueSuffixMatch('foo.ts', '/workspace', jian, cache);
    expect(globFn).toHaveBeenCalledTimes(1);
  });

  it('passes no pruning exclusions — it resolves a path the caller named', async () => {
    // Suffix match recovers a path the caller already spelled out, so it
    // must keep `.git` / `node_modules` reachable: pruning here would turn
    // a resolvable explicit path into "not found". Unlike the Glob tool,
    // which enumerates a tree and therefore prunes by default.
    const globFn = vi.fn(async function* (): AsyncGenerator<string> {
      yield '/workspace/node_modules/pkg/index.js';
    });
    const jian = createFakeJian({ glob: globFn });

    const result = await findUniqueSuffixMatch('pkg/index.js', '/workspace', jian);

    expect(result!.absolutePath).toBe('/workspace/node_modules/pkg/index.js');
    expect(globFn).toHaveBeenCalledWith('/workspace', '**/pkg/index.js', {
      allowedRoots: ['/workspace'],
    });
  });
});

describe('suffixResolutionNotice', () => {
  it('builds the standard notice text', () => {
    expect(suffixResolutionNotice('a.ts', 'b.ts')).toBe(
      "[Path 'a.ts' not found; resolved to 'b.ts' via suffix match]",
    );
  });
});

describe('partitionExistingPaths', () => {
  function jianWithStats(existing: Set<string>): Jian {
    return createFakeJian({
      stat: vi.fn<Jian['stat']>().mockImplementation(async (p) => {
        if (!existing.has(p)) throw ENOENT_ERROR;
        return REGULAR_FILE_STAT;
      }),
    });
  }

  it('splits into valid and missing', async () => {
    const jian = jianWithStats(new Set(['/workspace/a.ts', '/workspace/b.ts']));
    const result = await partitionExistingPaths(
      ['/workspace/a.ts', '/workspace/missing.ts', '/workspace/b.ts'],
      jian,
      { workspaceDir: '/workspace', additionalDirs: [] },
    );
    expect(result.valid).toEqual(['/workspace/a.ts', '/workspace/b.ts']);
    expect(result.missing).toEqual(['/workspace/missing.ts']);
  });

  it('returns all missing when nothing exists', async () => {
    const jian = jianWithStats(new Set());
    const result = await partitionExistingPaths(
      ['/workspace/a.ts', '/workspace/b.ts'],
      jian,
      { workspaceDir: '/workspace', additionalDirs: [] },
    );
    expect(result.valid).toEqual([]);
    expect(result.missing).toEqual(['/workspace/a.ts', '/workspace/b.ts']);
  });

  it('returns all valid when everything exists', async () => {
    const jian = jianWithStats(new Set(['/workspace/a.ts', '/workspace/b.ts']));
    const result = await partitionExistingPaths(
      ['/workspace/a.ts', '/workspace/b.ts'],
      jian,
      { workspaceDir: '/workspace', additionalDirs: [] },
    );
    expect(result.valid).toEqual(['/workspace/a.ts', '/workspace/b.ts']);
    expect(result.missing).toEqual([]);
  });

  it('propagates non-ENOENT stat errors', async () => {
    const permissionError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const jian = createFakeJian({
      stat: vi.fn<Jian['stat']>().mockRejectedValue(permissionError),
    });
    await expect(
      partitionExistingPaths(['/workspace/a.ts'], jian, {
        workspaceDir: '/workspace',
        additionalDirs: [],
      }),
    ).rejects.toThrow('EACCES');
  });
});
