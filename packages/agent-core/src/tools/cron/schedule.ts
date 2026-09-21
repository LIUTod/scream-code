/**
 * Cron scheduling rules, shared by the model-facing tool (`CronCreateTool`)
 * and the command path (`Agent.rpcMethods.createCronTask`).
 *
 * Both callers must apply identical gates: an expression the tool rejects
 * must not be schedulable from the UI, and a payload the UI accepts must not
 * be one the tool would have refused. Keeping every check here — and only
 * here — is what makes that true. The tool maps a failure onto
 * `{ isError: true, output }`; the RPC path throws `cron.invalid` carrying the
 * same string, so the user reads exactly the sentence the model would.
 *
 * The split is deliberate:
 *
 *   - {@link validateCronSchedule} is the prepare-time gate. Pure: it reads
 *     the clock and the store, never mutates.
 *   - {@link scheduleCronTask} mutates, and re-checks the session cap against
 *     the live store so two concurrently-prepared creates cannot collectively
 *     breach it after both passed the prepare-time check.
 *
 * `CronCreateTool` calls the two phases from `resolveExecution` / `execute`,
 * which manual approval can separate by minutes — hence two clock reads.
 */

import type { CronManager } from '../../agent/cron';

import { computeNextCronRun, hasFireWithinYears, parseCronExpression, type ParsedCronExpression } from './cron-expr';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from './jitter';
import type { CronTask } from './types';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Session-level cap on the number of live cron tasks. Exported so callers can
 * pre-fill / assert without re-deriving the magic number.
 */
export const MAX_CRON_JOBS_PER_SESSION = 50;

/**
 * Hard ceiling on `prompt` byte length (UTF-8). The zod `.max(...)` upstream
 * is in code units, which underflows multi-byte input (`'汉'.length === 1`
 * even though it is 3 bytes); we re-check using `Buffer.byteLength` so the
 * budget reflects the actual on-the-wire size the model will eventually see.
 */
export const MAX_PROMPT_BYTES = 8 * 1024;

/**
 * Maximum forward distance allowed for a one-shot (`recurring: false`) cron's
 * first fire. The canonical footgun is pinning today's day/month for a
 * "remind me at X today" reminder — if submission lands seconds past the
 * target minute, `computeNextCronRun` rolls the match to next year
 * (~365 days), which is still inside the 5-year `hasFireWithinYears` window,
 * and the user gets a year-late notification instead of an error. 350 days is
 * tight enough to catch the rollover (365 ± epsilon) while still leaving room
 * for legitimate "schedule for late this year" pinning from early-year
 * submissions. A caller who genuinely wants a one-shot 11+ months out is
 * better served by a natural-language date in the prompt body than by
 * stretching the cron field semantics.
 */
const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────

export type CronScheduleInput = {
  readonly cron: string;
  readonly prompt: string;
  readonly recurring?: boolean | undefined;
};

export type CronScheduleFailure = { readonly ok: false; readonly error: string };

/** Output of the prepare-time gate: everything the insert step needs. */
export type CronScheduleAccepted = {
  readonly ok: true;
  /** Whitespace-normalized expression (the form stored and rendered). */
  readonly normalizedCron: string;
  /** Normalized "repeat unless explicitly false" flag. */
  readonly recurring: boolean;
  readonly parsed: ParsedCronExpression;
};

export type CronScheduleResult = CronScheduleFailure | CronScheduleAccepted;

export type CronScheduleCreated = {
  readonly ok: true;
  readonly task: CronTask;
  readonly normalizedCron: string;
  readonly recurring: boolean;
  readonly nextFireAt: number | null;
};

// ── Prepare-time gate ────────────────────────────────────────────────

/**
 * Run every reject rule against a create request without mutating anything.
 *
 * Order matters and is preserved from the original tool implementation: a
 * flipped killswitch must stop the work before the parse (which can throw on
 * legitimately malformed input), and the cap is checked before the byte
 * budget so the more actionable message wins when both would reject.
 */
