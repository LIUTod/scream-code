/**
 * CronCreate and the clock: `in` / `at` resolved by the tool, the local time
 * reported back, approval delays, and the switch a one-off command run uses to
 * turn scheduling off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron';
import { CronCreateTool, type CronCreateInput } from '../../../src/tools/cron/cron-create';
import { CronListTool } from '../../../src/tools/cron/cron-list';
import { CRON_UNAVAILABLE_MESSAGE } from '../../../src/tools/cron/schedule';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '../../../src/loop/types';
import { createAgentStub, createClocks, type ClockHarness } from '../../agent/cron/harness/stub';

const ORIGINAL_TZ = process.env['TZ'];

/**
 * The model's arguments as they really arrive: the args validator does not
 * apply schema defaults, so `recurring` can be absent even though the inferred
 * input type (which reflects `.default(true)`) says otherwise.
 */
type Ask = Omit<CronCreateInput, 'recurring'> & { readonly recurring?: boolean };
const ask = (input: Ask): CronCreateInput => input as CronCreateInput;

function toolContext(): ExecutableToolContext {
  return { turnId: 'test-turn', toolCallId: 'test-call', signal: new AbortController().signal };
}

function makeHarness(options: { firing?: boolean; nowMs: number }): {
  manager: CronManager;
  tool: CronCreateTool;
  clock: ClockHarness;
} {
  const clock = createClocks(options.nowMs);
  const manager = new CronManager(createAgentStub().agent, {
    clocks: clock.clocks,
    pollIntervalMs: null,
    ...(options.firing === undefined ? {} : { firing: options.firing }),
  });
  return { manager, tool: new CronCreateTool(manager), clock };
}

function runnable(execution: ToolExecution): RunnableToolExecution {
  if ((execution as RunnableToolExecution).execute === undefined) {
    throw new Error(`expected a runnable execution, got: ${String((execution as { output?: unknown }).output)}`);
  }
  return execution as RunnableToolExecution;
}

function refusedAtPrepare(execution: ToolExecution): string {
  expect((execution as RunnableToolExecution).execute).toBeUndefined();
  expect((execution as { isError?: boolean }).isError).toBe(true);
  return String((execution as { output?: unknown }).output);
}

async function run(tool: CronCreateTool, input: Ask): Promise<ExecutableToolResult> {
  return runnable(tool.resolveExecution(ask(input))).execute(toolContext());
}

/** The tool's text output; these tools never return structured content. */
function text(result: ExecutableToolResult): string {
  if (typeof result.output !== 'string') throw new TypeError('expected text output');
  return result.output;
}

function field(output: string, key: string): string | undefined {
  return new RegExp(`^${key}: (.+)$`, 'm').exec(output)?.[1];
}

beforeEach(() => {
  vi.stubEnv('SCREAM_CRON_NO_JITTER', '1');
  process.env['TZ'] = 'Asia/Shanghai';
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_TZ === undefined) delete process.env['TZ'];
  else process.env['TZ'] = ORIGINAL_TZ;
});

// Nov 18 2026, 04:00 in Shanghai — still Nov 17 in UTC.
const NOW = Date.UTC(2026, 10, 17, 20, 0, 0);

describe('CronCreate reports the local clock', () => {
  it('ends a success with the local now / timeZone and a local nextFireAt', async () => {
    const { tool } = makeHarness({ nowMs: NOW });
    const out = text(await run(tool, { cron: '0 9 * * *', prompt: 'standup', recurring: true }));
    expect(field(out, 'now')).toBe('2026-11-18T04:00:00+08:00');
    expect(field(out, 'timeZone')).toBe('Asia/Shanghai (UTC+08:00)');
    expect(field(out, 'nextFireAt')).toBe('2026-11-18T09:00:00+08:00');
  });

  it('ends a refusal with the clock too, so the model can correct itself', () => {
    const { tool } = makeHarness({ nowMs: NOW });
    const out = refusedAtPrepare(tool.resolveExecution({ cron: 'nope', prompt: 'x', recurring: true }));
    expect(out).toMatch(/^Invalid cron expression: /);
    expect(field(out, 'now')).toBe('2026-11-18T04:00:00+08:00');
  });
});

describe('CronList reports the same local clock', () => {
  it('lists nextFireAt in local time and opens with now / timeZone', async () => {
    const { manager } = makeHarness({ nowMs: NOW });
    manager.addTask({ cron: '0 9 * * *', prompt: 'standup' });
    const execution = runnable(new CronListTool(manager).resolveExecution({}));
    const out = text(await execution.execute(toolContext()));
    expect(out.split('\n').slice(0, 3)).toEqual([
      'cron_jobs: 1',
      'now: 2026-11-18T04:00:00+08:00',
      'timeZone: Asia/Shanghai (UTC+08:00)',
    ]);
    expect(field(out, 'nextFireAt')).toBe('2026-11-18T09:00:00+08:00');
  });
});

