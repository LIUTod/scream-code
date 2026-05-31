import { readFile, writeFile } from 'node:fs/promises';
import { migratedMarker } from './paths.js';

export interface MarkerRun {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly migratorVersion: string;
  readonly summary: Record<string, unknown>;
}

export interface MarkerData {
  readonly version: 1;
  readonly first_migrated_at: string;
  readonly last_migrated_at: string;
  readonly migrator_version: string;
  readonly target_path: string;
  readonly runs: readonly MarkerRun[];
}

export async function readMarker(sourceHome: string): Promise<MarkerData | undefined> {
  try {
    const text = await readFile(migratedMarker(sourceHome), 'utf-8');
    const parsed = JSON.parse(text) as Partial<MarkerData>;
    if (parsed.version !== 1) return undefined;
    // A partially-written or hand-edited marker may keep `version` but lack a
    // valid `runs` array; treating it as absent avoids `appendMarkerRun`
    // throwing on `[...existing.runs, run]` and aborting a healthy rerun.
    if (!Array.isArray(parsed.runs)) return undefined;
    return parsed as MarkerData;
  } catch {
    return undefined;
  }
}

export async function writeMarker(
  sourceHome: string,
  run: MarkerRun & { readonly targetPath: string },
): Promise<void> {
  const data: MarkerData = {
    version: 1,
    first_migrated_at: run.startedAt,
    last_migrated_at: run.completedAt,
    migrator_version: run.migratorVersion,
    target_path: run.targetPath,
    runs: [
      {
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        migratorVersion: run.migratorVersion,
        summary: run.summary,
      },
    ],
  };
  await writeFile(migratedMarker(sourceHome), JSON.stringify(data, null, 2), 'utf-8');
}

export async function appendMarkerRun(
  sourceHome: string,
  run: MarkerRun & { readonly targetPath: string },
): Promise<void> {
  const existing = await readMarker(sourceHome);
  if (existing === undefined) throw new Error('appendMarkerRun: no existing marker');
  const updated: MarkerData = {
    ...existing,
    last_migrated_at: run.completedAt,
    migrator_version: run.migratorVersion,
    // Record the latest run's target so a rerun to a different SCREAM_CODE_HOME
    // updates the marker — otherwise `detectPendingMigration` keeps prompting
    // for the new target even though it was just migrated.
    target_path: run.targetPath,
    runs: [
      ...existing.runs,
      {
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        migratorVersion: run.migratorVersion,
        summary: run.summary,
      },
    ],
  };
  await writeFile(migratedMarker(sourceHome), JSON.stringify(updated, null, 2), 'utf-8');
}
