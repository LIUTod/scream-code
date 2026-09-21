/**
 * Tests for `tools/cron/schedule.ts` — the single source of truth for the
 * cron create rules, shared by `CronCreateTool` (model path) and
 * `Agent.rpcMethods.createCronTask` (the `/cron` command path).
 *
 * The last block is the load-bearing one: both callers must reject with the
 * *identical* sentence, because one path shows it to the model and the other
 * to the user. A drift there is exactly the bug this module exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron/manager';
import type { ExecutableToolContext } from '../../../src/loop/types';
import { CronCreateTool, type CronCreateInput } from '../../../src/tools/cron/cron-create';
import {
  MAX_CRON_JOBS_PER_SESSION,
  MAX_PROMPT_BYTES,
  scheduleCronTask,
  validateCronSchedule,
} from '../../../src/tools/cron/schedule';
import { createAgentStub, createClocks, WALL_ANCHOR } from '../../agent/cron/harness/stub';

function makeHarness() {
  const stub = createAgentStub();
  const clock = createClocks();
  const manager = new CronManager(stub.agent, {
    clocks: clock.clocks,
    pollIntervalMs: null,
  });
  return { manager, clock, tool: new CronCreateTool(manager) };
}

/** Minimal execution context, same shape the tool tests use. */
function toolContext(): ExecutableToolContext {
  return {
    turnId: 'test-turn',
    toolCallId: 'test-call',
    signal: new AbortController().signal,
  };
}

describe('validateCronSchedule', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses everything while the killswitch is on', () => {
    vi.stubEnv('SCREAM_DISABLE_CRON', '1');
    const { manager } = makeHarness();

    expect(validateCronSchedule(manager, { cron: '*/5 * * * *', prompt: 'x' })).toEqual({
      ok: false,
      error: 'Cron scheduling is disabled (SCREAM_DISABLE_CRON=1).',
    });
  });

  it("reports a parse failure with the parser's own message", () => {
    const { manager } = makeHarness();
    const result = validateCronSchedule(manager, { cron: 'not-a-cron', prompt: 'x' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/^Invalid cron expression: /);
  });

  it('normalizes whitespace before parsing', () => {
    const { manager } = makeHarness();

    expect(validateCronSchedule(manager, { cron: '  */5   *  *  * *  ', prompt: 'x' })).toMatchObject({
      ok: true,
      normalizedCron: '*/5 * * * *',
    });
  });

  it('rejects an expression that never fires inside five years', () => {
    const { manager } = makeHarness();

    expect(validateCronSchedule(manager, { cron: '0 0 31 2 *', prompt: 'x' })).toEqual({
      ok: false,
      error: 'Cron expression "0 0 31 2 *" has no fire within 5 years; refusing to schedule.',
    });
  });

  it('rejects a prompt over the byte budget', () => {
    const { manager } = makeHarness();
    const prompt = 'x'.repeat(MAX_PROMPT_BYTES + 1);

    expect(validateCronSchedule(manager, { cron: '*/5 * * * *', prompt })).toEqual({
      ok: false,
      error: `Prompt exceeds ${String(MAX_PROMPT_BYTES)} bytes (got ${String(MAX_PROMPT_BYTES + 1)}).`,
    });
  });

  it('measures bytes rather than code units', () => {
    const { manager } = makeHarness();
    // 2731 CJK characters = 8193 UTF-8 bytes but only 2731 code units.
    const prompt = '汉'.repeat(Math.floor(MAX_PROMPT_BYTES / 3) + 1);

    expect(validateCronSchedule(manager, { cron: '*/5 * * * *', prompt })).toMatchObject({ ok: false });
  });

  it('rejects once the session cap is reached', () => {
    const { manager } = makeHarness();
    for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION; i += 1) {
      manager.addTask({ cron: '*/5 * * * *', prompt: `task-${String(i)}` });
    }

    expect(validateCronSchedule(manager, { cron: '*/5 * * * *', prompt: 'x' })).toEqual({
      ok: false,
      error: `Cron job cap reached (max ${String(MAX_CRON_JOBS_PER_SESSION)} per session).`,
    });
  });

  it('rejects a one-shot whose pinned day already passed this year', () => {
    const { manager, clock } = makeHarness();
    expect(clock.now()).toBe(WALL_ANCHOR);
    // Anchor is Nov 14 2023 22:13 UTC, so "Nov 1 00:00" rolls over to
    // 2024-11-01 — about 353 days out, past the 350-day guard.
    const oneShot = validateCronSchedule(manager, {
      cron: '0 0 1 11 *',
      prompt: 'x',
      recurring: false,
    });

    expect(oneShot.ok).toBe(false);
    expect(oneShot.ok ? '' : oneShot.error).toMatch(
      /^One-shot cron "0 0 1 11 \*" would not fire until \d{4}-\d{2}-\d{2}T.* \(more than a year out\)\./,
    );
    // The very same expression is fine as a repeating task.
    expect(validateCronSchedule(manager, { cron: '0 0 1 11 *', prompt: 'x' })).toMatchObject({ ok: true });
  });

  it('rejects an empty prompt, which no tool schema can police on the SDK path', () => {
    const { manager } = makeHarness();

    expect(validateCronSchedule(manager, { cron: '*/5 * * * *', prompt: '   ' })).toEqual({
      ok: false,
      error: 'Prompt is empty.',
    });
  });

  it('treats an absent recurring flag as repeating', () => {
    const { manager } = makeHarness();

    expect(validateCronSchedule(manager, { cron: '*/5 * * * *', prompt: 'x' })).toMatchObject({
      ok: true,
      recurring: true,
    });
    expect(validateCronSchedule(manager, { cron: '*/5 * * * *', prompt: 'x', recurring: false })).toMatchObject({
      ok: true,
      recurring: false,
    });
  });
});

