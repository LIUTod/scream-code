// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearDirCacheForTests, fetchDirEntries, invalidateDirEntry } from '../../src/web/frontend/src/utils/fileDirCache';

function stubFetch(impl: (url: string) => Promise<unknown>) {
  const mock = vi.fn(async (url: string) => {
    const data = await impl(url);
    return { ok: true, status: 200, json: async () => data } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('fileDirCache (G3.2 regression)', () => {
  beforeEach(() => {
    _clearDirCacheForTests();
  });

  it('dedupes concurrent requests for the same path', async () => {
    let calls = 0;
    const fetchMock = stubFetch(async () => {
      calls += 1;
      return { path: '/p', entries: [{ name: 'a.ts', path: '/p/a.ts', type: 'file', size: 0, mtime: 0 }] };
    });
    const [a, b] = await Promise.all([fetchDirEntries('/p'), fetchDirEntries('/p')]);
    expect(a).toEqual(b);
    expect(calls).toBe(1); // in-flight dedupe: single network call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidating a dir clears the in-flight request so refresh re-reads disk', async () => {
    let calls = 0;
    // First call hangs; second (post-invalidate) resolves.
    let release: ((v: unknown) => void) | null = null;
    stubFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return await new Promise((res) => {
          release = res;
        }).then(() => ({ path: '/q', entries: [] }));
      }
      return { path: '/q', entries: [{ name: 'fresh.ts', path: '/q/fresh.ts', type: 'file', size: 0, mtime: 0 }] };
    });
    const first = fetchDirEntries('/q'); // in-flight, never resolves yet
    invalidateDirEntry('/q'); // must drop the in-flight entry
    const after = await fetchDirEntries('/q'); // new request, resolves immediately
    expect(after![0]!.name).toBe('fresh.ts');
    expect(calls).toBe(2);
    release?.({ path: '/q', entries: [] });
    await first; // let the stale promise settle without unhandled rejection
  });

  it('caches within TTL', async () => {
    const fetchMock = stubFetch(async () => ({ path: '/c', entries: [] }));
    await fetchDirEntries('/c');
    await fetchDirEntries('/c');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