describe('"in" and "at"', () => {
  it('"in: 1h" stores a one-shot pinned to an hour from now', async () => {
    const { tool, manager } = makeHarness({ nowMs: NOW });
    const out = text(await run(tool, { in: '1h', prompt: 'stretch' }));
    expect(field(out, 'cron')).toBe('0 5 18 11 *');
    expect(field(out, 'recurring')).toBe('false');
    expect(field(out, 'nextFireAt')).toBe('2026-11-18T05:00:00+08:00');
    expect(manager.store.list()).toEqual([
      expect.objectContaining({ cron: '0 5 18 11 *', recurring: false, prompt: 'stretch' }),
    ]);
  });

  it('"at: 09:00" at 4am local is today, by the local calendar', async () => {
    const { tool } = makeHarness({ nowMs: NOW });
    const out = text(await run(tool, { at: '09:00', prompt: 'standup' }));
    expect(field(out, 'cron')).toBe('0 9 18 11 *');
    expect(field(out, 'nextFireAt')).toBe('2026-11-18T09:00:00+08:00');
  });

  it('labels the approval with the local minute and approves the request as asked', () => {
    const { tool } = makeHarness({ nowMs: NOW });
    const execution = runnable(tool.resolveExecution(ask({ at: 'tomorrow 09:00', prompt: 'p' })));
    expect(execution.description).toBe('Scheduling one-shot for 2026-11-19 09:00');
    expect(execution.approvalRule).toContain('"at":"tomorrow 09:00"');
    expect(execution.approvalRule).not.toContain('"cron"');
  });

  it.each([
    [{ prompt: 'x' }, /exactly one of "cron"/],
    [{ cron: '0 9 * * *', in: '1h', prompt: 'x' }, /exactly one of "cron"/],
    [{ in: '1h', at: '09:00', prompt: 'x' }, /exactly one of "cron"/],
    [{ in: '1h', prompt: 'x', recurring: true }, /one-shot reminder; for a repeating task give "cron"/],
    [{ in: 'later', prompt: 'x' }, /"in" must be a delay/],
    [{ at: '3pm', prompt: 'x' }, /"at" must be HH:MM/],
  ] as const)('refuses %j', (input, pattern) => {
    const { tool, manager } = makeHarness({ nowMs: NOW });
    expect(refusedAtPrepare(tool.resolveExecution(ask(input as Ask)))).toMatch(pattern);
    expect(manager.store.list()).toHaveLength(0);
  });

  it('accepts recurring: false spelled out with "in"', async () => {
    const { tool } = makeHarness({ nowMs: NOW });
    const result = await run(tool, { in: '10m', prompt: 'x', recurring: false });
    expect(result.isError ?? false).toBe(false);
  });
});

describe('approval delays', () => {
  it('"in" counts from when the task is actually created', async () => {
    const { tool, clock } = makeHarness({ nowMs: NOW });
    const execution = runnable(tool.resolveExecution(ask({ in: '30m', prompt: 'x' })));
    clock.advance(5 * 60_000); // the user took five minutes to approve
    const out = text(await execution.execute(toolContext()));
    expect(field(out, 'nextFireAt')).toBe('2026-11-18T04:35:00+08:00');
  });

  it('an "at" time that went by during the wait is refused, not moved to tomorrow', async () => {
    const { tool, clock, manager } = makeHarness({ nowMs: NOW });
    const execution = runnable(tool.resolveExecution(ask({ at: '04:01', prompt: 'x' })));
    clock.advance(2 * 60_000);
    const result = await execution.execute(toolContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/went by while waiting for approval/);
    expect(manager.store.list()).toHaveLength(0);
  });

  it('a pinned one-shot cron approved after its minute is refused, not kept for next year', async () => {
    const { tool, clock, manager } = makeHarness({ nowMs: NOW });
    // 04:01 today, pinned the old way; valid when prepared…
    const execution = runnable(tool.resolveExecution({ cron: '1 4 18 11 *', prompt: 'x', recurring: false }));
    clock.advance(2 * 60_000); // …but approved at 04:02
    const result = await execution.execute(toolContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/more than a year out/);
    expect(manager.store.list()).toHaveLength(0);
  });
});

