import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore, type ScreamHarness } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobRunner } from '#/host/job-runner';
import { writeHostSettings } from '#/host/settings';
import { addHostTokens, hostBudgetReached, hostTokensToday, usageTokens } from '#/host/usage';

let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env['SCREAM_CODE_HOME'];
  home = mkdtempSync(join(tmpdir(), 'host-usage-'));
  process.env['SCREAM_CODE_HOME'] = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const NOON = new Date(2026, 10, 18, 12, 0).getTime();

describe('host usage', () => {
  it('adds up today and starts again the next day', () => {
    addHostTokens(1_000, NOON);
    addHostTokens(500, NOON + 60_000);
    expect(hostTokensToday(NOON)).toBe(1_500);
    expect(hostTokensToday(NOON + 24 * 3600_000)).toBe(0);
  });

  it('counts input, cache and output tokens of a session', () => {
    expect(
      usageTokens({ total: { inputOther: 10, inputCacheRead: 100, inputCacheCreation: 5, output: 7 } }),
    ).toBe(122);
    expect(usageTokens(undefined)).toBe(0);
  });

  it('reaches the budget only when a limit is set', () => {
    addHostTokens(2_000_000);
    expect(hostBudgetReached()).toBe(false);
    writeHostSettings({ dailyTokenLimit: 1_000_000 });
    expect(hostBudgetReached()).toBe(true);
  });
});

describe('JobRunner under the daily limit', () => {
  it('holds due jobs, says so once, and leaves them due', async () => {
    const job = await new JobStore(home).add({
      title: 'CI',
      prompt: 'check',
      starts: { kind: 'cron', cron: '0 9 * * *' },
      workDir: '/w',
      createdBy: 'person',
    });
    const harness = { createSession: vi.fn() } as unknown as ScreamHarness;
    const held = vi.fn();
    const runner = new JobRunner({
      harness,
      screamHomeDir: home,
      messages: { firstFailure: () => '', fatigued: () => '', result: () => '', branch: () => '' },
      now: () => (job.nextRunAt ?? 0) + 1,
      budgetReached: () => true,
      onBudgetHold: held,
    });
    expect(await runner.tick()).toBe(0);
    expect(await runner.tick()).toBe(0);
    expect(held).toHaveBeenCalledTimes(1);
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(new JobStore(home).get(job.id)?.nextRunAt).toBe(job.nextRunAt);
  });
});
