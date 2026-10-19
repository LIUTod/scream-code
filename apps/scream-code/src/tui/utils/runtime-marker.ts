import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime crash markers.
 *
 * Every TUI instance drops `<homeDir>/runtime/instances/<pid>.json` while it
 * runs and removes it on a clean shutdown (Ctrl+C, `/exit`, SIGTERM/SIGHUP all
 * funnel through `ScreamTUI.stop()`). A marker that survives to the next
 * launch therefore means that instance ended without shutting down — the
 * process was killed, the terminal died hard, or the machine went down.
 *
 * The next launch reports one stale marker and deletes it, so the hint appears
 * exactly once. Session data itself is already durable (state.json + resume);
 * this only closes the "you have no idea it happened" gap.
 *
 * Markers are per-process files keyed by pid: multiple concurrent instances do
 * not clobber each other, and pid liveness separates a live sibling from a
 * dead one without any lock files.
 */

export interface RuntimeMarkerInfo {
  readonly pid: number;
  readonly startedAt: number;
  readonly sessionId?: string;
  readonly title?: string;
}

const MARKER_VERSION = 1;

interface StoredMarker extends RuntimeMarkerInfo {
  readonly version: number;
}

/** Directory holding one marker per live TUI process. */
export function runtimeMarkerDir(homeDir: string): string {
  return join(homeDir, 'runtime', 'instances');
}

function markerPath(homeDir: string, pid: number): string {
  return join(runtimeMarkerDir(homeDir), `${pid}.json`);
}

/** True when `pid` exists and we may signal it (EPERM means it is alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/**
 * Register this process as running. Written atomically (tmp + rename) so a
 * crash mid-write cannot leave a torn JSON file behind.
 */
export function writeRuntimeMarker(homeDir: string, info: RuntimeMarkerInfo): void {
  const dir = runtimeMarkerDir(homeDir);
  mkdirSync(dir, { recursive: true });
  const payload: StoredMarker = { version: MARKER_VERSION, ...info };
  const target = markerPath(homeDir, info.pid);
  const staged = `${target}.tmp`;
  writeFileSync(staged, JSON.stringify(payload), 'utf-8');
  renameSync(staged, target);
}

/** Remove this process's marker. Best effort: never blocks shutdown. */
export function clearRuntimeMarker(homeDir: string, pid: number = process.pid): void {
  try {
    rmSync(markerPath(homeDir, pid), { force: true });
  } catch {
    // The next launch treats an unreadable marker as stale and cleans it up.
  }
}

/**
 * Collect markers left by processes that are gone, newest first, and delete
 * them. Unreadable files are removed too: they can only be leftovers, and
 * keeping them would make the hint repeat forever.
 */
export function collectStaleMarkers(homeDir: string): RuntimeMarkerInfo[] {
  const dir = runtimeMarkerDir(homeDir);
  if (!existsSync(dir)) return [];

  const stale: RuntimeMarkerInfo[] = [];
  const now = Date.now();
  for (const fileName of readdirSync(dir)) {
    if (fileName.endsWith('.json.tmp')) {
      // A crash between write and rename leaves a draft behind. Only sweep
      // drafts old enough that a live writer cannot still own them.
      const draft = join(dir, fileName);
      try {
        if (now - statSync(draft).mtimeMs > 5 * 60_000) rmSync(draft, { force: true });
      } catch {
        rmSync(draft, { force: true });
      }
      continue;
    }
    if (!fileName.endsWith('.json')) continue;
    const filePath = join(dir, fileName);
    let marker: StoredMarker | undefined;
    try {
      marker = JSON.parse(readFileSync(filePath, 'utf-8')) as StoredMarker;
    } catch {
      rmSync(filePath, { force: true });
      continue;
    }
    if (
      marker === null
      || typeof marker !== 'object'
      || typeof marker.pid !== 'number'
      || marker.version !== MARKER_VERSION
    ) {
      rmSync(filePath, { force: true });
      continue;
    }
    if (isProcessAlive(marker.pid)) continue; // a live sibling instance
    stale.push({
      pid: marker.pid,
      startedAt: typeof marker.startedAt === 'number' ? marker.startedAt : 0,
      ...(typeof marker.sessionId === 'string' ? { sessionId: marker.sessionId } : {}),
      ...(typeof marker.title === 'string' ? { title: marker.title } : {}),
    });
    rmSync(filePath, { force: true });
  }

  return stale.toSorted((a, b) => b.startedAt - a.startedAt);
}
