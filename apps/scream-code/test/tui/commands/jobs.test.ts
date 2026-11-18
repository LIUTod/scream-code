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

describe('/jobs panel selection', () => {
  /** A host whose editor swap disposes the mounted panel, like the real one. */
  function realisticHost() {
    let mounted: { dispose?: () => void; handleInput?: (data: string) => void; constructor: { name: string } } | undefined;
    const host = {
      showStatus: vi.fn(),
      showError: vi.fn(),
      state: { theme: { colors: { textDim: '#777', warning: '#fa0', text: '#fff', primary: '#0af', border: '#555' } }, appState: { workDir: '/w' } },
      session: undefined,
      mountEditorReplacement(panel: typeof mounted) {
        mounted?.dispose?.();
        mounted = panel;
      },
      restoreEditor() {
        mounted?.dispose?.();
        mounted = undefined;
      },
      get mounted() {
        return mounted;
      },
    };
    return host as unknown as SlashCommandHost & typeof host;
  }

  it('opens the new-job wizard when "new" is picked (the pick is not lost to the panel closing)', async () => {
    const host = realisticHost();
    const done = handleJobsCommand(host, '');
    await vi.waitFor(() => {
      expect(host.mounted?.constructor.name).toBe('ChoicePickerComponent');
    });
    host.mounted?.handleInput?.('\r');
    await vi.waitFor(() => {
      expect(host.mounted?.constructor.name).toBe('TextInputDialogComponent');
    });
    host.mounted?.handleInput?.('\u001B');
    await done;
  });
});
