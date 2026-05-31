import { describe, it, expect } from 'vitest';
import { resolveProjectDir } from '../src/paths.js';

describe('resolveProjectDir', () => {
  it('returns a path under sessions/<hash>/ for a workDir', () => {
    const result = resolveProjectDir('/home/user/.scream-code', '/Users/test/project');
    expect(result).toMatch(/\/home\/user\/\.scream-code\/sessions\/wd_.+/);
  });

  it('is deterministic for the same workDir', () => {
    const a = resolveProjectDir('/data', '/foo/bar');
    const b = resolveProjectDir('/data', '/foo/bar');
    expect(a).toBe(b);
  });

  it('produces different paths for different workDirs', () => {
    const a = resolveProjectDir('/data', '/foo/bar');
    const b = resolveProjectDir('/data', '/foo/baz');
    expect(a).not.toBe(b);
  });
});
