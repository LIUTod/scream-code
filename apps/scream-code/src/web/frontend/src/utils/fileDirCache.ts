/**
 * Shared directory listing cache for the read-only /files REST surface.
 *
 * Both the composer @-mention menu and the sidebar file tree list directories
 * through GET /files/list?path=<abs>; this module holds ONE cache (30s TTL,
 * in-flight de-dup) so the two surfaces never issue duplicate fetches for the
 * same directory and always agree on what is loaded.
 */
const API = '/api/v1/files';
const DIR_TTL_MS = 30_000;

export interface ServerFileEntry {
  /** Basename only. */
  name: string;
  /** Absolute path (the file gate resolves the candidate and joins names). */
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

interface DirRecord {
  entries: ServerFileEntry[];
  at: number;
}

/** Absolute dir path → cached listing (both contents and fetch-time). */
const dirCache = new Map<string, DirRecord>();
/** Absolute dir path → in-flight promise, so concurrent requests share one. */
const inFlight = new Map<string, Promise<ServerFileEntry[] | null>>();

/**
 * List a directory (absolute path). Returns the entries, or null when the
 * request failed (callers decide how to surface the miss). Cached for 30s;
 * a failed fetch is NOT cached so retrying re-attempts immediately.
 */
export async function fetchDirEntries(abs: string): Promise<ServerFileEntry[] | null> {
  const cached = dirCache.get(abs);
  if (cached && Date.now() - cached.at < DIR_TTL_MS) return cached.entries;

  const pending = inFlight.get(abs);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const res = await fetch(`${API}/list?path=${encodeURIComponent(abs)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { entries: ServerFileEntry[] };
      if (data.entries) dirCache.set(abs, { entries: data.entries, at: Date.now() });
      return data.entries ?? null;
    } catch {
      return null;
    } finally {
      inFlight.delete(abs);
    }
  })();
  inFlight.set(abs, promise);
  return promise;
}

/** Drop a cached listing (used by manual refresh). Also clear any in-flight
 *  request for the same path, otherwise a refresh would resolve from the stale
 *  promise instead of the disk. */
export function invalidateDirEntry(abs: string): void {
  dirCache.delete(abs);
  inFlight.delete(abs);
}

/** Test helper: clear the whole cache. */
export function _clearDirCacheForTests(): void {
  dirCache.clear();
  inFlight.clear();
}
