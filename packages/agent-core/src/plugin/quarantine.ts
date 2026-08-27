import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Immune memory for the plugin center: an append-only ledger of sources that
 * produced circuit-tripped plugins. The next session reads the same file and
 * sees "this origin burned us before" — without trusting any model memory.
 *
 * Write model: tail-append with a FIFO cap (oldest dropped beyond 200);
 * acknowledged entries stay for audit but stop triggering warnings.
 */

export interface QuarantineEntry {
  readonly at: string;
  readonly pluginId: string;
  readonly name?: string;
  /** Normalized origin key: `github:<owner>/<repo>` for repos, else the raw source string. */
  readonly sourceKey: string;
  readonly reason: string;
  readonly acknowledgedAt?: string;
}

interface QuarantineFile {
  readonly version: 1;
  readonly entries: QuarantineEntry[];
}

const QUARANTINE_MAX = 200;

function quarantinePath(screamHomeDir: string): string {
  return path.join(screamHomeDir, 'plugins', 'quarantine.json');
}

/** Normalize a raw user-provided source string into its origin key. */
export function sourceKeyFromRawSource(source: string): string {
  const trimmed = source.trim();
  const github = trimmed.match(/github\.com[/]([^/]+)[/]([^/#?\s]+)/);
  if (github !== null) return `github:${github[1]}/${github[2]}`;
  return trimmed;
}

/** Origin key for an installed record's persisted fields. */
export function sourceKeyFromFields(fields: {
  github?: { owner: string; repo: string };
  originalSource?: string;
}): string {
  if (fields.github !== undefined) return `github:${fields.github.owner}/${fields.github.repo}`;
  return fields.originalSource ?? '';
}

export async function readQuarantine(screamHomeDir: string): Promise<QuarantineEntry[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(quarantinePath(screamHomeDir), 'utf8'));
    const entries = (raw as { entries?: unknown }).entries;
    return Array.isArray(entries) ? (entries as QuarantineEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendQuarantine(
  screamHomeDir: string,
  entry: QuarantineEntry,
): Promise<void> {
  const entries = await readQuarantine(screamHomeDir);
  entries.push(entry);
  const bounded = entries.slice(-QUARANTINE_MAX);
  const file: QuarantineFile = { version: 1, entries: bounded };
  await mkdir(path.dirname(quarantinePath(screamHomeDir)), { recursive: true });
  await writeFile(quarantinePath(screamHomeDir), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Mark the newest unacknowledged entry for this key; no-op when absent. */
export async function acknowledgeQuarantine(
  screamHomeDir: string,
  sourceKey: string,
): Promise<void> {
  const entries = await readQuarantine(screamHomeDir);
  const now = new Date().toISOString();
  let changed = false;
  // Acknowledge EVERY unacknowledged entry for this origin, not just the
  // newest: a repository that tripped several times must stop warning once
  // the user has approved and installed from it. Marking only one would leave
  // older unacknowledged entries firing the warning forever.
  for (let index = 0; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (candidate === undefined) continue;
    if (candidate.sourceKey === sourceKey && candidate.acknowledgedAt === undefined) {
      entries[index] = { ...candidate, acknowledgedAt: now };
      changed = true;
    }
  }
  // No change → no write (avoids creating an empty ledger on a clean install).
  if (!changed) return;
  const file: QuarantineFile = { version: 1, entries };
  await writeFile(quarantinePath(screamHomeDir), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Newest unacknowledged entry for a normalized origin key, if any. */
export function matchQuarantine(
  entries: readonly QuarantineEntry[],
  sourceKey: string,
): QuarantineEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (candidate === undefined) continue;
    if (candidate.sourceKey === sourceKey && candidate.acknowledgedAt === undefined) {
      return candidate;
    }
  }
  return undefined;
}
