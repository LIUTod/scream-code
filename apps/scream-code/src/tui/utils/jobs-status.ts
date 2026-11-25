/**
 * What the footer's `jobs` item and the "while you were away" note show:
 * background jobs switched on, items waiting for the person, whether the
 * background is up to run them, and what happened since the terminal was
 * last open. Read from files and the host lock only; never fails.
 */

import { t } from '@scream-code/config';
import { JobStore, listInbox } from '@scream-code/scream-code-sdk';

import { readActivitySince, type ActivityEntry } from '#/host/activity';
import { readHostStatus } from '#/host/control';
import { startBackground } from '#/host/service';
import { getDataDir } from '#/utils/paths';

export interface JobSummaryRow {
  readonly title: string;
  /** Last run: true ok, false failed, undefined never ran. */
  readonly lastOk: boolean | undefined;
  readonly nextRunAt: number | undefined;
}

export interface JobsFooterStatus {
  readonly enabled: number;
  readonly waiting: number;
  /**
   * Of those, the ones worth a heads-up: approvals and questions. Memories
   * wait quietly, as the background treats them (host/run.ts onNewItem).
   */
  readonly needsYou?: number;
  readonly hostRunning: boolean;
  /** Enabled jobs, soonest next run first (the sidebar's Jobs panel). */
  readonly jobs?: readonly JobSummaryRow[];
}

export async function readJobsFooterStatus(now: number = Date.now()): Promise<JobsFooterStatus> {
  try {
    const home = getDataDir();
    const on = new JobStore(home).list().filter((job) => job.enabled);
    const enabled = on.length;
    const pending = listInbox(home).filter((item) => item.status === 'pending' && item.expiresAt > now);
    const waiting = pending.length;
    const needsYou = pending.filter((item) => item.kind !== 'memory').length;
    const hostRunning = enabled > 0 ? (await readHostStatus()).running : false;
    const jobs = on
      .map((job) => {
        const last = job.runs.at(-1);
        // A run waiting to be retried is neither a success nor a failure yet.
        return { title: job.title, lastOk: last?.retrying === true ? undefined : last?.ok, nextRunAt: job.nextRunAt };
      })
      .toSorted((a, b) => (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY));
    return { enabled, waiting, needsYou, hostRunning, jobs };
  } catch {
    return { enabled: 0, waiting: 0, hostRunning: false };
  }
}

let lastAutoStartAt = 0;
const AUTO_START_EVERY_MS = 5 * 60 * 1000;

/**
 * Jobs run in the background: when some are on and the background is not
 * up, start it (it stays after this terminal closes, until the computer
 * restarts; `/service` makes it start again after a restart). Tried at most
 * every five minutes, so a background that cannot start is not retried in a
 * tight loop; the footer then says it is not running.
 */
export async function ensureBackgroundForJobs(status: JobsFooterStatus, now: number = Date.now()): Promise<boolean> {
  if (status.enabled === 0 || status.hostRunning) return false;
  if (now - lastAutoStartAt < AUTO_START_EVERY_MS) return false;
  lastAutoStartAt = now;
  try {
    await startBackground();
    return true;
  } catch {
    return false;
  }
}

/** For tests. */
export function resetAutoStartForTests(): void {
  lastAutoStartAt = 0;
}

/** The "while you were away" lines for entries since the terminal was last open; empty when nothing happened. */
export function renderAwaySummary(entries: readonly ActivityEntry[], waiting: number): string[] {
  const lines: string[] = [];
  const time = (ms: number): string => {
    const date = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  for (const entry of entries.filter((e) => e.kind !== 'waiting').slice(-8)) {
    const mark = entry.ok === false ? '✗' : '✓';
    const what = entry.kind === 'continued' ? t('away.continued', { title: entry.title }) : entry.title;
    lines.push(`${mark} ${what}  ${time(entry.at)}${entry.detail === undefined ? '' : `  ${entry.detail}`}`);
  }
  if (waiting > 0) lines.push(t('away.waiting', { count: String(waiting) }));
  return lines;
}

export function readAwayEntries(since: number): ActivityEntry[] {
  return since <= 0 ? [] : readActivitySince(since);
}
