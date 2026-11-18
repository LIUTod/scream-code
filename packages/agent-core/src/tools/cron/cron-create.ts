/**
 * CronCreateTool — schedule a prompt to be re-injected into this session
 * at a future wall-clock time, either once (`recurring: false`) or on a
 * cron cadence (`recurring: true`, the default).
 *
 * Tasks live in `SessionCronStore` and are mirrored to
 * `<sessionDir>/agents/main/cron/<id>.json` via `CronManager.addTask`, so a
 * resuming the same session reloads them and the scheduler
 * picks up where it left off (fires that fell during downtime are
 * collapsed into a single delivery with `coalescedCount`). Tasks do
 * NOT carry over into a brand-new session.
 *
 * The tool is a shell around the rules: every gate it applies lives in
 * `./schedule` (`validateCronSchedule` / `scheduleCronTask`), shared with the
 * `/cron` command path so both enforce exactly the same ones. The firing /
 * coalesce / jitter logic lives in `CronScheduler` (one layer below) and
 * `CronManager` (one layer up). This file only knows how to:
 *
 *   1. validate the request via `validateCronSchedule`;
 *   2. add it to the manager via `scheduleCronTask` (which mirrors every
 *      store mutation to disk);
 *   3. report back the post-jitter `nextFireAt` and a human-readable
 *      schedule for the model's benefit.
 */

import { AGENT_JOB_MIN_INTERVAL_MS, cronIntervalMs, JobError, JobStore, type Job } from '../../jobs/store';
import { hostRunning } from '../jobs/job-tools';
import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { literalRulePattern } from '../support/rule-match';
import { describeLocalTimeZone, formatLocalIso } from '../../utils/local-time';
import { cronToHuman } from './cron-expr';
import {
  MAX_PROMPT_BYTES,
  scheduleCronTask,
  validateCronSchedule,
  type CronScheduleAccepted,
  type CronScheduleInput,
} from './schedule';
import { resolveOneShotWhen } from './when';
import CRON_CREATE_DESCRIPTION from './cron-create.md';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Session-level cap on the number of live cron tasks. The rule itself lives in
 * `./schedule`; re-exported here because callers (tests included) import it
 * from this module.
 */
export { MAX_CRON_JOBS_PER_SESSION } from './schedule';

// ── Input schema ─────────────────────────────────────────────────────

export const CronCreateInputSchema = z.object({
  cron: z
    .string()
    .optional()
    .describe(
      '5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "0 9 * * 1-5" = weekdays 9am local). Give exactly one of cron / in / at; for a one-off reminder prefer in or at.',
    ),
  in: z
    .string()
    .optional()
    .describe(
      'One-shot after a delay, counted from now by the tool (no clock arithmetic needed): "90s", "20m", "2h", "1h30m", "2d". Rounded up to the next minute. Use for "in 20 minutes" / "in 2 hours".',
    ),
  at: z
    .string()
    .optional()
    .describe(
      'One-shot at a local wall-clock time, 24-hour: "14:30" (the next 14:30 — today if still ahead, else tomorrow), "today 14:30", "tomorrow 09:00", or "2026-11-20 09:00". Use for "at 3pm" / "tomorrow at 9".',
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_BYTES)
    .describe('The prompt to enqueue at each fire time.'),
  recurring: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'true (default with cron) = fire on every cron match until deleted or auto-expired after 7 days; false = fire once at the next match, then auto-delete. "in" and "at" are always one-shot; leave this out or set false with them.',
    ),
  silent: z
    .boolean()
    .optional()
    .describe(
      'true = skip the "task fired" notice in the chat and deliver only the result. Use for frequent tasks that would otherwise announce themselves on every run.',
    ),
  mute: z
    .boolean()
    .optional()
    .describe(
      'true = deliver nothing at all (no notice, no result). Use for maintenance runs whose value is the side effect.',
    ),
  in_session: z
    .boolean()
    .optional()
    .describe(
      'true = keep a repeating task inside this conversation even while the background host runs. Without it, a repeating task (every 15 minutes or less often) made while the host runs becomes a background job, so it keeps running after this terminal closes.',
    ),
});

export type CronCreateInput = z.Infer<typeof CronCreateInputSchema>;

/**
 * The arguments as they really arrive. `z.Infer` reflects `.default(true)` and
 * calls `recurring` always present, but the args validator does not apply
 * defaults, so it can be absent — and absent must mean "repeat".
 */
type CronCreateArgs = Omit<CronCreateInput, 'recurring'> & { readonly recurring?: boolean | undefined };

// ── Output shape (internal) ─────────────────────────────────────────

interface CronCreateOutput {
  readonly id: string;
  readonly cron: string;
  readonly humanSchedule: string;
  readonly recurring: boolean;
  readonly nextFireAt: number | null;
  readonly silent: boolean;
  readonly mute: boolean;
  readonly nowMs: number;
}

/**
 * The current local time and zone, appended to every result and refusal: the
 * model's only other clock is the stamp taken when the session was opened, and
 * it needs today's date and the zone to write or fix a cron.
 */
