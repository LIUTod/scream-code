import { writeUpdateCache } from './cache';
import { fetchLatestVersionFromCdn } from './cdn';
import { type UpdateCache } from './types';

export interface RefreshUpdateCacheDeps {
  /** Resolves with the latest semver. **Throws** on any failure — callers
   * (including the default background invocation in preflight) must catch.
   * Errors intentionally skip `writeCache` so a transient CDN blip does not
   * overwrite a previously known `latest` with `null`. */
  readonly fetchLatest: () => Promise<string>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
}

export async function refreshUpdateCache(
  overrides: Partial<RefreshUpdateCacheDeps> = {},
): Promise<UpdateCache> {
  const resolved: RefreshUpdateCacheDeps = {
    fetchLatest: overrides.fetchLatest ?? (() => fetchLatestVersionFromCdn()),
    writeCache: overrides.writeCache ?? writeUpdateCache,
    now: overrides.now ?? (() => new Date()),
  };

  const latest = await resolved.fetchLatest();
  const cache: UpdateCache = {
    source: 'cdn',
    checkedAt: resolved.now().toISOString(),
    latest,
  };
  await resolved.writeCache(cache);
  return cache;
}