describe('scheduling switched off for a one-off command run', () => {
  it('refuses every create with the explanation, whichever way it is asked', () => {
    for (const input of [
      { cron: '0 9 * * *', prompt: 'x', recurring: true },
      { in: '1h', prompt: 'x' },
      { at: '09:00', prompt: 'x' },
    ] as const) {
      const { tool, manager } = makeHarness({ nowMs: NOW, firing: false });
      const out = refusedAtPrepare(tool.resolveExecution(ask(input as Ask)));
      expect(out.startsWith(CRON_UNAVAILABLE_MESSAGE)).toBe(true);
      expect(manager.store.list()).toHaveLength(0);
    }
    expect(CRON_UNAVAILABLE_MESSAGE).toMatch(/scream -p/);
  });

  it('never starts the scheduler, so stored tasks do not fire in that run', () => {
    vi.useFakeTimers();
    try {
      const stub = createAgentStub();
      const clock = createClocks(NOW);
      const before = vi.getTimerCount();
      const off = new CronManager(stub.agent, { clocks: clock.clocks, firing: false });
      off.addTask({ cron: '* * * * *', prompt: 'every minute' });
      expect(vi.getTimerCount()).toBe(before); // no poll interval installed
      clock.advance(10 * 60_000);
      vi.advanceTimersByTime(10 * 60_000);
      expect(stub.steerCalls).toHaveLength(0);
      expect(off.firing).toBe(false);

      // The default still polls (the control for the assertion above).
      const on = new CronManager(createAgentStub().agent, { clocks: clock.clocks });
      expect(vi.getTimerCount()).toBe(before + 1);
      void on.stop();
      void off.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stated times fire on the minute (anti-herd jitter on)', () => {
  // Jitter is what production runs with; these tests turn it back on.
  beforeEach(() => {
    vi.stubEnv('SCREAM_CRON_NO_JITTER', '');
  });

  async function nextFire(input: Ask): Promise<number> {
    const { tool } = makeHarness({ nowMs: Date.UTC(2026, 10, 18, 5, 0) }); // 13:00 local
    return Date.parse(field(text(await run(tool, input)), 'nextFireAt')!);
  }

  it('"at 15:00" and "in 2h" fire at 15:00 exactly, whatever the task id', async () => {
    const fifteen = Date.UTC(2026, 10, 18, 7, 0);
    for (let i = 0; i < 25; i++) {
      expect(await nextFire({ at: '15:00', prompt: `meeting ${String(i)}` })).toBe(fifteen);
      expect(await nextFire({ in: '2h', prompt: `break ${String(i)}` })).toBe(fifteen);
    }
  });

  it('a one-shot written as a raw cron on :00 is still spread out (the control)', async () => {
    const fifteen = Date.UTC(2026, 10, 18, 7, 0);
    const offsets = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const at = await nextFire({ cron: '0 15 18 11 *', prompt: `p${String(i)}`, recurring: false });
      expect(at).toBeLessThanOrEqual(fifteen);
      offsets.add(fifteen - at);
    }
    expect(offsets.size).toBeGreaterThan(1);
  });

  it('the stated-time mark is stored, survives a reload, and is honoured by the scheduler', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'cron-exact-'));
    try {
      const nowMs = Date.UTC(2026, 10, 18, 5, 0);
      const stub = createAgentStub({ homedir: home });
      const clock = createClocks(nowMs);
      const first = new CronManager(stub.agent, { clocks: clock.clocks, pollIntervalMs: null });
      await run(new CronCreateTool(first), { at: '15:00', prompt: 'meeting' });
      expect(first.store.list()[0]?.exact).toBe(true);
      await first.stop();

      const reloaded = new CronManager(createAgentStub({ homedir: home }).agent, {
        clocks: clock.clocks,
        pollIntervalMs: null,
      });
      await reloaded.loadFromDisk();
      const [task] = reloaded.store.list();
      expect(task?.exact).toBe(true);
      expect(reloaded.getNextFireForTask(task!.id)).toBe(Date.UTC(2026, 10, 18, 7, 0));
      await reloaded.stop();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('blank optional schedule fields count as not given', () => {
  it('accepts a cron request that also carries empty "in" / "at"', async () => {
    const { tool } = makeHarness({ nowMs: NOW });
    const out = text(await run(tool, { cron: '0 9 * * *', in: '', at: '  ', prompt: 'daily', recurring: true }));
    expect(field(out, 'cron')).toBe('0 9 * * *');
  });

  it('accepts an "in" request that also carries an empty "cron"', async () => {
    const { tool } = makeHarness({ nowMs: NOW });
    const out = text(await run(tool, { cron: '', in: '1h', prompt: 'stretch' }));
    expect(field(out, 'cron')).toBe('0 5 18 11 *');
  });

  it('still refuses when every field is blank', () => {
    const { tool } = makeHarness({ nowMs: NOW });
    expect(refusedAtPrepare(tool.resolveExecution(ask({ cron: '', in: '', prompt: 'x' })))).toMatch(/exactly one of "cron"/);
  });
});

describe('a host can hold firing until it listens', () => {
  it('fires nothing while held, then fires the overdue task once started', () => {
    vi.useFakeTimers();
    try {
      const stub = createAgentStub();
      const clock = createClocks(NOW);
      const manager = new CronManager(stub.agent, { clocks: clock.clocks, firing: false });
      manager.addTask({ cron: '* * * * *', prompt: 'overdue' });
      clock.advance(10 * 60_000); // due many times over
      vi.advanceTimersByTime(5000);
      expect(stub.steerCalls).toHaveLength(0);

      expect(manager.enableFiring()).toBe(true);
      expect(manager.firing).toBe(true);
      expect(manager.enableFiring()).toBe(false); // idempotent
      vi.advanceTimersByTime(1500);
      expect(stub.steerCalls).toHaveLength(1);
      // Creating works again once firing is on.
      const { tool } = { tool: new CronCreateTool(manager) };
      expect((tool.resolveExecution(ask({ in: '1h', prompt: 'x' })) as RunnableToolExecution).execute).toBeDefined();
      void manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

