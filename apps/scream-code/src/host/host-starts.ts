/**
 * The host's own start record (`<home>/host/host-starts.json`): one entry per
 * host that took the lock, marked clean when it shut down on purpose (a stop
 * request, a signal, going idle). An entry left unmarked is a host that died —
 * an uncaught exception, a kill, a power loss.
 *
 * It exists for one decision: a service-launched host that keeps crashing
 * must stop being restarted. launchd and systemd restart a crashed host every
 * ten seconds, forever; a host that dies on boot (a broken config, a corrupt
 * file) would loop the way the "already running" exit once did — thousands of
 * Node boots, nobody told. After {@link CRASH_LIMIT} crashes within
 * {@link CRASH_WINDOW_MS} the next service start says so and exits 0, which
 * both supervisors read as "leave it stopped".
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
const KEEP = 20;

export interface HostStart {
  readonly at: number;
  readonly pid: number;
  readonly clean?: boolean | undefined;
}

export function hostStartsFile(hostDir: string): string {
  return join(hostDir, 'host-starts.json');
}

function read(file: string): HostStart[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { starts?: unknown };
    if (!Array.isArray(parsed.starts)) return [];
    return parsed.starts.filter(
      (entry): entry is HostStart =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as HostStart).at === 'number' &&
        typeof (entry as HostStart).pid === 'number',
    );
  } catch {
    return [];
  }
}

function write(file: string, starts: readonly HostStart[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ starts: starts.slice(-KEEP) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}

/**
 * Record this host's start and return how many hosts before it died within
 * the crash window. Called once the lock is held, so every earlier entry is a
 * process that is gone. Never throws: a start record must not stop a host.
 */
export function recordHostStart(file: string, start: HostStart): number {
  try {
    const before = read(file);
    write(file, [...before, start]);
    return before.filter((entry) => entry.clean !== true && start.at - entry.at <= CRASH_WINDOW_MS).length;
  } catch {
    return 0;
  }
}

/** Mark this host's start as a clean shutdown. Never throws. */
export function markHostStartClean(file: string, pid: number, at: number): void {
  try {
    const starts = read(file).map((entry) => (entry.pid === pid && entry.at === at ? { ...entry, clean: true } : entry));
    write(file, starts);
  } catch {
    // Best effort: an unmarked entry only ever counts once, inside its window.
  }
}
