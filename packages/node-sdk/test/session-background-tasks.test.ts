import { afterEach, describe, expect, it } from 'vitest';

import { ScreamHarness, type ScreamError } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.listBackgroundTasks / getBackgroundTaskOutput / getBackgroundTaskOutputPath', () => {
  it('lists an empty task set for a fresh session', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_list_empty', workDir });
      const tasks = await session.listBackgroundTasks();
      expect(tasks).toEqual([]);

      const filtered = await session.listBackgroundTasks({ activeOnly: true });
      expect(filtered).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns empty output and undefined path for an unknown task id', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_unknown', workDir });
      // Unknown task ids must not throw — UI fetches output speculatively.
      await expect(session.getBackgroundTaskOutput('bash-deadbeef')).resolves.toBe('');
      await expect(session.getBackgroundTaskOutputPath('bash-deadbeef')).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('rejects empty task ids with a stable error code', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_empty_id', workDir });
      await expect(session.getBackgroundTaskOutput('')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'background.task_id_empty',
      } satisfies Partial<ScreamError>);
      await expect(session.getBackgroundTaskOutputPath('   ')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'background.task_id_empty',
      } satisfies Partial<ScreamError>);
      await expect(session.stopBackgroundTask('')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'background.task_id_empty',
      } satisfies Partial<ScreamError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_closed', workDir });
      await session.close();

      await expect(session.listBackgroundTasks()).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'session.closed',
      } satisfies Partial<ScreamError>);
      await expect(session.getBackgroundTaskOutput('bash-aaaaaaaa')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'session.closed',
      } satisfies Partial<ScreamError>);
      await expect(session.getBackgroundTaskOutputPath('bash-aaaaaaaa')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'session.closed',
      } satisfies Partial<ScreamError>);
      await expect(session.stopBackgroundTask('bash-aaaaaaaa')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'session.closed',
      } satisfies Partial<ScreamError>);
    } finally {
      await harness.close();
    }
  });

  it('stopBackgroundTask is a no-op for an unknown task id', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-bgtask-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_stop_unknown', workDir });
      // Unknown task ids must not throw — the core BPM silently no-ops.
      await expect(
        session.stopBackgroundTask('bash-deadbeef', { reason: 'test' }),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});
