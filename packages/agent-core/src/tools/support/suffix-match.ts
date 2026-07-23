// Path resilience helpers - suffix-match recovery and multi-path partitioning.
// Ported from omp read.ts:585-646 and path-utils.ts:897-922, adapted for
// scream-code's jian interface (async generator glob instead of native NAPI,
// jian.stat instead of Bun.file().stat()).

import type { Jian } from '@scream-code/jian';

import type { WorkspaceConfig } from './workspace';
import { resolvePathAccessPath } from '../policies/path-access';

const SUFFIX_MATCH_TIMEOUT_MS = 5000;

// Escape glob metacharacters using character-class [x] escaping because
// jian's glob layer treats backslash as a literal. Mirrors omp read.ts:600.
export function escapeGlobMetachars(value: string): string {
  return value.replaceAll(/[*?[{]/g, '[$&]');
}

export interface SuffixMatchResult {
  readonly absolutePath: string;
  readonly displayPath: string;
}

// Per-execute memoize. Map.get returning undefined means not probed yet;
// returning null means probed and confirmed miss. Not reused across executes
// to avoid stale paths. Mirrors omp read.ts:807, 899-909.
export type SuffixMatchCache = Map<string, SuffixMatchResult | null>;

// Glob with pattern "**/" + escaped basename under searchRoot and return
// the unique match. Returns null on zero matches, multiple matches
// (ambiguous), or timeout (5s). A missing searchRoot yields nothing from
// jian.glob and also resolves to null. Mirrors omp read.ts:609-646.
export async function findUniqueSuffixMatch(
  rawPath: string,
  searchRoot: string,
  jian: Jian,
  cache?: SuffixMatchCache,
): Promise<SuffixMatchResult | null> {
  const normalized = rawPath
    .replaceAll(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!normalized) return null;

  if (cache !== undefined) {
    const hit = cache.get(rawPath);
    if (hit !== undefined) return hit;
  }

  const pattern = `**/${escapeGlobMetachars(normalized)}`;
  const matches: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const globPromise = (async () => {
      for await (const filePath of jian.glob(searchRoot, pattern, { allowedRoots: [searchRoot] })) {
        matches.push(filePath);
        if (matches.length > 1) break;
      }
    })();
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SUFFIX_MATCH_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([globPromise, timeoutPromise]);
  } catch {
    if (cache !== undefined) cache.set(rawPath, null);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (matches.length !== 1) {
    if (cache !== undefined) cache.set(rawPath, null);
    return null;
  }

  const matched = matches[0]!;
  const result: SuffixMatchResult = {
    absolutePath: matched,
    displayPath: matched,
  };
  if (cache !== undefined) cache.set(rawPath, result);
  return result;
}

// Build the notice prepended to a read result when a path was recovered
// via suffix match. Mirrors omp read.ts:658-663.
export function suffixResolutionNotice(from: string, to: string): string {
  return `[Path '${from}' not found; resolved to '${to}' via suffix match]`;
}

export interface PartitionedPaths {
  readonly valid: string[];
  readonly missing: string[];
}

function isFileNotFoundErrorLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// Batch-stat paths and split into valid / missing. Only ENOENT / ENOTDIR are
// swallowed - other stat errors (permissions, IO) propagate. Paths are raw
// user input; each is resolved via resolvePathAccessPath before stat.
// Mirrors omp path-utils.ts:897-922.
export async function partitionExistingPaths(
  paths: string[],
  jian: Jian,
  workspace: WorkspaceConfig,
): Promise<PartitionedPaths> {
  const settled = await Promise.all(
    paths.map(async (path) => {
      try {
        const safePath = await resolvePathAccessPath(path, {
          jian,
          workspace,
          operation: 'read',
        });
        await jian.stat(safePath);
        return { path, exists: true } as const;
      } catch (error) {
        if (isFileNotFoundErrorLike(error)) return { path, exists: false } as const;
        throw error;
      }
    }),
  );
  const valid: string[] = [];
  const missing: string[] = [];
  for (const entry of settled) {
    if (entry.exists) valid.push(entry.path);
    else missing.push(entry.path);
  }
  return { valid, missing };
}
