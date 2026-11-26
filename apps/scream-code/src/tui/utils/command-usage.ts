/**
 * Which slash commands the person actually runs, kept in
 * `<dataDir>/command-usage.json` so the menu can put them first.
 *
 * Each command keeps a count and the time of its last use. Its weight is the
 * count halved for every {@link HALF_LIFE_DAYS} days since: a command used
 * ten times last year loses to one used twice this week, and a command that
 * stops being used fades without anything having to be forgotten explicitly.
 * Persistence is best effort — a failed read or write is never an error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SCREAM_CODE_COMMAND_USAGE_FILE_NAME } from '#/constant/app';
import { getDataDir } from '#/utils/paths';

interface UsageEntry {
  count: number;
  /** Epoch milliseconds of the last use. */
  last: number;
}

const HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;
/** The file never holds more than this many commands: the lightest are dropped. */
const MAX_ENTRIES = 200;
/** Commands shown first in an empty menu. */
export const RECENT_COMMAND_LIMIT = 5;

let cache: Map<string, UsageEntry> | undefined;

function usagePath(): string {
  return join(getDataDir(), SCREAM_CODE_COMMAND_USAGE_FILE_NAME);
}

function load(): Map<string, UsageEntry> {
  if (cache !== undefined) return cache;
  const entries = new Map<string, UsageEntry>();
  try {
    const file = usagePath();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<UsageEntry>>;
      for (const [name, entry] of Object.entries(parsed)) {
        if (typeof entry.count === 'number' && typeof entry.last === 'number' && entry.count > 0) {
          entries.set(name, { count: entry.count, last: entry.last });
        }
      }
    }
  } catch {
    // A corrupt file starts the counts over; it is only a convenience.
  }
  cache = entries;
  return entries;
}

function weight(entry: UsageEntry, now: number): number {
  const ageDays = Math.max(0, now - entry.last) / DAY_MS;
  return entry.count * 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

/** How much a command has been used lately; 0 when never. */
export function commandUsageWeight(name: string, now: number = Date.now()): number {
  const entry = load().get(name);
  return entry === undefined ? 0 : weight(entry, now);
}

/** Notes that `name` was run. */
export function recordCommandUse(name: string, now: number = Date.now()): void {
  if (name.length === 0) return;
  // Read the file again first: another terminal may have recorded since this
  // one loaded it, and writing back our copy would erase what it added.
  cache = undefined;
  const entries = load();
  const known = entries.get(name);
  entries.set(name, { count: (known?.count ?? 0) + 1, last: now });
  if (entries.size > MAX_ENTRIES) {
    const lightest = [...entries.entries()].toSorted((a, b) => weight(a[1], now) - weight(b[1], now));
    for (const [drop] of lightest.slice(0, entries.size - MAX_ENTRIES)) entries.delete(drop);
  }
  try {
    const file = usagePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(entries)), 'utf8');
  } catch {
    // Best effort.
  }
}

/** The most used of `candidates`, heaviest first, at most `limit`. */
export function mostUsedCommands(
  candidates: readonly string[],
  limit: number = RECENT_COMMAND_LIMIT,
  now: number = Date.now(),
): string[] {
  return candidates
    .map((name) => ({ name, weight: commandUsageWeight(name, now) }))
    .filter((entry) => entry.weight > 0)
    .toSorted((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((entry) => entry.name);
}

/** Forgets what was read from disk (tests, and a data directory that changed). */
export function resetCommandUsage(): void {
  cache = undefined;
}
