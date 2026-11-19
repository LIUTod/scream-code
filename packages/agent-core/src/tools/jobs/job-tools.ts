/**
 * The agent's tools for background tasks (`JobCreate`, `JobList`,
 * `JobDelete`); the store and its rules live in `jobs/store.ts`, and the
 * background host runs the tasks (`apps/scream-code/src/host/job-runner.ts`).
 *
 * A task created here is the agent's (`createdBy: agent`): it repeats at most
 * every 15 minutes. Made from a chat-channel session, its results go back to
 * that chat.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import { JobError, JobStore, type Job, type JobStarts } from '../../jobs/store';
import type { ToolExecution } from '../../loop/types';
import { describeLocalTimeZone, formatLocalIso } from '../../utils/local-time';
import { queryProcessLock } from '../../utils/process-lock';
import { sessionLockScope } from '../../utils/session-lock';
import { cronToHuman, parseCronExpression } from '../cron/cron-expr';
import { resolveOneShotWhen } from '../cron/when';
import { toInputJsonSchema } from '../support/input-schema';
import JOB_CREATE_DESCRIPTION from './job-create.md';
import JOB_DELETE_DESCRIPTION from './job-delete.md';
import JOB_LIST_DESCRIPTION from './job-list.md';

export interface JobToolContext {
  readonly screamHomeDir: string;
  readonly workDir: () => string;
  readonly sessionId: string | undefined;
  readonly now: () => number;
}

const MAX_PROMPT_CHARS = 8_000;

function clockLines(nowMs: number): string {
  return `now: ${formatLocalIso(nowMs)}\ntimeZone: ${describeLocalTimeZone(nowMs)}`;
}

function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function describeStarts(starts: JobStarts): string {
  if (starts.kind === 'once') return `once at ${formatLocalIso(starts.at)}`;
  return `${starts.cron} (${cronToHuman(parseCronExpression(starts.cron))})`;
}

function describeJob(job: Job): string {
  const last = job.runs.at(-1);
  return [
    `id: ${job.id}`,
    `title: ${job.title}`,
    `schedule: ${describeStarts(job.starts)}`,
    `does: ${job.does === 'report' ? 'only reports' : 'acts'}`,
    ...(job.until.kind === 'outcome' ? [`doneWhen: ${job.until.criterion}`] : []),
    `enabled: ${String(job.enabled)}${job.disabledReason === undefined ? '' : ` (${job.disabledReason})`}`,
    `nextRunAt: ${job.nextRunAt === undefined ? 'none' : formatLocalIso(job.nextRunAt)}`,
    ...(last === undefined
      ? []
      : [`lastRun: ${formatLocalIso(last.at)} ${last.ok ? 'ok' : 'failed'} — ${last.summary.slice(0, 200)}`]),
  ].join('\n');
}

export async function hostRunning(screamHomeDir: string): Promise<boolean> {
  return (await queryProcessLock({ scope: sessionLockScope(screamHomeDir), name: 'host' })).held;
}

// ── JobCreate ────────────────────────────────────────────────────────

export const JobCreateInputSchema = z.object({
  title: z.string().describe('A short name for the task, shown in /jobs.'),
  prompt: z.string().describe('What each run should do, in the person\'s words. It runs in a fresh session.'),
  cron: z.string().optional().describe('Repeating: 5-field cron in local time, e.g. "3 9 * * 1-5".'),
  in: z.string().optional().describe('Once, after a delay: "90m", "2h", "1d".'),
  at: z.string().optional().describe('Once, at a local time: "14:30", "tomorrow 09:00", "2026-11-20 09:00".'),
  report_only: z.boolean().optional().describe('true = look and report, change nothing.'),
  done_when: z.string().optional().describe('An outcome that completes the task, e.g. "all tests pass".'),
});
export type JobCreateInput = z.infer<typeof JobCreateInputSchema>;

export class JobCreateTool implements BuiltinTool<JobCreateInput> {
  readonly name = 'JobCreate' as const;
  readonly description = JOB_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(JobCreateInputSchema);

  constructor(private readonly context: JobToolContext) {}

  resolveExecution(received: JobCreateInput): ToolExecution {
    const nowMs = this.context.now();
    const cron = blank(received.cron);
    const inDelay = blank(received.in);
    const at = blank(received.at);
    const given = [cron, inDelay, at].filter((value) => value !== undefined).length;
    if (given !== 1) {
      return {
        isError: true,
        output: `Give exactly one of "cron", "in" or "at".\n${clockLines(nowMs)}`,
      };
    }
    if (received.prompt.trim() === '' || received.prompt.length > MAX_PROMPT_CHARS) {
      return { isError: true, output: `The prompt must be 1–${String(MAX_PROMPT_CHARS)} characters.` };
    }
    let starts: JobStarts;
    if (cron !== undefined) {
      starts = { kind: 'cron', cron };
    } else {
      const resolved = resolveOneShotWhen({ in: inDelay, at }, nowMs);
      if (!resolved.ok) return { isError: true, output: `${resolved.error}\n${clockLines(nowMs)}` };
      starts = { kind: 'once', at: resolved.fireAt };
    }
    const doneWhen = blank(received.done_when);
    return {
      description: `Creating background task "${received.title}"`,
      approvalRule: this.name,
      execute: async () => {
        const store = new JobStore(this.context.screamHomeDir);
        let job: Job;
        try {
          job = await store.add(
            {
              title: received.title,
              prompt: received.prompt,
              starts,
              does: received.report_only === true ? 'report' : 'act',
              until: doneWhen === undefined ? { kind: 'stopped' } : { kind: 'outcome', criterion: doneWhen },
              workDir: this.context.workDir(),
              createdBy: 'agent',
              ...(this.context.sessionId?.startsWith('line-') === true ? { deliverTo: this.context.sessionId } : {}),
            },
            nowMs,
          );
        } catch (error) {
          if (error instanceof JobError) return { isError: true, output: `${error.message}\n${clockLines(nowMs)}` };
          throw error;
        }
        const running = await hostRunning(this.context.screamHomeDir);
        return {
          output: [
            describeJob(job),
            running
              ? 'host: running — the task runs on schedule.'
              : 'host: not running yet — an open terminal starts it within a minute (and a terminal opened later does too); it then keeps running after the terminal closes until the computer restarts. Tell the person: /service also starts it after a restart.',
            clockLines(nowMs),
          ].join('\n'),
        };
      },
    };
  }
}

// ── JobList ──────────────────────────────────────────────────────────

export const JobListInputSchema = z.object({});
export type JobListInput = z.infer<typeof JobListInputSchema>;

export class JobListTool implements BuiltinTool<JobListInput> {
  readonly name = 'JobList' as const;
  readonly description = JOB_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(JobListInputSchema);

  constructor(private readonly context: JobToolContext) {}

  resolveExecution(): ToolExecution {
    return {
      description: 'Listing background tasks',
      approvalRule: this.name,
      execute: async () => {
        const jobs = new JobStore(this.context.screamHomeDir).list();
        const running = await hostRunning(this.context.screamHomeDir);
        const body = jobs.length === 0 ? 'No background tasks.' : jobs.map(describeJob).join('\n\n');
        return {
          output: `${body}\n\nhost: ${running ? 'running' : 'NOT running (/service keeps it running)'}\n${clockLines(this.context.now())}`,
        };
      },
    };
  }
}

// ── JobDelete ────────────────────────────────────────────────────────

export const JobDeleteInputSchema = z.object({
  id: z.string().describe('The task id, `job-` and 8 hex characters.'),
});
export type JobDeleteInput = z.infer<typeof JobDeleteInputSchema>;

export class JobDeleteTool implements BuiltinTool<JobDeleteInput> {
  readonly name = 'JobDelete' as const;
  readonly description = JOB_DELETE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(JobDeleteInputSchema);

  constructor(private readonly context: JobToolContext) {}

  resolveExecution(args: JobDeleteInput): ToolExecution {
    if (!/^job-[0-9a-f]{8}$/.test(args.id)) {
      return { isError: true, output: `Invalid task id ${JSON.stringify(args.id)}: expected job- and 8 hex characters.` };
    }
    return {
      description: `Deleting background task ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        try {
          const removed = await new JobStore(this.context.screamHomeDir).remove(args.id);
          return { output: `Deleted background task ${removed.id} (${removed.title}).` };
        } catch (error) {
          if (error instanceof JobError) return { isError: true, output: error.message };
          throw error;
        }
      },
    };
  }
}
