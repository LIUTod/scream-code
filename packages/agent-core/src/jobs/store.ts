/**
 * Background tasks ("jobs"): standing instructions the background host runs
 * by itself, whether or not a terminal is open.
 *
 * A job is one sentence in four parts — **what** (the person's words),
 * **starts** (a cron schedule, or once at a time), **does** (acts within its
 * permission tier, or only reports), and **until** (stopped, an outcome is
 * reached, or a date). Every run gets a fresh session (marked `source: job`,
 * kept out of the session list) and the job's notes from the run before, so
 * runs connect without one session growing for ever.
 *
 * Rules that a sentence cannot talk its way past:
 *
 * - a job the agent creates repeats at most every 15 minutes (a person
 *   setting one up in `/jobs` may choose a shorter interval);
 * - at most 20 jobs are enabled at once;
 * - a job that fails 10 runs in a row is switched off, and says so once —
 *   retrying a run is the provider retry's business, this answers whether the
 *   job is worth running at all.
 *
 * Stored as one JSON file (`<home>/host/jobs.json`). Writers are the host
 * (recording runs) and any agent creating or removing a job, possibly in
 * another process, so every change re-reads the file under a short-lived
 * process lock and writes it atomically.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeNextCronRun, parseCronExpression } from '../tools/cron/cron-expr';
import { acquireProcessLock } from '../utils/process-lock';
import { sessionLockScope } from '../utils/session-lock';

export const MAX_ENABLED_JOBS = 20;
/** Shortest repeat interval for a job the agent creates. */
export const AGENT_JOB_MIN_INTERVAL_MS = 15 * 60 * 1000;
/** Consecutive failed runs after which a job is switched off. */
export const JOB_FATIGUE_LIMIT = 10;
/** Runs kept per job (their sessions are deleted beyond this). */
export const JOB_RUNS_KEPT = 30;
const MAX_NOTES_CHARS = 2_000;

export type JobDoes = 'act' | 'report';

export type JobUntil =
  | { readonly kind: 'stopped' }
  /** A goal: the run continues until the completion criterion is met. */
  | { readonly kind: 'outcome'; readonly criterion: string }
  | { readonly kind: 'date'; readonly at: number };

export type JobStarts =
  | { readonly kind: 'cron'; readonly cron: string }
  | { readonly kind: 'once'; readonly at: number };

export interface JobRun {
  readonly at: number;
  readonly ok: boolean;
  readonly sessionId: string;
  /** The run's final answer, shortened. */
  readonly summary: string;
  /**
   * A failure that clears by itself (a timeout, the network down) that the
   * runner will try again shortly: shown in the history, not counted as a
   * failure (see {@link JobStore.recordRetry}).
   */
  readonly retrying?: boolean | undefined;
}

export interface Job {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly starts: JobStarts;
  readonly does: JobDoes;
  readonly until: JobUntil;
  readonly workDir: string;
  readonly createdBy: 'person' | 'agent';
  readonly createdAt: number;
  readonly enabled: boolean;
  /** Chat-channel session key the results go to (`line-…`), when made from a chat. */
  readonly deliverTo?: string | undefined;
  /** The next time it is due; undefined once it has nothing left to run. */
  readonly nextRunAt?: number | undefined;
  readonly consecutiveFailures: number;
  /** Notes the last run left for the next one. */
  readonly notes: string;
  readonly runs: readonly JobRun[];
  /** Why it was switched off by itself (fatigue, an outcome reached, its end date). */
  readonly disabledReason?: 'fatigue' | 'done' | 'ended' | undefined;
  /** Due times missed while no host ran that the next run stands in for (cleared by it). */
  readonly missedRuns?: number | undefined;
  /** Due times skipped because they were missed too long ago (for the brief and the report). */
  readonly lastSkipped?: { readonly count: number; readonly at: number } | undefined;
  /** Retries already spent on the current due time (cleared by a recorded run). */
  readonly retries?: number | undefined;
}

