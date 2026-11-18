import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t } from '@scream-code/config';
import { JobStore } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleJobsCommand } from '#/tui/commands/jobs';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

let savedHome: string | undefined;
let home: string;

beforeEach(() => {
  savedHome = process.env['SCREAM_CODE_HOME'];
  home = mkdtempSync(join(tmpdir(), 'jobs-cmd-'));
  process.env['SCREAM_CODE_HOME'] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function makeHost() {
  const host = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    state: { theme: { colors: { textDim: '#777', warning: '#fa0' } }, appState: { workDir: '/w' } },
    session: undefined,
  };
  return host as unknown as SlashCommandHost & typeof host;
}

describe('/jobs', () => {
  it('deletes a background task by id', async () => {
    const store = new JobStore(home);
    const job = await store.add({
      title: 'nightly',
      prompt: 'p',
      starts: { kind: 'cron', cron: '0 2 * * *' },
      workDir: '/w',
      createdBy: 'person',
    });
    const host = makeHost();

    await handleJobsCommand(host, `rm ${job.id}`);

    expect(store.list()).toEqual([]);
    expect(host.showStatus).toHaveBeenCalledWith(t('jobs.deleted', { title: 'nightly' }));
  });

  it('says how to use it for an unknown subcommand or a missing id', async () => {
    const host = makeHost();
    await handleJobsCommand(host, 'frobnicate');
    await handleJobsCommand(host, 'rm');
    expect(host.showStatus).toHaveBeenCalledTimes(2);
    expect(host.showStatus).toHaveBeenCalledWith(t('jobs.usage'), '#777');
  });

  it('reports a task that does not exist', async () => {
    const host = makeHost();
    await handleJobsCommand(host, 'rm job-00000000');
    expect(host.showError).toHaveBeenCalledTimes(1);
  });
});
