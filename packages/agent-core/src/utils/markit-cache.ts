// Adapted from oh-my-pi's utils/markit-cache.ts (MIT). Filesystem cache for
// document → markdown conversions: one JSON entry per source digest, FIFO
// eviction by mtime against a coarse size cap.

import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveScreamHome } from '#/config/path';
import { log } from '#/logging/logger';
import { getCoreVersion } from '#/version';

/**
 * Cache schema/format revision. Converter *output* changes invalidate via the
 * package version folded into the key (see {@link markitConversionCacheKey}).
 */
export const MARKIT_CONVERSION_CACHE_VERSION = 1;
export const MAX_MARKIT_CONVERSION_CACHE_BYTES = 256 * 1024 * 1024;
/** `.tmp` files older than this are treated as orphaned writes and swept. */
const TMP_ORPHAN_MAX_AGE_MS = 5 * 60 * 1000;
export type MarkitConversionCacheStatus = 'hit' | 'miss' | 'skipped';

export type MarkitConversionCacheReadResult = { status: 'hit'; content: string } | { status: 'miss' };

interface MarkitConversionCacheEntry {
  version: number;
  content: string;
}

function documentConversionCacheDir(): string {
  return path.join(resolveScreamHome(), 'cache', 'document-conversion');
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function markitConversionCacheKey(bytes: Uint8Array, extension: string): string {
  const normalizedExtension = extension.trim().toLowerCase().replace(/^\.+/, '') || 'bin';
  const safeExtension = normalizedExtension.replace(/[^a-z0-9]+/g, '_') || 'bin';
  const safeVersion = getCoreVersion().replace(/[^a-z0-9]+/gi, '_');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return `v${String(MARKIT_CONVERSION_CACHE_VERSION)}-${safeVersion}-${safeExtension}-${digest}`;
}

function cacheEntryPath(key: string): string {
  return path.join(documentConversionCacheDir(), `${key}.json`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCacheEntry(raw: string): MarkitConversionCacheEntry | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (!('version' in parsed) || parsed.version !== MARKIT_CONVERSION_CACHE_VERSION) return null;
  if (!('content' in parsed) || typeof parsed.content !== 'string' || parsed.content.length === 0) {
    return null;
  }
  return { version: MARKIT_CONVERSION_CACHE_VERSION, content: parsed.content };
}

export async function readMarkitConversionCache(key: string): Promise<MarkitConversionCacheReadResult> {
  const target = cacheEntryPath(key);
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (!isEnoent(error)) {
      log.debug('document conversion cache read failed', { error: errorMessage(error) });
    }
    return { status: 'miss' };
  }

  let entry: MarkitConversionCacheEntry | null;
  try {
    entry = parseCacheEntry(raw);
  } catch (error) {
    log.debug('document conversion cache read failed', { error: errorMessage(error) });
    entry = null;
  }

  if (entry === null) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    return { status: 'miss' };
  }

  return { status: 'hit', content: entry.content };
}

async function pruneMarkitConversionCache(cacheDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(cacheDir);
  } catch (error) {
    if (!isEnoent(error)) {
      log.debug('document conversion cache prune failed', { error: errorMessage(error) });
    }
    return;
  }

  const now = Date.now();
  // Eviction is FIFO by mtime (not LRU): reads do not bump mtime, so a hot
  // entry written long ago is evicted before a cold recent miss. The cap is a
  // coarse disk-footprint safety valve, so the cheaper policy is intentional.
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const entryPath = path.join(cacheDir, name);
    let stat: Stats;
    try {
      stat = await fs.stat(entryPath);
    } catch (error) {
      if (!isEnoent(error)) {
        log.debug('document conversion cache prune failed', { error: errorMessage(error) });
      }
      continue;
    }
    if (!stat.isFile()) continue;

    // Sweep orphaned `.tmp` files left by a crash between writeFile and
    // rename; they never become `.json` entries.
    if (name.endsWith('.tmp')) {
      if (now - stat.mtimeMs > TMP_ORPHAN_MAX_AGE_MS) {
        await fs.rm(entryPath, { force: true }).catch(() => undefined);
      }
      continue;
    }

    if (!name.endsWith('.json')) continue;
    entries.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs });
    totalBytes += stat.size;
  }

  if (totalBytes <= MAX_MARKIT_CONVERSION_CACHE_BYTES) return;

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (totalBytes <= MAX_MARKIT_CONVERSION_CACHE_BYTES) break;
    try {
      await fs.rm(entry.path, { force: true });
      totalBytes -= entry.size;
    } catch (error) {
      if (!isEnoent(error)) {
        log.debug('document conversion cache prune failed', { error: errorMessage(error) });
      }
    }
  }
}

export async function writeMarkitConversionCache(key: string, content: string): Promise<void> {
  const cacheDir = documentConversionCacheDir();
  const target = path.join(cacheDir, `${key}.json`);
  // The random suffix keeps concurrent writers from colliding on one temp
  // path before the atomic rename.
  const tempPath = path.join(cacheDir, `${key}.${String(process.pid)}.${String(Date.now())}.${randomUUID()}.tmp`);
  const payload = JSON.stringify({ version: MARKIT_CONVERSION_CACHE_VERSION, content });
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(tempPath, payload);
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    log.debug('document conversion cache write failed', { error: errorMessage(error) });
    return;
  }

  // Prune is just GC: fire-and-forget rather than make the caller wait on a
  // readdir + N×stat sweep on every miss.
  void pruneMarkitConversionCache(cacheDir).catch((error: unknown) => {
    log.debug('document conversion cache prune failed', { error: errorMessage(error) });
  });
}
