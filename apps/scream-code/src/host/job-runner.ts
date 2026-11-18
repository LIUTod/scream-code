/**
 * Runs background tasks (jobs) inside the host when they fall due.
 *
 * Each run gets a session of its own (`source: job`, kept out of the session
 * list), the job's notes from the run before, and a frame that says this is a
 * scheduled run to do now. "Acts" runs in bot mode (reversible work runs,
 * irreversible actions are refused and reported); "only reports" runs in ask
 * mode, where nothing can change. A job with an outcome becomes a goal in its
 * session, driven until its criterion is met; reaching it ends the job.
 *
 * After the run its final answer is the run's summary and the next run's
 * notes; it goes to the chat the job was made from, if any. Failures count
 * towards the fatigue limit: the first failure after a success is reported
 * once, and the job is switched off — and said so — at the limit. Sessions of
 * runs beyond the newest 30 are deleted, so a daily job does not leave a
 * thousand sessions behind.
 *
 * A due time missed while no host ran is skipped, not replayed: the host
 * starts by moving every stale due time forward.
 */

import { randomBytes } from 'node:crypto';

import {
  JOB_FATIGUE_LIMIT,
  JobStore,
  listInbox,
  log,
  type InboxItem,
  type Job,
  type ScreamHarness,
  type Session,
} from '@scream-code/scream-code-sdk';

import { runPromptToEnd } from './run-to-end';
import { readUsage, usageTokens } from './usage';
import { finishRunWorktree, holdRunWorktree, prepareRunWorktree } from './worktree';

/**
 * Job run sessions are named `job-run-…`. A run cut off by a crash is not
 * continued by the work resumer: its job is still due (the due time moves only
 * when a run is recorded), so the next tick runs it again in a fresh session.
 */
export const JOB_RUN_SESSION_PREFIX = 'job-run-';

/** How often due jobs are looked for. */
export const JOB_TICK_MS = 30_000;
/** A due time this far in the past when the host starts is a missed window. */
const MISSED_GRACE_MS = 10 * 60 * 1000;
/** Missed due times this recent are coalesced into one run; older ones are skipped and noted. */
const MISSED_REPLAY_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_RUNS = 2;
const SUMMARY_CHARS = 1_500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface JobRunnerOptions {
  readonly harness: ScreamHarness;
  readonly screamHomeDir: string;
  /** Sends text to a chat-channel session key; undefined while no channel runs. */
  readonly deliver?: ((sessionKey: string, text: string) => Promise<void>) | undefined;
  /** The localized lines the runner says about a job (fatigue, first failure). */
  readonly messages: {
    readonly firstFailure: (job: Job, summary: string) => string;
    readonly fatigued: (job: Job) => string;
    readonly result: (job: Job, summary: string) => string;
    /** The line added to a run's summary naming the branch its changes are on. */
    readonly branch: (branch: string) => string;
  };
  /** Off in tests: runs that act get a git worktree of their own (default on). */
  readonly useWorktrees?: boolean;
  readonly now?: () => number;
  readonly onRun?: ((job: Job, ok: boolean) => void) | undefined;
  /**
   * Where results go for a job that names no chat (made in a terminal): the
   * chat the person last wrote from, when a channel runs. Undefined: none.
   */
  readonly fallbackChat?: (() => string | undefined) | undefined;
  /** Today's unattended-work token limit is reached: start nothing. */
  readonly budgetReached?: (() => boolean) | undefined;
  /** Told once per day when runs are held back by the limit. */
  readonly onBudgetHold?: ((job: Job) => void) | undefined;
  /** A run's tokens, for the daily total. */
  readonly recordUsage?: ((tokens: number) => void) | undefined;
  /**
   * Before a run: extra context for its prompt, and whether it must not get a
   * worktree (the self-review works in the skills folder, never a repository).
   */
  readonly prepareRun?: ((job: Job) => Promise<RunPreparation | undefined>) | undefined;
  /** After a run, before it is recorded (the self-review commits its changes to the history). */
  readonly afterRun?: ((job: Job, run: { ok: boolean; summary: string }) => Promise<void>) | undefined;
}

export interface RunPreparation {
  readonly context?: string | undefined;
  readonly noWorktree?: boolean | undefined;
}

/**
 * What waits on the person, for a report run: items still pending, and items
 * that expired in the last day unanswered. Model-facing, so English.
 */
export function renderWaitingBlock(items: readonly InboxItem[], now: number): string | undefined {
  const describe = (item: InboxItem): string =>
    item.kind === 'memory'
      ? `memories to save: ${String(item.memories?.length ?? 0)}`
      : item.kind === 'question'
      ? `question: ${item.question?.items.map((q) => q.question).join(' / ') ?? ''}`
      : `approval: ${item.approval?.action ?? ''}`;
  const pending = items.filter((item) => item.status === 'pending' && item.expiresAt > now);
  const expired = items.filter(
    (item) => (item.status === 'expired' || (item.status === 'pending' && item.expiresAt <= now)) && now - item.expiresAt < DAY_MS,
  );
  if (pending.length === 0 && expired.length === 0) return undefined;
  const lines = ['<waiting-for-the-person>'];
  for (const item of pending) lines.push(`- still waiting (${item.id}, ${item.workDir}): ${describe(item)}`);
  for (const item of expired) lines.push(`- expired unanswered (${item.id}, ${item.workDir}): ${describe(item)}`);
  lines.push('</waiting-for-the-person>');
  return lines.join('\n');
}

