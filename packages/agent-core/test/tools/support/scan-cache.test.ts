import { describe, expect, it, vi } from 'vitest';

import { FsScanCache } from '../../../src/tools/support/scan-cache';

describe('FsScanCache', () => {
  it('returns undefined for uncached key', () => {
    const cache = new FsScanCache();
    expect(cache.get('/ws', 'src/**/*.ts', true)).toBeUndefined();
  });

  it('caches and returns output', () => {
    const cache = new FsScanCache();
    cache.set('/ws', 'src/**/*.ts', true, 'file.ts');
    expect(cache.get('/ws', 'src/**/*.ts', true)).toBe('file.ts');
  });

  it('treats different includeDirs values as different keys', () => {
    const cache = new FsScanCache();
    cache.set('/ws', 'src/**/*.ts', true, 'with-dirs');
    expect(cache.get('/ws', 'src/**/*.ts', false)).toBeUndefined();
    expect(cache.get('/ws', 'src/**/*.ts', true)).toBe('with-dirs');
  });

  it('treats different roots as different keys', () => {
    const cache = new FsScanCache();
    cache.set('/ws-a', 'src/**/*.ts', true, 'a');
    cache.set('/ws-b', 'src/**/*.ts', true, 'b');
    expect(cache.get('/ws-a', 'src/**/*.ts', true)).toBe('a');
    expect(cache.get('/ws-b', 'src/**/*.ts', true)).toBe('b');
  });

  it('treats different patterns as different keys', () => {
    const cache = new FsScanCache();
    cache.set('/ws', 'src/**/*.ts', true, 'ts');
    cache.set('/ws', 'src/**/*.js', true, 'js');
    expect(cache.get('/ws', 'src/**/*.ts', true)).toBe('ts');
    expect(cache.get('/ws', 'src/**/*.js', true)).toBe('js');
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    const cache = new FsScanCache({ ttlMs: 100 });
    cache.set('/ws', 'src/**/*.ts', true, 'file.ts');
    expect(cache.get('/ws', 'src/**/*.ts', true)).toBe('file.ts');

    vi.advanceTimersByTime(101);
    expect(cache.get('/ws', 'src/**/*.ts', true)).toBeUndefined();
    vi.useRealTimers();
  });

  it('evicts oldest entry when at capacity', () => {
    const cache = new FsScanCache({ maxEntries: 2 });
    cache.set('/ws', 'a', true, 'A');
    cache.set('/ws', 'b', true, 'B');
    cache.set('/ws', 'c', true, 'C');

    expect(cache.get('/ws', 'a', true)).toBeUndefined();
    expect(cache.get('/ws', 'b', true)).toBe('B');
    expect(cache.get('/ws', 'c', true)).toBe('C');
  });

  it('invalidates by root prefix', () => {
    const cache = new FsScanCache();
    cache.set('/workspace', 'src/**/*.ts', true, 'ts');
    cache.set('/workspace', 'test/**/*.ts', true, 'test');
    cache.set('/other', 'src/**/*.ts', true, 'other');

    cache.invalidateByRoot('/workspace');
    expect(cache.get('/workspace', 'src/**/*.ts', true)).toBeUndefined();
    expect(cache.get('/workspace', 'test/**/*.ts', true)).toBeUndefined();
    expect(cache.get('/other', 'src/**/*.ts', true)).toBe('other');
  });

  it('invalidateByRoot does not delete entries with similar but unrelated root', () => {
    const cache = new FsScanCache();
    cache.set('/workspace-2', 'src/**/*.ts', true, 'other');
    cache.invalidateByRoot('/workspace');
    expect(cache.get('/workspace-2', 'src/**/*.ts', true)).toBe('other');
  });

  it('clear removes all entries', () => {
    const cache = new FsScanCache();
    cache.set('/ws', 'a', true, 'A');
    cache.set('/ws', 'b', true, 'B');
    cache.clear();
    expect(cache.get('/ws', 'a', true)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});
