// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearDirCacheForTests, _dirCacheSizeForTests, fetchDirEntries, invalidateDirEntry } from '../../src/web/frontend/src/utils/fileDirCache';

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
        return new Promise((res) => {
          release = res;
        }).then(() => ({ path: '/q', entries: [] }));
      }
      return { path: '/q', entries: [{ name: 'fresh.ts', path: '/q/fresh.ts', type: 'file', size: 0, mtime: 0 }] };
    });
    const first = fetchDirEntries('/q'); // in-flight, never resolves yet
    invalidateDirEntry('/q'); // must drop the in-flight entry
    const after = await fetchDirEntries('/q'); // new request, resolves immediately
    expect(after?.[0]?.name).toBe('fresh.ts');
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

  it('drops an expired entry instead of serving it from cache', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(async () => ({
        path: '/exp',
        entries: [{ name: 'a.ts', path: '/exp/a.ts', type: 'file', size: 0, mtime: 0 }],
      }));
      await fetchDirEntries('/exp');
      expect(_dirCacheSizeForTests()).toBe(1);

      // Past the TTL the stale record must be dropped, not merely ignored: a
      // failed re-read must not leave it (or a client would serve it forever).
      vi.setSystemTime(Date.now() + 30_001);
      stubFetch(async () => {
        throw new Error('offline');
      });
      expect(await fetchDirEntries('/exp')).toBeNull();
      expect(_dirCacheSizeForTests()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest listing past the 200-entry capacity cap', async () => {
    stubFetch(async (url) => {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      return { path, entries: [{ name: 'x', path: `${path}/x`, type: 'file', size: 0, mtime: 0 }] };
    });
    for (let i = 0; i < 205; i++) {
      await fetchDirEntries(`/dir-${i}`);
    }
    expect(_dirCacheSizeForTests()).toBe(200);

    // FIFO: /dir-0..4 were dropped, /dir-204 is still cached. A probe stub
    // proves it — only the evicted path goes back to the network.
    const probe = stubFetch(async (url) => {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      return { path, entries: [] };
    });
    await fetchDirEntries('/dir-204');
    expect(probe).not.toHaveBeenCalled();
    await fetchDirEntries('/dir-0');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