/** Runs skipped in the last day because they were missed too long ago. Model-facing, so English. */
export function renderSkippedBlock(jobs: readonly Job[], now: number): string | undefined {
  const skipped = jobs.filter((job) => job.lastSkipped !== undefined && now - job.lastSkipped.at < DAY_MS);
  if (skipped.length === 0) return undefined;
  return [
    '<skipped-runs reason="the computer was off or the background was not running">',
    ...skipped.map((job) => `- ${job.title}: ${String(job.lastSkipped!.count)} run(s) skipped`),
    '</skipped-runs>',
  ].join('\n');
}

/** The prompt a run starts with: the frame, the notes from the run before, the instruction. */
export function renderJobPrompt(job: Job, now: number, waiting?: string): string {
  const lines = [
    `<background-task id="${job.id}" startedAt="${new Date(now).toISOString()}">`,
    '<instruction>This is a scheduled background task running now, with nobody watching. Do the work in the task below in this turn; do not list, recreate or reschedule the task. ' +
      (job.does === 'report'
        ? 'Only look and report: change nothing.'
        : 'Act within your permissions; anything that needs the person is refused and sent to them for approval: do not retry it, carry on with the rest, and list it in your answer.') +
      ' End with a short answer: what you did or found, and the one thing the person should look at, if any. That answer is shown in /jobs and is passed to the next run as its notes.</instruction>',
  ];
  if (job.notes.trim() !== '') lines.push('<notes-from-last-run>', job.notes.trim(), '</notes-from-last-run>');
  if ((job.missedRuns ?? 0) > 0) {
    lines.push(
      `<missed-runs count="${String(job.missedRuns)}">The computer was off or the background was not running, so ${String(job.missedRuns)} scheduled run(s) of this task were missed. This one run stands in for all of them: do the work once, covering the time since the last run, and say in your answer that runs were missed.</missed-runs>`,
    );
  }
  if (waiting !== undefined) lines.push(waiting);
  lines.push('<task>', job.prompt, '</task>', '</background-task>');
  return lines.join('\n');
}

export class JobRunner {
  private readonly store: JobStore;
  private readonly running = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private heldOnDay: string | undefined;

  constructor(private readonly options: JobRunnerOptions) {
    this.store = new JobStore(options.screamHomeDir);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Skip windows missed while no host ran, then look for due jobs every {@link JOB_TICK_MS}. */
  async start(tickMs: number = JOB_TICK_MS): Promise<void> {
    const now = this.now();
    for (const job of this.store.list()) {
      if (job.enabled && job.nextRunAt !== undefined && job.nextRunAt < now - MISSED_GRACE_MS) {
        const result = await this.store
          .catchUpMissed(job.id, now, MISSED_REPLAY_MS)
          .catch(() => ({ kind: 'none' as const, missed: 0 }));
        if (result.kind !== 'none') log.info('host: missed job runs', { jobId: job.id, ...result });
      }
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  busy(): boolean {
    return this.running.size > 0;
  }

  /** Resolves when no run is in flight, or after `ms`; true when idle. */
  async waitIdle(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.busy() && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    return !this.busy();
  }

  /** Stop the runs in flight (their jobs are recorded as failed runs). */
  async cancelAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.cancel().catch(() => {});
    }
  }

  /** Start every job that is due now (up to the concurrency limit); resolves with how many. */
  async tick(): Promise<number> {
    if (this.stopped) return 0;
    const now = this.now();
    let started = 0;
    for (const job of this.store.list()) {
      if (this.running.size >= MAX_CONCURRENT_RUNS) break;
      if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) continue;
      if (this.running.has(job.id)) continue;
      if (this.options.budgetReached?.() === true) {
        // Held, not failed: the job stays due and runs once the day changes.
        const day = new Date(now).toDateString();
        if (this.heldOnDay !== day) {
          this.heldOnDay = day;
          this.options.onBudgetHold?.(job);
        }
        break;
      }
      this.running.add(job.id);
      started += 1;
      void this.run(job)
        .catch((error: unknown) => {
          log.warn('host: job run failed to start', { jobId: job.id, error: String(error) });
        })
        .finally(() => {
          this.running.delete(job.id);
        });
    }
    return started;
  }

