import { describe, expect, it } from 'vitest';

import { isPathInside, isSafeRelativePath } from '../../src/utils/path-safety';

describe('isPathInside', () => {
  it('accepts the base itself and its descendants', () => {
    expect(isPathInside('/work', '/work')).toBe(true);
    expect(isPathInside('/work', '/work/sub/file.ts')).toBe(true);
    expect(isPathInside('/work', 'sub/file.ts')).toBe(true);
    expect(isPathInside('/work', './file.ts')).toBe(true);
    expect(isPathInside('/work', 'sub/../file.ts')).toBe(true);
    expect(isPathInside('/work/', './file.ts')).toBe(true);
  });

  it('rejects paths outside the base', () => {
    expect(isPathInside('/work', '/other/file.ts')).toBe(false);
    expect(isPathInside('/work', '../outside/file.ts')).toBe(false);
    expect(isPathInside('/work', '/work-evil/file.ts')).toBe(false);
  });

  it('judges POSIX-absolute candidates as written, not against the base', () => {
    // A relative base plus a POSIX-absolute candidate is not "inside" by
    // accident of joining — the candidate names its own root.
    expect(isPathInside('/work', '/other/file.ts')).toBe(false);
  });

  it('treats Windows drive and UNC candidates as absolute on any host', () => {
    expect(isPathInside('/work', String.raw`C:\outside\f.txt`)).toBe(false);
    expect(isPathInside('/work', 'C:/outside/f.txt')).toBe(false);
    expect(isPathInside('/work', String.raw`C:outside\f.txt`)).toBe(false);
    expect(isPathInside('/work', String.raw`\\server\share\f.txt`)).toBe(false);
    expect(isPathInside('/work', '//server/share/f.txt')).toBe(false);
  });

  it('reads a leading `//` as UNC only next to a Windows base', () => {
    // `//work/file.ts` from a POSIX caller is the POSIX path `/work/file.ts`.
    // Reading the doubled slash as UNC would judge the file to be outside the
    // very directory it names.
    expect(isPathInside('/work', '//work/file.ts')).toBe(true);
    expect(isPathInside('/work', '//work/sub/file.ts')).toBe(true);
    expect(isPathInside('/work', '//other/file.ts')).toBe(false);
    // A Windows base keeps both spellings UNC, and the backslash spelling stays
    // UNC next to a POSIX base as well — collapsing that one would widen the
    // check rather than narrow it.
    expect(isPathInside(String.raw`\\server\share`, '//server/share/f.ts')).toBe(true);
    expect(isPathInside(String.raw`\\server\share`, '//other/share/f.ts')).toBe(false);
    expect(isPathInside('/work', String.raw`\\work\file.ts`)).toBe(false);
    expect(isPathInside('/work', String.raw`\\server\share\f.ts`)).toBe(false);
  });

  it('keeps a Windows base and its descendants together', () => {
    expect(isPathInside(String.raw`C:\work`, String.raw`C:\work\sub\f.ts`)).toBe(true);
    expect(isPathInside('C:\\work', 'sub/f.ts')).toBe(true);
    expect(isPathInside(String.raw`C:\work`, String.raw`C:\outside\f.ts`)).toBe(false);
    expect(isPathInside(String.raw`C:\work`, String.raw`C:\work-evil\f.ts`)).toBe(false);
    expect(isPathInside(String.raw`\\server\share`, String.raw`\\server\share\f.ts`)).toBe(true);
  });

  it('compares Windows paths case-insensitively', () => {
    expect(isPathInside(String.raw`C:\work`, String.raw`c:\WORK\sub\f.ts`)).toBe(true);
    expect(isPathInside(String.raw`\\server\share`, String.raw`\\SERVER\SHARE\f.ts`)).toBe(true);
    // POSIX bases stay case-sensitive.
    expect(isPathInside('/work', '/WORK/file.ts')).toBe(false);
  });
});

describe('isSafeRelativePath', () => {
  it('accepts plain relative paths', () => {
    for (const candidate of [
      'file.txt',
      'sub/file.txt',
      'sub/../file.txt',
      'sub/',
      '.env.example',
      '..foo.txt',
      'a-b_c.md',
    ]) {
      expect(isSafeRelativePath(candidate)).toBe(true);
    }
  });

  it('rejects POSIX-absolute, drive-qualified and UNC paths', () => {
    for (const candidate of [
      '/etc/passwd',
      '//server/share/f.txt',
      String.raw`\Windows\x.txt`,
      String.raw`C:\outside\f.txt`,
      'C:/outside/f.txt',
      String.raw`C:outside\f.txt`,
      String.raw`\\server\share\f.txt`,
    ]) {
      expect(isSafeRelativePath(candidate)).toBe(false);
    }
  });

  it('rejects paths that climb out of the directory', () => {
    for (const candidate of ['..', '../f.txt', '../../f.txt', 'sub/../../f.txt', 'sub/..']) {
      expect(isSafeRelativePath(candidate)).toBe(false);
    }
  });

  it('rejects the empty path and the current directory', () => {
    for (const candidate of ['', '   ', '.']) {
      expect(isSafeRelativePath(candidate)).toBe(false);
    }
  });
});
