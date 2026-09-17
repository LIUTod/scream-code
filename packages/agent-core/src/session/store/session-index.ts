import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

/**
 * Process-local cache for the parsed session index. `readSessionIndex` is
 * called on every session lookup and every `listAll`, and the file grows with
 * the number of sessions, so re-reading and re-parsing the whole file per
 * call is pure waste. The cache is validated by the file's mtime and size, so
 * writes from other processes (which bump the mtime) are always picked up;
 * our own writes invalidate explicitly.
 */
interface SessionIndexCache {
  homeDir: string;
  mtimeMs: number;
  size: number;
  map: Map<string, SessionIndexEntry>;
}

let sessionIndexCache: SessionIndexCache | undefined;

function invalidateSessionIndexCache(): void {
  sessionIndexCache = undefined;
}

export function sessionIndexPath(homeDir: string): string {
  return join(homeDir, 'session_index.jsonl');
}

export async function appendSessionIndexEntry(
  homeDir: string,
  entry: SessionIndexEntry,
): Promise<void> {
  const indexPath = sessionIndexPath(homeDir);
  await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
  await appendFile(indexPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  invalidateSessionIndexCache();
}

export async function readSessionIndex(
  homeDir: string,
  sessionsDir: string,
): Promise<Map<string, SessionIndexEntry>> {
  const indexPath = sessionIndexPath(homeDir);
  let stats;
  try {
    stats = await stat(indexPath);
  } catch {
    sessionIndexCache = undefined;
    return new Map();
  }

  const cached = sessionIndexCache;
  if (
    cached !== undefined &&
    cached.homeDir === homeDir &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size
  ) {
    return cached.map;
  }

  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf-8');
  } catch {
    sessionIndexCache = undefined;
    return new Map();
  }

  const result = new Map<string, SessionIndexEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = parseIndexLine(trimmed);
    if (entry === undefined) continue;
    const sessionDir = resolve(entry.sessionDir);
    if (!isAbsolute(entry.sessionDir)) continue;
    if (!isAbsolute(entry.workDir)) continue;
    if (!isPathInside(sessionsDir, sessionDir)) continue;
    if (basename(sessionDir) !== entry.sessionId) continue;
    result.set(entry.sessionId, {
      sessionId: entry.sessionId,
      sessionDir,
      workDir: resolve(entry.workDir),
    });
  }
  sessionIndexCache = { homeDir, mtimeMs: stats.mtimeMs, size: stats.size, map: result };
  return result;
}

export async function removeSessionIndexEntry(homeDir: string, sessionId: string): Promise<void> {
  const indexPath = sessionIndexPath(homeDir);
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf-8');
  } catch {
    return;
  }

  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = parseIndexLine(trimmed);
    if (entry === undefined || entry.sessionId === sessionId) continue;
    kept.push(line);
  }

  if (kept.length === 0) {
    await writeFile(indexPath, '', 'utf-8');
  } else {
    await writeFile(indexPath, kept.join('\n') + '\n', 'utf-8');
  }
  invalidateSessionIndexCache();
}

function parseIndexLine(line: string): SessionIndexEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexEntry>;
    if (
      typeof entry.sessionId !== 'string' ||
      typeof entry.sessionDir !== 'string' ||
      typeof entry.workDir !== 'string'
    ) {
      return undefined;
    }
    return {
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      workDir: entry.workDir,
    };
  } catch {
    return undefined;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