  private async run(job: Job): Promise<void> {
    const { harness } = this.options;
    const startedAt = this.now();
    const preparation = await this.options.prepareRun?.(job).catch((error: unknown) => {
      log.warn('host: preparing a job run failed', { jobId: job.id, error: String(error) });
      return undefined;
    });
    // A run that acts on a git repository works in a worktree of its own.
    const worktree =
      job.does === 'act' && this.options.useWorktrees !== false && preparation?.noWorktree !== true
        ? await prepareRunWorktree(this.options.screamHomeDir, job.workDir, job.id, startedAt).catch(() => undefined)
        : undefined;
    let session: Session;
    try {
      session = await harness.createSession({
        id: `${JOB_RUN_SESSION_PREFIX}${job.id}-${randomBytes(4).toString('hex')}`,
        workDir: worktree?.dir ?? job.workDir,
        permission: job.does === 'report' ? 'ask' : 'bot',
        metadata: { source: 'job', jobId: job.id, title: job.title },
      });
    } catch (error) {
      if (worktree !== undefined) await finishRunWorktree(worktree, `scream: ${job.title}`).catch(() => undefined);
      await this.finish(job, {
        at: startedAt,
        ok: false,
        sessionId: '',
        summary: `Could not open a session: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    this.sessions.set(job.id, session);
    let ok = false;
    let summary = '';
    let outcomeReached = false;
    try {
      if (job.until.kind === 'outcome') {
        await session.createGoal(job.prompt, { completionCriterion: job.until.criterion, replace: true });
      }
      // A report (the daily brief among them) also says what waits on the person.
      const waiting =
        job.does === 'report'
          ? [
              renderWaitingBlock(listInbox(this.options.screamHomeDir), startedAt),
              renderSkippedBlock(this.store.list(), startedAt),
            ]
              .filter((part) => part !== undefined)
              .join('\n') || undefined
          : undefined;
      const context = [preparation?.context, waiting].filter((part) => part !== undefined).join('\n');
      const result = await runPromptToEnd(session, renderJobPrompt(job, startedAt, context === '' ? undefined : context));
      ok = result.ok;
      summary = result.text.trim().slice(-SUMMARY_CHARS);
      if (result.timedOut) summary = `${summary}\n(Stopped: the run went past its time limit.)`.trim();
      if (job.until.kind === 'outcome') {
        outcomeReached = (await session.getGoal().catch(() => ({ goal: null }))).goal?.status === 'complete';
      }
    } catch (error) {
      summary = error instanceof Error ? error.message : String(error);
    } finally {
      this.sessions.delete(job.id);
      const usage = await readUsage(session);
      this.options.recordUsage?.(usageTokens(usage));
      // A run that acted may have learned something; it waits for the person
      // in the inbox. A report run (the brief, the self-review) keeps nothing.
      await session.close(job.does === 'act' ? { unattended: true } : { extractMemories: false }).catch(() => {});
    }
    if (worktree !== undefined) {
      // Something of this run waits on the person: an approved action must
      // run where the run worked, so the worktree stays until it is settled.
      const waiting = listInbox(this.options.screamHomeDir).some(
        (item) => item.sessionId === session.id && (item.status === 'pending' || item.status === 'decided'),
      );
      if (waiting) {
        await holdRunWorktree(this.options.screamHomeDir, session.id, worktree).catch(() => {});
      } else {
        const branch = await finishRunWorktree(worktree, `scream: ${job.title}`).catch(() => undefined);
        if (branch !== undefined) summary = `${summary}\n${this.options.messages.branch(branch)}`.trim();
      }
    }
    await this.options.afterRun?.(job, { ok, summary }).catch((error: unknown) => {
      log.warn('host: after a job run', { jobId: job.id, error: String(error) });
    });
    await this.finish(job, { at: startedAt, ok, sessionId: session.id, summary, notes: summary, outcomeReached });
  }

  private async finish(
    job: Job,
    run: { at: number; ok: boolean; sessionId: string; summary: string; notes?: string; outcomeReached?: boolean },
  ): Promise<void> {
    const { harness, deliver, messages } = this.options;
    const previousFailures = job.consecutiveFailures;
    let updated: Job;
    try {
      const recorded = await this.store.recordRun(job.id, run, this.now());
      updated = recorded.job;
      for (const dropped of recorded.dropped) {
        if (dropped.sessionId !== '') await harness.deleteSession(dropped.sessionId).catch(() => {});
      }
    } catch (error) {
      // Deleted while it ran: nothing to record.
      log.warn('host: could not record a job run', { jobId: job.id, error: String(error) });
      return;
    }
    this.options.onRun?.(updated, run.ok);
    const target = updated.deliverTo ?? this.options.fallbackChat?.();
    if (target === undefined || deliver === undefined) return;
    let text: string | undefined;
    if (updated.disabledReason === 'fatigue' && previousFailures < JOB_FATIGUE_LIMIT) text = messages.fatigued(updated);
    else if (!run.ok && previousFailures === 0) text = messages.firstFailure(updated, run.summary);
    else if (run.ok && run.summary !== '') text = messages.result(updated, run.summary);
    if (text !== undefined) await deliver(target, text).catch(() => {});
  }
}