export interface NewJob {
  readonly title: string;
  readonly prompt: string;
  readonly starts: JobStarts;
  readonly does?: JobDoes;
  readonly until?: JobUntil;
  readonly workDir: string;
  readonly createdBy: 'person' | 'agent';
  readonly deliverTo?: string | undefined;
}

export class JobError extends Error {
  constructor(
    readonly reason: 'too_frequent' | 'too_many' | 'bad_schedule' | 'not_found' | 'busy' | 'unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export function jobsPath(screamHomeDir: string): string {
  return join(screamHomeDir, 'host', 'jobs.json');
}

/**
 * The jobs on disk. A missing file is no jobs; a file that cannot be read or
 * parsed (a permission problem, a bad hand edit, a write cut short by a full
 * disk) throws in `strict` mode, so a change refuses to run instead of writing
 * an empty list over every job. Reads for display are lenient.
 */
function readJobs(screamHomeDir: string, strict = false): Job[] {
  let text: string;
  try {
    text = readFileSync(jobsPath(screamHomeDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (strict) throw new JobError('unreadable', `Cannot read ${jobsPath(screamHomeDir)}: ${String(error)}`);
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { jobs?: unknown };
    if (Array.isArray(parsed.jobs)) return parsed.jobs as Job[];
    if (strict) throw new JobError('unreadable', `${jobsPath(screamHomeDir)} has no job list; fix or remove it.`);
    return [];
  } catch (error) {
    if (error instanceof JobError) throw error;
    if (strict) {
      throw new JobError('unreadable', `${jobsPath(screamHomeDir)} is not valid JSON; fix or remove it. (${String(error)})`);
    }
    return [];
  }
}

function writeJobs(screamHomeDir: string, jobs: readonly Job[]): void {
  const path = jobsPath(screamHomeDir);
  mkdirSync(join(screamHomeDir, 'host'), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

async function withJobsLock<T>(screamHomeDir: string, change: (jobs: Job[]) => T): Promise<T> {
  const options = { scope: sessionLockScope(screamHomeDir), name: 'jobs-store' };
  const deadline = Date.now() + 5_000;
  for (;;) {
    const lock = await acquireProcessLock(options);
    if (lock.held) {
      try {
        const jobs = readJobs(screamHomeDir, true);
        const result = change(jobs);
        writeJobs(screamHomeDir, jobs);
        return result;
      } finally {
        await lock.release();
      }
    }
    if (Date.now() > deadline) throw new JobError('busy', 'The job list is being changed by another process; try again.');
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/** When a job is due next, after `fromMs`; undefined when it has no run left. */
export function nextJobRun(job: Pick<Job, 'starts' | 'until' | 'runs'>, fromMs: number): number | undefined {
  let next: number | undefined;
  if (job.starts.kind === 'once') {
    next = job.runs.length === 0 ? job.starts.at : undefined;
  } else {
    next = computeNextCronRun(parseCronExpression(job.starts.cron), fromMs) ?? undefined;
  }
  if (next !== undefined && job.until.kind === 'date' && next > job.until.at) return undefined;
  return next;
}

/**
 * The due time that follows the one at `after`: for a one-time job there is
 * none (`nextJobRun` answers "when is it due", which for a one-time job that
 * has not run is always its time, so walking past missed windows with it
 * would never end).
 */
function followingRun(job: Pick<Job, 'starts' | 'until' | 'runs'>, after: number): number | undefined {
  if (job.starts.kind === 'once') return undefined;
  return nextJobRun(job, after);
}

/** The interval between two consecutive fires of a cron schedule (its tightest gap over a day). */
export function cronIntervalMs(cron: string, fromMs: number): number | undefined {
  const parsed = parseCronExpression(cron);
  let previous = computeNextCronRun(parsed, fromMs);
  if (previous === null) return undefined;
  let tightest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 48 && previous !== null; i++) {
    const next = computeNextCronRun(parsed, previous);
    if (next === null) break;
    tightest = Math.min(tightest, next - previous);
    previous = next;
  }
  return Number.isFinite(tightest) ? tightest : undefined;
}

function validate(job: NewJob, now: number): void {
  if (job.starts.kind === 'cron') {
    try {
      parseCronExpression(job.starts.cron);
    } catch (error) {
      throw new JobError('bad_schedule', error instanceof Error ? error.message : String(error));
    }
    const interval = cronIntervalMs(job.starts.cron, now);
    if (interval === undefined) throw new JobError('bad_schedule', `"${job.starts.cron}" never fires.`);
    if (job.createdBy === 'agent' && interval < AGENT_JOB_MIN_INTERVAL_MS) {
      throw new JobError(
        'too_frequent',
        `A background task you create may repeat at most every 15 minutes; "${job.starts.cron}" repeats every ${String(Math.round(interval / 60_000))} minute(s).`,
      );
    }
  } else if (!Number.isFinite(job.starts.at)) {
    throw new JobError('bad_schedule', 'The start time is not a valid time.');
  }
}

export class JobStore {
  constructor(private readonly screamHomeDir: string) {}

  list(): readonly Job[] {
    return readJobs(this.screamHomeDir);
  }

  get(id: string): Job | undefined {
    return readJobs(this.screamHomeDir).find((job) => job.id === id);
  }

  async add(input: NewJob, now: number = Date.now()): Promise<Job> {
    validate(input, now);
    return withJobsLock(this.screamHomeDir, (jobs) => {
      if (jobs.filter((job) => job.enabled).length >= MAX_ENABLED_JOBS) {
        throw new JobError(
          'too_many',
          `At most ${String(MAX_ENABLED_JOBS)} background tasks can be on at once; switch one off first.`,
        );
      }
      const base = {
        starts: input.starts,
        until: input.until ?? { kind: 'stopped' as const },
        runs: [] as JobRun[],
      };
      const job: Job = {
        id: `job-${randomBytes(4).toString('hex')}`,
        title: input.title.trim().slice(0, 120) || input.prompt.trim().slice(0, 60),
        prompt: input.prompt,
        does: input.does ?? 'act',
        workDir: input.workDir,
        createdBy: input.createdBy,
        createdAt: now,
        enabled: true,
        ...(input.deliverTo === undefined ? {} : { deliverTo: input.deliverTo }),
        nextRunAt: nextJobRun(base, now),
        consecutiveFailures: 0,
        notes: '',
        ...base,
      };
      jobs.push(job);
      return job;
    });
  }

  async remove(id: string): Promise<Job> {
    return withJobsLock(this.screamHomeDir, (jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) throw new JobError('not_found', `No background task ${id}.`);
      const [removed] = jobs.splice(index, 1);
      return removed!;
    });
  }

  /** Switch a job on or off. Turning it on clears its failure count, as a fresh start. */
  async setEnabled(id: string, enabled: boolean, now: number = Date.now()): Promise<Job> {
    return withJobsLock(this.screamHomeDir, (jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) throw new JobError('not_found', `No background task ${id}.`);
      const current = jobs[index]!;
      if (enabled && !current.enabled && jobs.filter((job) => job.enabled).length >= MAX_ENABLED_JOBS) {
        throw new JobError('too_many', `At most ${String(MAX_ENABLED_JOBS)} background tasks can be on at once.`);
      }
      const next: Job = enabled
        ? {
            ...current,
            enabled: true,
            consecutiveFailures: 0,
            disabledReason: undefined,
            nextRunAt: nextJobRun(current, now),
          }
        : { ...current, enabled: false };
      jobs[index] = next;
      return next;
    });
  }

  /**
   * Switch a job between acting and only reporting, with the prompt that
   * goes with the new tier; its runs and notes are kept.
   */
  async setDoes(id: string, does: JobDoes, prompt?: string): Promise<Job> {
    return withJobsLock(this.screamHomeDir, (jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) throw new JobError('not_found', `No background task ${id}.`);
      const next: Job = { ...jobs[index]!, does, ...(prompt === undefined ? {} : { prompt }) };
      jobs[index] = next;
      return next;
    });
  }

  /**
   * Record a finished run: keep it (the newest {@link JOB_RUNS_KEPT}), carry
   * its notes to the next run, count consecutive failures, and switch the job
   * off on fatigue, when its outcome was reached, or when nothing is left to
   * run. Returns the updated job and the runs that fell off the end (their
   * sessions may be deleted).
   */
  async recordRun(
    id: string,
    run: JobRun & { readonly notes?: string; readonly outcomeReached?: boolean },
    now: number = Date.now(),
  ): Promise<{ job: Job; dropped: readonly JobRun[] }> {
    return withJobsLock(this.screamHomeDir, (jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) throw new JobError('not_found', `No background task ${id}.`);
      const current = jobs[index]!;
      const runs = [...current.runs, { at: run.at, ok: run.ok, sessionId: run.sessionId, summary: run.summary }];
      const dropped = runs.splice(0, Math.max(0, runs.length - JOB_RUNS_KEPT));
      const consecutiveFailures = run.ok ? 0 : current.consecutiveFailures + 1;
      const nextRunAt = nextJobRun({ ...current, runs }, now);
      let disabledReason: Job['disabledReason'];
      if (consecutiveFailures >= JOB_FATIGUE_LIMIT) disabledReason = 'fatigue';
      else if (run.outcomeReached === true) disabledReason = 'done';
      else if (nextRunAt === undefined) disabledReason = 'ended';
      const job: Job = {
        ...current,
        runs,
        consecutiveFailures,
        notes: (run.notes ?? current.notes).slice(0, MAX_NOTES_CHARS),
        nextRunAt,
        missedRuns: undefined,
        retries: undefined,
        ...(disabledReason === undefined ? {} : { enabled: false, disabledReason }),
      };
      jobs[index] = job;
      return { job, dropped };
    });
  }

  /**
   * Record a run that failed for a reason that clears by itself and set it to
   * run again at `retryAt` (or at its next regular time, when that comes
   * first). Nothing else moves: the failure streak, the notes and the missed
   * runs it stands in for stay as they were, so the retry is the same run
   * given a second chance, not a new one.
   */
  async recordRetry(id: string, run: JobRun, retryAt: number): Promise<{ job: Job; dropped: readonly JobRun[] }> {
    return withJobsLock(this.screamHomeDir, (jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) throw new JobError('not_found', `No background task ${id}.`);
      const current = jobs[index]!;
      const runs = [
        ...current.runs,
        { at: run.at, ok: false, sessionId: run.sessionId, summary: run.summary, retrying: true },
      ];
      const dropped = runs.splice(0, Math.max(0, runs.length - JOB_RUNS_KEPT));
      const regular = current.starts.kind === 'once' ? undefined : nextJobRun(current, run.at);
      const job: Job = {
        ...current,
        runs,
        retries: (current.retries ?? 0) + 1,
        nextRunAt: regular === undefined ? retryAt : Math.min(regular, retryAt),
      };
      jobs[index] = job;
      return { job, dropped };
    });
  }

  /**
   * Deal with due times missed while no host ran. When the latest of them is
   * within `replayWithinMs`, they are coalesced into one run due now that
   * knows how many it stands in for; older ones are skipped and noted for the
   * brief. A one-time job missed too long ago ends.
   */
  async catchUpMissed(
    id: string,
    now: number,
    replayWithinMs: number,
  ): Promise<{ readonly kind: 'none' | 'coalesced' | 'skipped'; readonly missed: number }> {
    return withJobsLock(this.screamHomeDir, (jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) return { kind: 'none', missed: 0 };
      const current = jobs[index]!;
      let missed = 0;
      let latest: number | undefined;
      let next = current.nextRunAt;
      while (next !== undefined && next < now && missed < 10_000) {
        missed += 1;
        latest = next;
        next = followingRun(current, next);
      }
      if (missed === 0 || latest === undefined) return { kind: 'none', missed: 0 };
      if (now - latest <= replayWithinMs) {
        jobs[index] = { ...current, nextRunAt: latest, missedRuns: missed };
        return { kind: 'coalesced', missed };
      }
      jobs[index] = {
        ...current,
        nextRunAt: next,
        lastSkipped: { count: missed, at: now },
        ...(next === undefined ? { enabled: false, disabledReason: 'ended' as const } : {}),
      };
      return { kind: 'skipped', missed };
    });
  }
}
