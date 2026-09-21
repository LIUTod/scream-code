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
});
