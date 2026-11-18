import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cronIntervalMs,
  JOB_FATIGUE_LIMIT,
  JOB_RUNS_KEPT,
  JobStore,
  MAX_ENABLED_JOBS,
  nextJobRun,
} from '../../src/jobs/store';

const homes: string[] = [];
function store(): JobStore {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  homes.push(dir);
  return new JobStore(dir);
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 10, 18, 8, 0).getTime();

describe('JobStore', () => {
  it('adds a job with its next run and finds it again', async () => {
    const jobs = store();
    const job = await jobs.add(
      { title: 'CI', prompt: 'check CI', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: '/w', createdBy: 'person' },
      NOW,
    );
    expect(job.id).toMatch(/^job-[0-9a-f]{8}$/);
    expect(job.nextRunAt).toBe(new Date(2026, 10, 18, 9, 0).getTime());
    expect(jobs.get(job.id)).toMatchObject({ title: 'CI', does: 'act', until: { kind: 'stopped' }, enabled: true });
  });

  it('refuses an agent-made job that repeats more often than every 15 minutes', async () => {
    const jobs = store();
    await expect(
      jobs.add({ title: 't', prompt: 'p', starts: { kind: 'cron', cron: '*/5 * * * *' }, workDir: '/w', createdBy: 'agent' }, NOW),
    ).rejects.toMatchObject({ reason: 'too_frequent' });
    // A person may choose it.
    await expect(
      jobs.add({ title: 't', prompt: 'p', starts: { kind: 'cron', cron: '*/5 * * * *' }, workDir: '/w', createdBy: 'person' }, NOW),
    ).resolves.toBeDefined();
  });

  it('allows at most 20 enabled jobs', async () => {
    const jobs = store();
    for (let i = 0; i < MAX_ENABLED_JOBS; i++) {
      await jobs.add({ title: `j${String(i)}`, prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: '/w', createdBy: 'person' }, NOW);
    }
    await expect(
      jobs.add({ title: 'one more', prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: '/w', createdBy: 'person' }, NOW),
    ).rejects.toMatchObject({ reason: 'too_many' });
  });

  it(`switches a job off after ${String(JOB_FATIGUE_LIMIT)} failed runs in a row, and resets on re-enable`, async () => {
    const jobs = store();
    const job = await jobs.add({ title: 't', prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: '/w', createdBy: 'person' }, NOW);
    let current = job;
    for (let i = 0; i < JOB_FATIGUE_LIMIT; i++) {
      current = (await jobs.recordRun(job.id, { at: NOW, ok: false, sessionId: `s${String(i)}`, summary: 'failed' }, NOW)).job;
    }
    expect(current).toMatchObject({ enabled: false, disabledReason: 'fatigue', consecutiveFailures: JOB_FATIGUE_LIMIT });
    expect(await jobs.setEnabled(job.id, true, NOW)).toMatchObject({ enabled: true, consecutiveFailures: 0 });
  });

  it('keeps the newest runs, hands back the ones that fell off, and carries notes forward', async () => {
    const jobs = store();
    const job = await jobs.add({ title: 't', prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: '/w', createdBy: 'person' }, NOW);
    let dropped: readonly unknown[] = [];
    for (let i = 0; i <= JOB_RUNS_KEPT; i++) {
      ({ dropped } = await jobs.recordRun(job.id, { at: NOW + i, ok: true, sessionId: `s${String(i)}`, summary: 'ok', notes: `note ${String(i)}` }, NOW));
    }
    const after = jobs.get(job.id)!;
    expect(after.runs).toHaveLength(JOB_RUNS_KEPT);
    expect(after.runs[0]!.sessionId).toBe('s1');
    expect(dropped).toEqual([{ at: NOW, ok: true, sessionId: 's0', summary: 'ok' }]);
    expect(after.notes).toBe(`note ${String(JOB_RUNS_KEPT)}`);
  });

  it('ends a one-off job after its run, and a goal job once its outcome is reached', async () => {
    const jobs = store();
    const once = await jobs.add({ title: 'once', prompt: 'p', starts: { kind: 'once', at: NOW + 60_000 }, workDir: '/w', createdBy: 'person' }, NOW);
    expect((await jobs.recordRun(once.id, { at: NOW, ok: true, sessionId: 's', summary: '' }, NOW)).job).toMatchObject({
      enabled: false,
      disabledReason: 'ended',
    });
    const goal = await jobs.add(
      { title: 'goal', prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, until: { kind: 'outcome', criterion: 'tests pass' }, workDir: '/w', createdBy: 'person' },
      NOW,
    );
    expect(
      (await jobs.recordRun(goal.id, { at: NOW, ok: true, sessionId: 's', summary: '', outcomeReached: true }, NOW)).job,
    ).toMatchObject({ enabled: false, disabledReason: 'done' });
  });
});

describe('schedule helpers', () => {
  it('measures the tightest interval of a cron schedule', () => {
    expect(cronIntervalMs('*/20 * * * *', NOW)).toBe(20 * 60_000);
    expect(cronIntervalMs('0 9 * * 1-5', NOW)).toBe(24 * 3600_000);
  });

  it('stops at the end date', () => {
    const until = { kind: 'date' as const, at: new Date(2026, 10, 18, 10, 0).getTime() };
    expect(nextJobRun({ starts: { kind: 'cron', cron: '0 9 * * *' }, until, runs: [] }, NOW)).toBe(new Date(2026, 10, 18, 9, 0).getTime());
    expect(nextJobRun({ starts: { kind: 'cron', cron: '0 9 * * *' }, until, runs: [] }, new Date(2026, 10, 18, 9, 30).getTime())).toBeUndefined();
  });
});

describe('an unreadable jobs.json', () => {
  it('refuses changes instead of writing an empty list over every job', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JobStore, JobError, jobsPath } = await import('../../src/jobs/store');
    const dir = mkdtempSync(join(tmpdir(), 'jobs-bad-'));
    try {
      mkdirSync(join(dir, 'host'), { recursive: true });
      const broken = '{"version":1,"jobs":[{"id":"job-1",},]}';
      writeFileSync(jobsPath(dir), broken);
      const store = new JobStore(dir);
      await expect(
        store.add({ title: 't', prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: dir, createdBy: 'person' }),
      ).rejects.toBeInstanceOf(JobError);
      expect(readFileSync(jobsPath(dir), 'utf8')).toBe(broken);
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