describe('scheduleCronTask', () => {
  it('inserts the task and reports a post-jitter next fire', () => {
    const { manager } = makeHarness();
    const input = { cron: '*/5 * * * *', prompt: 'check CI' } as const;
    const accepted = validateCronSchedule(manager, input);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const created = scheduleCronTask(manager, accepted, input);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.id).toMatch(/^[0-9a-f]{8}$/);
    expect(created.task.prompt).toBe('check CI');
    expect(created.nextFireAt).toBeGreaterThan(WALL_ANCHOR);
    expect(manager.store.list()).toHaveLength(1);
  });

  it('re-checks the cap against the live store, so a stale acceptance cannot insert', () => {
    const { manager } = makeHarness();
    const input = { cron: '*/5 * * * *', prompt: 'x' } as const;
    const accepted = validateCronSchedule(manager, input);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    // Another create lands between prepare and insert — the manual-approval
    // window the re-check exists for.
    for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION; i += 1) {
      manager.addTask({ cron: '*/5 * * * *', prompt: `task-${String(i)}` });
    }

    expect(scheduleCronTask(manager, accepted, input)).toEqual({
      ok: false,
      error: `Cron job cap reached (max ${String(MAX_CRON_JOBS_PER_SESSION)} per session).`,
    });
    expect(manager.store.list()).toHaveLength(MAX_CRON_JOBS_PER_SESSION);
  });
});

describe('tool path and command path cannot drift', () => {
  it('rejects the same inputs with the identical sentence', () => {
    const cases: readonly [string, CronCreateInput][] = [
      ['unparseable expression', { cron: 'nope', prompt: 'x', recurring: true }],
      ['five-year window', { cron: '0 0 31 2 *', prompt: 'x', recurring: true }],
      ['one-shot rollover', { cron: '0 0 1 11 *', prompt: 'x', recurring: false }],
    ];

    for (const [label, input] of cases) {
      const { manager, tool } = makeHarness();
      const validated = validateCronSchedule(manager, input);
      const viaTool = tool.resolveExecution(input);

      expect(validated.ok, label).toBe(false);
      expect(viaTool, label).toMatchObject({
        isError: true,
        output: validated.ok ? 'validator accepted' : validated.error,
      });
    }
  });

  it('resolves an omitted recurring flag the way the schema promises', async () => {
    const { manager, tool } = makeHarness();
    // The args validator is AJV without `useDefaults`, so `recurring` really
    // can be absent at the tool boundary. It must mean repeating — for the
    // label, the approval literal, the gates and the stored task — instead of
    // the pre-extraction mix ("one-shot" label and guard, repeating task).
    // The cast models the runtime truth: the inferred input type claims the
    // field is always present, which is exactly the gap AJV leaves.
    const omitted = { cron: '0 0 1 11 *', prompt: 'x' } as CronCreateInput;
    const execution = tool.resolveExecution(omitted);

    expect(execution).toMatchObject({ description: 'Scheduling cron 0 0 1 11 *' });
    if (!('execute' in execution)) return;

    // …and the same expression is NOT pushed through the one-shot rollover
    // guard, even though its next fire is ~353 days out.
    const result = await execution.execute(toolContext());
    expect(result).toMatchObject({ isError: false });
    expect('output' in result ? result.output : '').toContain('recurring: true');
    expect(manager.store.list()[0]).toMatchObject({ recurring: true });
  });

  it('fails at execute time with the same sentence as the shared gate', async () => {
    const { manager, tool } = makeHarness();
    const input: CronCreateInput = { cron: '*/5 * * * *', prompt: 'x', recurring: true };
    const execution = tool.resolveExecution(input);
    expect(execution).not.toMatchObject({ isError: true });
    if (!('execute' in execution)) return;

    // Fill the store between prepare and execute — the window manual approval
    // opens, and the only failure `execute` itself can produce.
    for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION; i += 1) {
      manager.addTask({ cron: '*/5 * * * *', prompt: `task-${String(i)}` });
    }

    await expect(execution.execute(toolContext())).resolves.toMatchObject({
      isError: true,
      output: `Cron job cap reached (max ${String(MAX_CRON_JOBS_PER_SESSION)} per session).`,
    });
  });
});