export function validateCronSchedule(
  manager: CronManager,
  input: CronScheduleInput,
): CronScheduleResult {
  // 1. Global killswitch — checked first so a flipped env stops all further
  //    work, including the cron parse which can throw on legitimately
  //    malformed input.
  if (process.env['SCREAM_DISABLE_CRON'] === '1') {
    return {
      ok: false,
      error: 'Cron scheduling is disabled (SCREAM_DISABLE_CRON=1).',
    };
  }

  // 2. Normalize whitespace BEFORE parsing so `parsed.raw` (which
  //    `cronToHuman` falls back to for non-template shapes) is the
  //    single-line form. Otherwise tabs/newlines from the raw input leak into
  //    the rendered `humanSchedule:` row and break the one-key-per-line tool
  //    output format. Parse errors still report against canonical field
  //    positions; only whitespace is degraded, not semantics.
  const normalizedCron = input.cron.trim().split(/\s+/).join(' ');

  // 3. Parse the cron expression. Any parse failure is a user error rather
  //    than an internal one, so we surface the message verbatim — the parser
  //    is already careful to name the offending field.
  let parsed: ParsedCronExpression;
  try {
    parsed = parseCronExpression(normalizedCron);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid cron expression: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // 4. Reject "legal but never fires within 5 years" — the same bound the
  //    scheduler uses internally to refuse to spin. `0 0 31 2 *` is the
  //    canonical example.
  const nowAtPrepare = manager.clocks.wallNow();
  if (!hasFireWithinYears(parsed, 5, nowAtPrepare)) {
    return {
      ok: false,
      error: `Cron expression ${JSON.stringify(
        normalizedCron,
      )} has no fire within 5 years; refusing to schedule.`,
    };
  }

  // 5. Session-level cap — preliminary check. `scheduleCronTask` re-checks
  //    because manual-approval mode can delay execution long enough for
  //    parallel creates to all pass this gate and then collectively breach
  //    the cap on insert.
  if (manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
    return {
      ok: false,
      error: `Cron job cap reached (max ${String(
        MAX_CRON_JOBS_PER_SESSION,
      )} per session).`,
    };
  }

  // 6. Byte-length cap. zod's `.max()` counts code units, which is not the
  //    budget we actually want for a multi-byte prompt; the
  //    Buffer.byteLength check makes the 8 KiB intent literal.
  //
  //    Emptiness is checked by the same gate rather than left to the tool's
  //    `.min(1)`: that schema is enforced by the args validator on the model
  //    path only, and an empty prompt would otherwise be accepted from the
  //    command/SDK path and fire an empty turn forever.
  if (input.prompt.trim().length === 0) {
    return { ok: false, error: 'Prompt is empty.' };
  }

  const byteLen = Buffer.byteLength(input.prompt, 'utf8');
  if (byteLen > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      error: `Prompt exceeds ${String(
        MAX_PROMPT_BYTES,
      )} bytes (got ${String(byteLen)}).`,
    };
  }

  // `recurring` follows the canonical "recurring iff not explicitly false"
  // convention used everywhere else in the cron stack.
  const recurring = input.recurring !== false;

  // 7. One-shot "rolled to next year" guard. The docs recommend pinning
  //    today's dom/month for "remind me at X today"; if submission lands
  //    seconds past the target minute, `computeNextCronRun` returns next
  //    year's match, the 5-year window above accepts it, and the reminder
  //    fires a year late. Reject when the first ideal fire is more than ~one
  //    year out — for a 5-field cron this can only mean the pinned date
  //    already passed this year. Recurring tasks are unaffected.
  if (!recurring) {
    const firstFire = computeNextCronRun(parsed, nowAtPrepare);
    if (
      firstFire !== null &&
      firstFire - nowAtPrepare > ONE_SHOT_MAX_FUTURE_MS
    ) {
      return {
        ok: false,
        error: `One-shot cron ${JSON.stringify(
          normalizedCron,
        )} would not fire until ${new Date(
          firstFire,
        ).toISOString()} (more than a year out). If you meant "today" or a near date, the pinned day/month has already passed this year — pick a future date or use wildcards.`,
      };
    }
  }

  return { ok: true, normalizedCron, recurring, parsed };
}

// ── Insert step ──────────────────────────────────────────────────────

/**
 * Insert a validated request and report its post-jitter next fire.
 *
 * Anchors the schedule to the moment of *this* call, not the moment of
 * validation: manual approval can leave the two minutes apart, and inserting
 * with a stale `nowMs` would let the scheduler treat a fresh one-shot as
 * already overdue and fire it on the next tick with a phantom
 * `coalescedCount > 1`.
 */
export function scheduleCronTask(
  manager: CronManager,
  accepted: CronScheduleAccepted,
  input: CronScheduleInput,
): CronScheduleFailure | CronScheduleCreated {
  const nowMs = manager.clocks.wallNow();

  // Re-check the session cap against the live store so two
  // concurrently-prepared creates cannot collectively breach it after both
  // passed the prepare-time check.
  if (manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
    return {
      ok: false,
      error: `Cron job cap reached (max ${String(
        MAX_CRON_JOBS_PER_SESSION,
      )} per session).`,
    };
  }

  // `recurring` is stored as supplied so `undefined` keeps meaning "repeat by
  // default" everywhere downstream (`CronTask.recurring` is optional).
  const task = manager.addTask({
    cron: accepted.normalizedCron,
    prompt: input.prompt,
    recurring: input.recurring,
  });

  // Post-jitter next-fire for the response. `computeNextCronRun` returns
  // `null` if there's no fire in the 5-year window (already rejected above,
  // but be defensive — the jitter helper would then have nothing to shift).
  const ideal = computeNextCronRun(accepted.parsed, nowMs);
  const nextFireAt =
    ideal === null
      ? null
      : accepted.recurring
        ? jitteredNextCronRunMs(task, accepted.parsed, ideal)
        : oneShotJitteredNextCronRunMs(task, ideal);

  return {
    ok: true,
    task,
    normalizedCron: accepted.normalizedCron,
    recurring: accepted.recurring,
    nextFireAt,
  };
}