function clockLines(nowMs: number): string {
  return `now: ${formatLocalIso(nowMs)}\ntimeZone: ${describeLocalTimeZone(nowMs)}`;
}

function refusal(error: string, nowMs: number): { isError: true; output: string } {
  return { isError: true, output: `${error}\n${clockLines(nowMs)}` };
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** `2026-11-18 16:05` — the local minute a one-shot is pinned to, for the approval line. */
function shortLocal(ms: number): string {
  return formatLocalIso(ms).slice(0, 16).replace('T', ' ');
}

// ── Implementation ───────────────────────────────────────────────────

export class CronCreateTool implements BuiltinTool<CronCreateInput> {
  readonly name = 'CronCreate' as const;
  readonly description = CRON_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronCreateInputSchema,
  );

  /**
   * `jobs`: where a repeating task goes instead while the background host
   * runs (a terminal session only; chat sessions already live in the host).
   */
  constructor(
    private readonly manager: CronManager,
    private readonly jobs?: CronJobRedirect,
  ) {}

  /**
   * A repeating task made in a terminal session would stop when the terminal
   * closes. While the background host runs it becomes a background job
   * instead: fresh session per run, results in /jobs. One-shots, tasks more
   * frequent than every 15 minutes, chat sessions and `in_session` stay here.
   */
  private async redirectToJob(
    input: { readonly cron: string; readonly prompt: string; readonly recurring: boolean },
    inSession: boolean,
  ): Promise<Job | undefined> {
    const jobs = this.jobs;
    if (jobs === undefined || inSession || !input.recurring) return undefined;
    const sessionId = jobs.sessionId;
    if (sessionId === undefined || sessionId.startsWith('line-') || sessionId.startsWith('job-run-')) return undefined;
    const interval = cronIntervalMs(input.cron, this.manager.clocks.wallNow());
    if (interval === undefined || interval < AGENT_JOB_MIN_INTERVAL_MS) return undefined;
    if (!(await hostRunning(jobs.screamHomeDir))) return undefined;
    const firstLine = input.prompt.split('\n').find((line) => line.trim() !== '') ?? input.prompt;
    return new JobStore(jobs.screamHomeDir).add({
      title: firstLine.trim().slice(0, 40),
      prompt: input.prompt,
      starts: { kind: 'cron', cron: input.cron },
      does: 'act',
      workDir: jobs.workDir(),
      createdBy: 'agent',
    });
  }

  resolveExecution(received: CronCreateInput): ToolExecution {
    // Some models fill every optional string with "" instead of leaving it
    // out; an empty `cron` / `in` / `at` means "not given", or a plain cron
    // request would be refused for "giving" three schedules.
    const args: CronCreateArgs = {
      ...received,
      cron: blankToUndefined(received.cron),
      in: blankToUndefined(received.in),
      at: blankToUndefined(received.at),
    };
    const nowMs = this.manager.clocks.wallNow();
    const given = [args.cron, args.in, args.at].filter((value) => value !== undefined).length;
    if (given !== 1) {
      return refusal(
        'Give exactly one of "cron" (a schedule), "in" (a delay such as "2h") or "at" (a local time such as "14:30").',
        nowMs,
      );
    }
    const when = args.cron === undefined ? { in: args.in, at: args.at } : undefined;
    if (when !== undefined && args.recurring === true) {
      return refusal(
        '"in" and "at" schedule a one-shot reminder; for a repeating task give "cron" with recurring: true.',
        nowMs,
      );
    }

    // The schema declares `recurring` with `.default(true)`, but the args
    // validator is AJV without `useDefaults`, so an omitted field really does
    // arrive as `undefined`. Resolve it once, here at the boundary, so the
    // gates, the approval literal, the reported output and the stored task all
    // see the boolean the schema promises.
    //
    // Deliberate tightening of the pre-extraction behaviour: that code fed
    // `undefined` straight through, so an omitted flag was labelled "one-shot",
    // dropped the key from the approval literal, ran the one-shot rollover
    // guard and printed `recurring: undefined` to the model — while storing a
    // task that repeats. A repeating request could therefore be refused as a
    // mis-scheduled one-shot.
    //
    // `in` / `at` are turned into a pinned one-shot cron here, by code, against
    // the real local clock — so the model never does date or timezone math.
    let first: ReturnType<typeof resolveOneShotWhen> | undefined;
    let input: CronScheduleInput & { readonly recurring: boolean };
    if (when === undefined) {
      input = { ...args, cron: args.cron!, recurring: args.recurring !== false };
    } else {
      first = resolveOneShotWhen(when, nowMs);
      if (!first.ok) return refusal(first.error, nowMs);
      input = { ...args, cron: first.cron, recurring: false, exact: true };
    }
    // Killswitch, parse, 5-year window, session cap, byte budget and the
    // one-shot rollover guard all run in `validateCronSchedule`; the same
    // function backs the `/cron` command, so neither path can drift.
    const accepted = validateCronSchedule(this.manager, input);
    if (!accepted.ok) return refusal(accepted.error, nowMs);
    const firstFireAt = first?.ok === true ? first.fireAt : undefined;

    return {
      description:
        firstFireAt !== undefined
          ? `Scheduling one-shot for ${shortLocal(firstFireAt)}`
          : accepted.recurring
            ? `Scheduling cron ${accepted.normalizedCron}`
            : `Scheduling one-shot ${accepted.normalizedCron}`,
      // Scope `session` approval to this exact payload. Without the
      // payload in the rule, a single approved CronCreate would
      // authorize any future scheduled prompt for the rest of the
      // session — including ones the user never saw before approving.
      // Matches the Bash / Write / Edit convention of including the
      // command / path in the literal rule pattern. An `in` / `at` request
      // is approved as the user asked it, not as the cron it resolved to.
      approvalRule: literalRulePattern(
        this.name,
        JSON.stringify(
          when === undefined
            ? { cron: accepted.normalizedCron, prompt: input.prompt, recurring: accepted.recurring }
            : { ...(args.in === undefined ? { at: args.at } : { in: args.in }), prompt: input.prompt, recurring: false },
        ),
      ),
      execute: async () => {
        // A manual approval can take minutes. `in` counts from when the task is
        // actually created, and an `at` time that went by during the wait is
        // refused instead of quietly moving to tomorrow.
        let finalAccepted: CronScheduleAccepted = accepted;
        let finalInput = input;
        if (when !== undefined) {
          const execNowMs = this.manager.clocks.wallNow();
          const again = resolveOneShotWhen(when, execNowMs);
          if (!again.ok) return refusal(again.error, execNowMs);
          if (args.at !== undefined && again.fireAt !== firstFireAt) {
            return refusal(
              `"at" ${JSON.stringify(args.at)} went by while waiting for approval; ask the user and create it again.`,
              execNowMs,
            );
          }
          if (again.cron !== input.cron) {
            finalInput = { ...input, cron: again.cron };
            const revalidated = validateCronSchedule(this.manager, finalInput);
            if (!revalidated.ok) return refusal(revalidated.error, execNowMs);
            finalAccepted = revalidated;
          }
        }
        // Cap re-check against the live store, insert, and the post-jitter
        // next-fire anchor all live in `scheduleCronTask`; it reads the clock
        // itself so an approval delay cannot backdate the schedule.
        try {
          const job = await this.redirectToJob(
            { cron: finalAccepted.normalizedCron, prompt: finalInput.prompt, recurring: finalAccepted.recurring },
            args.in_session === true,
          );
          if (job !== undefined) {
            return {
              output: [
                `Made a background job instead of a session task: ${job.id} ("${job.title}").`,
                `cron: ${finalAccepted.normalizedCron} (${cronToHuman(finalAccepted.parsed)})`,
                `nextRunAt: ${job.nextRunAt === undefined ? 'null' : formatLocalIso(job.nextRunAt)}`,
                'The background host runs it in a fresh session each time, also after this terminal closes; results show in /jobs. Manage it with JobList / JobDelete. To keep a task inside this conversation instead, call CronCreate again with in_session: true.',
                clockLines(this.manager.clocks.wallNow()),
              ].join('\n'),
              isError: false,
              message: `Made background job ${job.id}`,
            };
          }
        } catch (error) {
          // A full job list (20 on) or a store failure: keep it in the session.
          if (!(error instanceof JobError)) throw error;
        }
        const created = scheduleCronTask(this.manager, finalAccepted, finalInput);
        if (!created.ok) return refusal(created.error, this.manager.clocks.wallNow());

        const output: CronCreateOutput = {
          id: created.task.id,
          cron: created.normalizedCron,
          humanSchedule: cronToHuman(finalAccepted.parsed),
          recurring: created.recurring,
          nextFireAt: created.nextFireAt,
          silent: created.task.silent === true,
          mute: created.task.mute === true,
          nowMs: this.manager.clocks.wallNow(),
        };

        return {
          output: formatOutput(output),
          isError: false,
          message: `Scheduled cron ${created.task.id}`,
        };
      },
    };
  }
}

/** Where CronCreate puts a repeating task while the background host runs (see `redirectToJob`). */
export interface CronJobRedirect {
  readonly screamHomeDir: string;
  readonly sessionId: string | undefined;
  readonly workDir: () => string;
}

function formatOutput(o: CronCreateOutput): string {
  const lines = [
    `id: ${o.id}`,
    `cron: ${o.cron}`,
    `humanSchedule: ${o.humanSchedule}`,
    `recurring: ${String(o.recurring)}`,
    ...(o.silent ? ['silent: true'] : []),
    ...(o.mute ? ['mute: true'] : []),
    // Local, with the offset: the same clock the cron fields and the user use.
    `nextFireAt: ${o.nextFireAt === null ? 'null' : formatLocalIso(o.nextFireAt)}`,
    clockLines(o.nowMs),
  ];
  return lines.join('\n');
}
