/**
 * CronCreateTool — schedule a prompt to be re-injected into this session
 * at a future wall-clock time, either once (`recurring: false`) or on a
 * cron cadence (`recurring: true`, the default).
 *
 * Tasks live in `SessionCronStore` and are mirrored to
 * `<sessionDir>/cron/<id>.json` via `CronManager.addTask`, so a
 * `scream resume` of the same session reloads them and the scheduler
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

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { literalRulePattern } from '../support/rule-match';
import { cronToHuman } from './cron-expr';
import { MAX_PROMPT_BYTES, scheduleCronTask, validateCronSchedule } from './schedule';
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
    .describe(
      '5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
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
      'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
    ),
});

export type CronCreateInput = z.Infer<typeof CronCreateInputSchema>;

// ── Output shape (internal) ─────────────────────────────────────────

interface CronCreateOutput {
  readonly id: string;
  readonly cron: string;
  readonly humanSchedule: string;
  readonly recurring: boolean;
  readonly nextFireAt: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class CronCreateTool implements BuiltinTool<CronCreateInput> {
  readonly name = 'CronCreate' as const;
  readonly description = CRON_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronCreateInputSchema,
  );

  constructor(private readonly manager: CronManager) {}

  resolveExecution(args: CronCreateInput): ToolExecution {
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
    const input = { ...args, recurring: args.recurring !== false };
    // Killswitch, parse, 5-year window, session cap, byte budget and the
    // one-shot rollover guard all run in `validateCronSchedule`; the same
    // function backs the `/cron` command, so neither path can drift.
    const accepted = validateCronSchedule(this.manager, input);
    if (!accepted.ok) {
      return {
        isError: true,
        output: accepted.error,
      };
    }

    return {
      description: accepted.recurring
        ? `Scheduling cron ${accepted.normalizedCron}`
        : `Scheduling one-shot ${accepted.normalizedCron}`,
      // Scope `session` approval to this exact payload. Without the
      // payload in the rule, a single approved CronCreate would
      // authorize any future scheduled prompt for the rest of the
      // session — including ones the user never saw before approving.
      // Matches the Bash / Write / Edit convention of including the
      // command / path in the literal rule pattern.
      approvalRule: literalRulePattern(
        this.name,
        JSON.stringify({
          cron: accepted.normalizedCron,
          prompt: input.prompt,
          recurring: accepted.recurring,
        }),
      ),
      execute: async () => {
        // Cap re-check against the live store, insert, and the post-jitter
        // next-fire anchor all live in `scheduleCronTask`; it reads the clock
        // itself so an approval delay cannot backdate the schedule.
        const created = scheduleCronTask(this.manager, accepted, input);
        if (!created.ok) {
          return {
            isError: true,
            output: created.error,
          };
        }

        const output: CronCreateOutput = {
          id: created.task.id,
          cron: created.normalizedCron,
          humanSchedule: cronToHuman(accepted.parsed),
          recurring: created.recurring,
          nextFireAt: created.nextFireAt,
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

function formatOutput(o: CronCreateOutput): string {
  const lines = [
    `id: ${o.id}`,
    `cron: ${o.cron}`,
    `humanSchedule: ${o.humanSchedule}`,
    `recurring: ${String(o.recurring)}`,
    `nextFireAt: ${
      o.nextFireAt === null ? 'null' : new Date(o.nextFireAt).toISOString()
    }`,
  ];
  return lines.join('\n');
}
