/**
 * What background work did, as one short log the terminal reads: a job run
 * finished, work handed over or cut off was done, something waits for the
 * person. The host appends (`<home>/host/activity.jsonl`); the terminal shows
 * what happened since it was last open ("while you were away") and the
 * footer counts what waits. One line per entry, no conversation content.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getHostDir } from './control';

export interface ActivityEntry {
  readonly at: number;
  /** `health`: the background itself is in trouble (it keeps crashing, it cannot reach the model). */
  readonly kind: 'job' | 'continued' | 'waiting' | 'health';
  readonly title: string;
  /** Job run or continued work: whether it finished well. */
  readonly ok?: boolean | undefined;
  /** One line: a run's conclusion, a branch, what waits. */
  readonly detail?: string | undefined;
}

const MAX_BYTES = 512 * 1024;
const KEEP_LINES = 400;

function activityPath(): string {
  return join(getHostDir(), 'activity.jsonl');
}

function lastSeenPath(): string {
  return join(getHostDir(), 'last-seen.json');
}

function oneLine(text: string | undefined, max = 160): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')?.trim() ?? '';
  if (line === '') return undefined;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function appendActivity(entry: Omit<ActivityEntry, 'at'> & { readonly at?: number }): void {
  try {
    mkdirSync(getHostDir(), { recursive: true });
    const record: ActivityEntry = {
      at: entry.at ?? Date.now(),
      kind: entry.kind,
      title: oneLine(entry.title, 80) ?? entry.kind,
      ...(entry.ok === undefined ? {} : { ok: entry.ok }),
      ...(oneLine(entry.detail) === undefined ? {} : { detail: oneLine(entry.detail) }),
    };
    appendFileSync(activityPath(), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (statSync(activityPath()).size > MAX_BYTES) {
      const kept = readFileSync(activityPath(), 'utf8').trim().split('\n').slice(-KEEP_LINES);
      const temp = `${activityPath()}.${String(process.pid)}.tmp`;
      writeFileSync(temp, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, activityPath());
    }
  } catch {
    // A record of what happened must never break the work itself.
  }
}

export function readActivitySince(since: number): ActivityEntry[] {
  let text: string;
  try {
    text = readFileSync(activityPath(), 'utf8');
  } catch {
    return [];
  }
  const entries: ActivityEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as ActivityEntry;
      if (typeof entry.at === 'number' && entry.at > since) entries.push(entry);
    } catch {
      // Skip a torn line.
    }
  }
  return entries;
}

/** When a terminal was last open (its exit, or its start); 0 when never. */
export function readLastSeen(): number {
  try {
    const parsed = JSON.parse(readFileSync(lastSeenPath(), 'utf8')) as { at?: unknown };
    return typeof parsed.at === 'number' ? parsed.at : 0;
  } catch {
    return 0;
  }
}

export function writeLastSeen(at: number = Date.now()): void {
  try {
    mkdirSync(getHostDir(), { recursive: true });
    writeFileSync(lastSeenPath(), `${JSON.stringify({ at })}\n`, 'utf8');
  } catch {
    // best-effort
  }
}
