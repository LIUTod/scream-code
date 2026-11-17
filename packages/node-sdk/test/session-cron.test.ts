/**
 * End-to-end coverage for the cron surface added to the SDK:
 * `Session.listCronTasks / createCronTask / removeCronTasks`.
 *
 * This one file exercises the whole chain — Session method → rpc client →
 * ScreamCore forwarder → SessionAPIImpl → Agent.rpcMethods → CronManager →
 * `tools/cron/schedule.ts` — so a break anywhere in it shows up here.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { ScreamHarness } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session cron tasks', () => {
  it('creates, lists and removes tasks, and surfaces the core validation verbatim', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-cron-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-cron-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_cron', workDir });
      await expect(session.listCronTasks()).resolves.toEqual([]);

      const created = await session.createCronTask({
        cron: '*/5 * * * *',
        prompt: 'check CI and report failures',
      });

      expect(created).toMatchObject({
        cron: '*/5 * * * *',
        prompt: 'check CI and report failures',
        recurring: true,
        stale: false,
      });
      expect(created.id).toMatch(/^[0-9a-f]{8}$/);
      expect(created.nextFireAt).toBeGreaterThan(Date.now());

      // One-shot tasks are stored with the flag the caller asked for.
      const once = await session.createCronTask({
        cron: '0 9 * * *',
        prompt: 'morning summary',
        recurring: false,
      });
      expect(once.recurring).toBe(false);

      const listed = await session.listCronTasks();
      expect(listed.map((task) => task.id).toSorted()).toEqual([created.id, once.id].toSorted());

      // Unknown ids are a no-op rather than an error, matching
      // `CronManager.removeTasks`.
      await expect(session.removeCronTasks(['deadbeef'])).resolves.toEqual([]);

      await expect(session.removeCronTasks([created.id])).resolves.toEqual([created.id]);
      await expect(session.listCronTasks()).resolves.toHaveLength(1);

      // Validation is the core's own sentence (the same one the model gets
      // from the CronCreate tool), prefixed with the error code by the SDK's
      // error formatter.
      await expect(
        session.createCronTask({ cron: 'not-a-cron', prompt: 'x' }),
      ).rejects.toThrowError(/Invalid cron expression: /);
      await expect(
        session.createCronTask({ cron: '0 0 31 2 *', prompt: 'x' }),
      ).rejects.toThrowError(/has no fire within 5 years/);
    } finally {
      await harness.close();
    }
  });

  it('honours scheduledTasks: false on create and on resume, and forgets it on a plain resume', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-cron-off-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-cron-off-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });
    const refused = /Scheduled tasks are off in this session/;

    try {
      const oneOff = await harness.createSession({ id: 'ses_cron_off', workDir, scheduledTasks: false });
      await expect(oneOff.createCronTask({ cron: '0 9 * * *', prompt: 'x' })).rejects.toThrowError(refused);
      await oneOff.close();

      // The switch has to survive the SDK's resume wrapper, which used to pass
      // only the id and drop every other option.
      const again = await harness.resumeSession({ id: 'ses_cron_off', scheduledTasks: false });
      await expect(again.createCronTask({ cron: '0 9 * * *', prompt: 'x' })).rejects.toThrowError(refused);
      await again.close();

      // Opened interactively, the same session schedules normally.
      const interactive = await harness.resumeSession({ id: 'ses_cron_off' });
      await expect(
        interactive.createCronTask({ cron: '0 9 * * *', prompt: 'x' }),
      ).resolves.toMatchObject({ cron: '0 9 * * *' });
      await interactive.close();
    } finally {
      await harness.close();
    }
  });

  it('startScheduledTasks turns a held session on, once', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-cron-start-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-cron-start-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const held = await harness.createSession({ id: 'ses_cron_held', workDir, scheduledTasks: false });
      await expect(held.createCronTask({ cron: '0 9 * * *', prompt: 'x' })).rejects.toThrowError(
        /Scheduled tasks are off in this session/,
      );
      await expect(held.startScheduledTasks()).resolves.toBe(true);
      await expect(held.startScheduledTasks()).resolves.toBe(false);
      await expect(held.createCronTask({ cron: '0 9 * * *', prompt: 'x' })).resolves.toMatchObject({
        cron: '0 9 * * *',
      });
      await held.close();
    } finally {
      await harness.close();
    }
  });

  it('forkSession passes scheduledTasks: false through to the fork', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-cron-fork-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-cron-fork-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      const source = await harness.createSession({ id: 'ses_cron_src', workDir });
      const fork = await harness.forkSession({ id: source.id, scheduledTasks: false });
      await expect(fork.createCronTask({ cron: '0 9 * * *', prompt: 'x' })).rejects.toThrowError(
        /Scheduled tasks are off in this session/,
      );
      await expect(fork.startScheduledTasks()).resolves.toBe(true);
      await fork.close();
      await source.close();
    } finally {
      await harness.close();
    }
  });
});

