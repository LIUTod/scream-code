/**
 * The running-work register: which sessions have a turn in flight right now,
 * and in what kind of work (`<home>/host/running/<sessionId>.json`).
 *
 * A process writes a session's record when a main-agent turn starts and
 * removes it when the turn ends. A record that outlives its turn therefore
 * means the turn never ended: the process running it died (crash, `kill -9`,
 * power loss, shutdown), or it handed the work to the background host on exit.
 * The host reads the register on start and every minute after, and picks up
 * work that should continue on its own — an active goal, a bot-mode run, a
 * handed-off session — when no process holds that session's lock any more.
 * A plain conversation is not continued behind the person's back; its record
 * only lets the next open say that the last turn was cut off.
 *
 * One file per session, written by the process that runs the turn, so no two
 * processes write the same file at the same moment and nothing needs a lock.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What kind of work a turn was doing, which decides whether it continues on its own. */
export type RunningWorkKind = 'goal' | 'bot' | 'chat';

export interface RunningWorkRecord {
  readonly sessionId: string;
  readonly workDir: string;
  readonly kind: RunningWorkKind;
  readonly startedAt: number;
  readonly pid: number;
  /** Set when a terminal handed the session to the background host on exit. */
  readonly handoff?: boolean;
}

/** Sessions whose record must survive the turn ending (a handoff in progress). */
const handoffPending = new Set<string>();

export function runningWorkDir(screamHomeDir: string): string {
  return join(screamHomeDir, 'host', 'running');
}

function recordPath(screamHomeDir: string, sessionId: string): string {
  return join(runningWorkDir(screamHomeDir), `${encodeURIComponent(sessionId)}.json`);
}

function writeRecord(screamHomeDir: string, record: RunningWorkRecord): void {
  const dir = runningWorkDir(screamHomeDir);
  mkdirSync(dir, { recursive: true });
  const path = recordPath(screamHomeDir, record.sessionId);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

export function readRunningWork(screamHomeDir: string, sessionId: string): RunningWorkRecord | undefined {
  try {
    return parseRecord(readFileSync(recordPath(screamHomeDir, sessionId), 'utf8'));
  } catch {
    return undefined;
  }
}

function parseRecord(text: string): RunningWorkRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<RunningWorkRecord>;
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.workDir !== 'string' ||
      (value.kind !== 'goal' && value.kind !== 'bot' && value.kind !== 'chat') ||
      typeof value.startedAt !== 'number' ||
      typeof value.pid !== 'number'
    ) {
      return undefined;
    }
    return value as RunningWorkRecord;
  } catch {
    return undefined;
  }
}

/** Record that this process started a turn in `sessionId`. Never throws. */
export function markWorkRunning(
  screamHomeDir: string,
  record: Omit<RunningWorkRecord, 'pid' | 'startedAt'>,
): void {
  try {
    writeRecord(screamHomeDir, { ...record, startedAt: Date.now(), pid: process.pid });
  } catch {
    // The register is a recovery aid; a turn must never fail over it.
  }
}

/**
 * Record that this process's turn in `sessionId` ended. Leaves a record another
 * process wrote (the host took the session over meanwhile) and a record marked
 * for handoff alone. Never throws.
 */
export function clearWorkRunning(screamHomeDir: string, sessionId: string): void {
  if (handoffPending.has(sessionId)) return;
  try {
    const current = readRunningWork(screamHomeDir, sessionId);
    if (current !== undefined && current.pid !== process.pid) return;
    rmSync(recordPath(screamHomeDir, sessionId), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Hand `sessionId`'s work to the background host: its record is kept when the
 * session closes here, and marked so the host continues it whatever its kind.
 */
export function markWorkHandedOff(
  screamHomeDir: string,
  record: Omit<RunningWorkRecord, 'pid' | 'startedAt' | 'handoff'>,
): void {
  handoffPending.add(record.sessionId);
  writeRecord(screamHomeDir, { ...record, startedAt: Date.now(), pid: process.pid, handoff: true });
}

/** The host took the work over: forget the handoff and drop the record. */
export function removeRunningWork(screamHomeDir: string, sessionId: string): void {
  handoffPending.delete(sessionId);
  try {
    rmSync(recordPath(screamHomeDir, sessionId), { force: true });
  } catch {
    // best-effort
  }
}

/** Every record in the register; unreadable files are skipped. */
export function listRunningWork(screamHomeDir: string): RunningWorkRecord[] {
  let names: string[];
  try {
    names = readdirSync(runningWorkDir(screamHomeDir));
  } catch {
    return [];
  }
  const records: RunningWorkRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = parseRecord(readFileSync(join(runningWorkDir(screamHomeDir), name), 'utf8'));
      if (record !== undefined) records.push(record);
    } catch {
      // skip
    }
  }
  return records;
}
