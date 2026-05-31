import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { targetSessionIndex } from './paths.js';

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export async function appendSessionIndexEntry(
  targetHome: string,
  entry: SessionIndexEntry,
): Promise<void> {
  const path = targetSessionIndex(targetHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Idempotently ensure `entry` is present in `session_index.jsonl`.
 *
 * Appends the entry only when no existing line carries the same `sessionId`.
 * Used for the `already-migrated` re-run path: if a prior run wrote the session
 * directory but crashed before appending its index entry, this self-heals the
 * index on a subsequent run instead of leaving the session permanently
 * unreachable by id.
 */
export async function ensureSessionIndexEntry(
  targetHome: string,
  entry: SessionIndexEntry,
): Promise<void> {
  const path = targetSessionIndex(targetHome);
  if (await hasSessionIndexEntry(path, entry.sessionId)) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8');
}

async function hasSessionIndexEntry(path: string, sessionId: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { sessionId?: unknown }).sessionId === sessionId
      ) {
        return true;
      }
    } catch {
      // Skip malformed lines — treat them as absent entries.
    }
  }
  return false;
}
