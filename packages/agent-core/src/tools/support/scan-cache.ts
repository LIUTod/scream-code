/**
 * Process-local cache for filesystem scan results (Glob tool only).
 *
 * Large repositories spend a lot of wall-clock time re-walking the same
 * directory trees across consecutive Glob calls. This cache keeps the most
 * recent Glob outputs in-process for a short TTL, keyed by search root,
 * pattern, and include-dirs flag. It is invalidated aggressively on any file
 * write so correctness is preserved at minimal complexity.
 *
 * NOTE: This cache intentionally covers only the Glob tool. Grep uses
 * ripgrep's own traversal, and list-directory is used only for error hints.
 */

interface CacheEntry {
  readonly output: string;
  readonly createdAt: number;
}

export interface FsScanCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export class FsScanCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor({ ttlMs = 1000, maxEntries = 16 }: FsScanCacheOptions = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  private key(root: string, pattern: string, includeDirs: boolean): string {
    return `${root}\0${pattern}\0${String(includeDirs)}`;
  }

  /**
   * Returns the cached output if present and not expired. Expired entries are
   * deleted on access.
   */
  get(root: string, pattern: string, includeDirs: boolean): string | undefined {
    const k = this.key(root, pattern, includeDirs);
    const entry = this.cache.get(k);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(k);
      return undefined;
    }
    return entry.output;
  }

  /** Cache a scan output. Evicts the oldest entry when at capacity. */
  set(root: string, pattern: string, includeDirs: boolean, output: string): void {
    if (this.cache.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(this.key(root, pattern, includeDirs), {
      output,
      createdAt: Date.now(),
    });
  }

  /** Invalidate all cached entries rooted under the given directory path. */
  invalidateByRoot(root: string): void {
    const prefix = `${root}\0`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }

  /** Clear the entire cache (useful for tests). */
  clear(): void {
    this.cache.clear();
  }

  /** Number of cached entries (for tests / introspection). */
  size(): number {
    return this.cache.size;
  }
}

/**
 * Module-level singleton shared by Glob (producer) and Edit/Write (invalidator).
 * Importing this instance ensures all tools reference the same cache.
 */
export const scanCache = new FsScanCache();
