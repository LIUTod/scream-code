import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-plugin usage metrics (calls / okCalls / lastUsedAt) kept OUT of the
 * plugin-table snapshot: they change far more often than configuration and
 * are advisory signals, not configuration. Stored as a small sidecar file so
 * table rewrites stay rare and the whole-file writer keeps its meaning.
 *
 * Write model: a BASE layer (loaded lazily from disk once per home) plus a
 * DELTA layer mutated synchronously by counters — so a bump never races the
 * lazy load. One debounced timer (5s) merges deltas onto base and writes;
 * management mutations force-flush. A crash may lose the last few seconds of
 * counts — accepted, these numbers feed keep/remove suggestions, not billing.
 */

export interface UsageStats {
  readonly calls: number;
  readonly okCalls: number;
  readonly lastUsedAt: string | undefined;
}

interface MutableUsageStats {
  calls: number;
  okCalls: number;
  lastUsedAt: string | undefined;
}

interface StatsDelta {
  calls: number;
  okCalls: number;
  lastUsedAt: string;
}

interface StatsFile {
  readonly version: 1;
  readonly byId: Record<string, UsageStats>;
}

const STATS_DEBOUNCE_MS = 5_000;

const caches = new Map<
  string,
  {
    loaded: boolean;
    base: Map<string, MutableUsageStats>;
    deltas: Map<string, StatsDelta>;
    timer: ReturnType<typeof setTimeout> | undefined;
  }
>();

function statsPath(screamHomeDir: string): string {
  return path.join(screamHomeDir, 'plugins', 'stats.json');
}

function cacheFor(screamHomeDir: string): {
  loaded: boolean;
  base: Map<string, MutableUsageStats>;
  deltas: Map<string, StatsDelta>;
  timer: ReturnType<typeof setTimeout> | undefined;
} {
  let cache = caches.get(screamHomeDir);
  if (cache === undefined) {
    cache = { loaded: false, base: new Map(), deltas: new Map(), timer: undefined };
    caches.set(screamHomeDir, cache);
  }
  return cache;
}

async function loadIntoCache(screamHomeDir: string): Promise<Map<string, MutableUsageStats>> {
  const cache = cacheFor(screamHomeDir);
  if (cache.loaded) return cache.base;
  try {
    const raw: unknown = JSON.parse(await readFile(statsPath(screamHomeDir), 'utf8'));
    const byId = (raw as { byId?: Record<string, UsageStats> }).byId ?? {};
    for (const [id, entry] of Object.entries(byId)) {
      if (typeof entry.calls === 'number' && typeof entry.okCalls === 'number') {
        cache.base.set(id, {
          calls: entry.calls,
          okCalls: entry.okCalls,
          lastUsedAt: entry.lastUsedAt,
        });
      }
    }
  } catch {
    // No file yet: start empty.
  }
  cache.loaded = true;
  return cache.base;
}

function mergeEntry(entry: MutableUsageStats, delta: StatsDelta): void {
  entry.calls += delta.calls;
  entry.okCalls += delta.okCalls;
  entry.lastUsedAt = delta.lastUsedAt;
}

/** Effective view = base ⊕ current deltas (deltas survive independently of load timing). */
async function effectiveEntries(
  screamHomeDir: string,
): Promise<Map<string, MutableUsageStats>> {
  const cache = cacheFor(screamHomeDir);
  const base = await loadIntoCache(screamHomeDir);
  if (cache.deltas.size === 0) return base;
  const merged = new Map(base);
  for (const [id, delta] of cache.deltas) {
    const entry = { ...merged.get(id) ?? { calls: 0, okCalls: 0, lastUsedAt: undefined } };
    mergeEntry(entry, delta);
    merged.set(id, entry);
  }
  return merged;
}

/** Force-write base⊕deltas for one home; safe to call repeatedly. */
export async function flushStats(screamHomeDir: string): Promise<void> {
  const cache = cacheFor(screamHomeDir);
  if (cache.timer !== undefined) {
    clearTimeout(cache.timer);
    cache.timer = undefined;
  }
  const base = await loadIntoCache(screamHomeDir);
  for (const [id, delta] of cache.deltas) {
    const entry = base.get(id) ?? { calls: 0, okCalls: 0, lastUsedAt: undefined };
    mergeEntry(entry, delta);
    base.set(id, entry);
  }
  cache.deltas.clear();
  const byId: Record<string, UsageStats> = {};
  for (const [id, entry] of base) {
    byId[id] = { ...entry };
  }
  await mkdir(path.dirname(statsPath(screamHomeDir)), { recursive: true });
  const file: StatsFile = { version: 1, byId };
  await writeFile(statsPath(screamHomeDir), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Arm the debounced writer at most once per home (first-schedule semantics). */
function ensureFlushScheduled(screamHomeDir: string): void {
  const cache = cacheFor(screamHomeDir);
  if (cache.timer !== undefined) return;
  cache.timer = setTimeout(() => {
    cache.timer = undefined;
    // Never let a background stats write surface as an unhandled rejection.
    void flushStats(screamHomeDir).catch(() => {});
  }, STATS_DEBOUNCE_MS);
}

/** Synchronous counter bump into the delta layer; disk write is debounced. */
export function recordUsageInMemory(
  screamHomeDir: string,
  pluginId: string,
  ok: boolean,
): void {
  const cache = cacheFor(screamHomeDir);
  const existing = cache.deltas.get(pluginId) ?? {
    calls: 0,
    okCalls: 0,
    lastUsedAt: new Date().toISOString(),
  };
  cache.deltas.set(pluginId, {
    calls: existing.calls + 1,
    okCalls: existing.okCalls + (ok ? 1 : 0),
    lastUsedAt: new Date().toISOString(),
  });
  void loadIntoCache(screamHomeDir);
  ensureFlushScheduled(screamHomeDir);
}

/** Drop counters for a removed/uninstalled plugin id (base and deltas).
 * Best-effort: the in-memory delete always happens; a failed disk flush must
 * never fail the removal whose caller depends on it. */
export async function forgetStats(screamHomeDir: string, pluginId: string): Promise<void> {
  const cache = cacheFor(screamHomeDir);
  cache.deltas.delete(pluginId);
  const base = await loadIntoCache(screamHomeDir);
  base.delete(pluginId);
  try {
    await flushStats(screamHomeDir);
  } catch {
    // The counters are gone from memory; a failed stats write is not a
    // reason to abort removing the plugin itself.
  }
}

/** Read-through snapshot used by tool surfaces (check/list views). */
export async function getUsage(screamHomeDir: string, pluginId: string): Promise<UsageStats> {
  const entries = await effectiveEntries(screamHomeDir);
  return entries.get(pluginId) ?? { calls: 0, okCalls: 0, lastUsedAt: undefined };
}
