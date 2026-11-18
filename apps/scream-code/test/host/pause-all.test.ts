import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimHostLock } from '#/host/control';
import { pauseAllBackgroundWork, pauseAllJobs } from '#/host/pause-all';

let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env['SCREAM_CODE_HOME'];
  home = mkdtempSync(join(tmpdir(), 'pause-all-'));
  process.env['SCREAM_CODE_HOME'] = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

async function addJobs(): Promise<void> {
  const store = new JobStore(home);
  for (const title of ['a', 'b']) {
    await store.add({ title, prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: '/w', createdBy: 'person' });
  }
}

describe('pause all background work', () => {
  it('pauses every task in the store when no host runs', async () => {
    await addJobs();
    expect(await pauseAllBackgroundWork()).toEqual({ paused: 2, stoppedRuns: false });
    expect(new JobStore(home).list().every((job) => !job.enabled)).toBe(true);
  });

  it('asks the running host, which pauses and stops its runs', async () => {
    await addJobs();
    const lock = await claimHostLock({ kind: 'host' });
    if (!lock.held) throw new Error('expected the host lock');
    lock.onRequest(async (request) =>
      request.type === 'pause-all' ? { ok: true, paused: (await pauseAllJobs(home)).length } : { ok: false },
    );
    try {
      expect(await pauseAllBackgroundWork()).toEqual({ paused: 2, stoppedRuns: true });
    } finally {
      await lock.release();
    }
  });
});
