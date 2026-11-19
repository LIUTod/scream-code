/**
 * /jobs end to end, with a host that behaves like the real one: swapping the
 * editor disposes the mounted panel (that is what swallowed every pick
 * before). Every step is driven by key presses, as a person would.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t } from '@scream-code/config';
import { JobStore, listInbox } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleJobsCommand } from '#/tui/commands/jobs';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { darkColors } from '#/tui/theme/colors';

vi.mock('#/host/control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#/host/control')>()),
  readHostStatus: vi.fn(async () => ({ running: true })),
  wakeHost: vi.fn(async () => true),
}));

const ENTER = '\r';
const DOWN = '\u001B[B';
const ESC = '\u001B';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jobs-walk-'));
  vi.stubEnv('SCREAM_CODE_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

interface Panel {
  dispose?: () => void;
  handleInput?: (data: string) => void;
  render?: (width: number) => string[];
  constructor: { name: string };
}

function realisticHost(session?: unknown) {
  let mounted: Panel | undefined;
  const host = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    state: { theme: { colors: darkColors }, appState: { workDir: home } },
    session,
    mountEditorReplacement(panel: Panel) {
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
    /** The mounted panel's text, ANSI stripped. */
    screen(): string {
      // eslint-disable-next-line no-control-regex
      return (mounted?.render?.(100) ?? []).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    },
    async waitFor(name: string): Promise<void> {
      await vi.waitFor(() => {
        expect(mounted?.constructor.name).toBe(name);
      });
    },
    press(...keys: string[]) {
      for (const key of keys) mounted?.handleInput?.(key);
    },
    type(text: string) {
      for (const ch of text) mounted?.handleInput?.(ch);
    },
    /** Move the picker cursor to the row whose label contains `text`, then Enter. */
    async pick(text: string) {
      await vi.waitFor(() => {
        expect(this.screen()).toContain(text);
      });
      for (let i = 0; i < 20; i++) {
        const line = this.screen().split('\n').find((l) => l.includes('›') || l.includes('❯') || l.includes('>'));
        if (line?.includes(text)) break;
        this.press(DOWN);
      }
      this.press(ENTER);
    },
  };
  return host as unknown as SlashCommandHost & typeof host;
}

describe('/jobs walkthrough', () => {
  it('creates a job through the wizard: task text, schedule, act or report', async () => {
    const host = realisticHost();
    const done = handleJobsCommand(host, '');
    await host.waitFor('ChoicePickerComponent');
    host.press(ENTER); // first row: new job
    await host.waitFor('TextInputDialogComponent');
    host.type('check CI and report failures');
    host.press(ENTER);
    await host.waitFor('ChoicePickerComponent'); // schedule
    host.press(ENTER); // first preset
    await vi.waitFor(() => {
      expect(host.screen()).not.toBe('');
    });
    // Either a third picker (act / report) or done.
    if (host.mounted?.constructor.name === 'ChoicePickerComponent') host.press(DOWN, ENTER); // report
    await done;
    const jobs = new JobStore(home).list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ prompt: 'check CI and report failures', createdBy: 'person', workDir: home });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('pauses, resumes and deletes a job from its page', async () => {
    const job = await new JobStore(home).add({
      title: 'nightly deps',
      prompt: 'p',
      starts: { kind: 'cron', cron: '0 2 * * *' },
      workDir: home,
      createdBy: 'person',
    });
    const host = realisticHost();
    let done = handleJobsCommand(host, '');
    await host.pick('nightly deps');
    await host.pick(stringOf('jobs.pause'));
    await vi.waitFor(() => {
      expect(new JobStore(home).get(job.id)?.enabled).toBe(false);
    });
    // The panel comes back; open the job again and resume it.
    await host.pick('nightly deps');
    await host.pick(stringOf('jobs.resume'));
    await vi.waitFor(() => {
      expect(new JobStore(home).get(job.id)?.enabled).toBe(true);
    });
    await host.pick('nightly deps');
    await host.pick(stringOf('jobs.delete'));
    await vi.waitFor(() => {
      expect(new JobStore(home).list()).toEqual([]);
    });
    host.press(ESC);
    await done;
    done = Promise.resolve();
  });

  it('answers an approval from the top row', async () => {
    mkdirSync(join(home, 'host', 'inbox'), { recursive: true });
    writeFileSync(
      join(home, 'host', 'inbox', 'inbox-w1.json'),
      JSON.stringify({
        id: 'inbox-w1', kind: 'approval', sessionId: 's', workDir: home, createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000, status: 'pending',
        approval: { tool: 'Bash', action: 'git push origin main', key: 'k', reason: 'bot' },
      }),
    );
    const host = realisticHost();
    const done = handleJobsCommand(host, '');
    await host.pick('git push origin main');
    await host.pick(stringOf('jobs.inbox_approve'));
    await vi.waitFor(() => {
      expect(listInbox(home)[0]).toMatchObject({ status: 'decided', decision: 'approve' });
    });
    host.press(ESC);
    await done;
  });

  it('turns the weekly self-review on from its row', async () => {
    const host = realisticHost();
    const done = handleJobsCommand(host, '');
    await host.pick(stringOf('jobs.self_review_on'));
    await vi.waitFor(() => {
      expect(new JobStore(home).list().some((job) => job.prompt.startsWith('This is your weekly self-review.'))).toBe(true);
    });
    host.press(ESC);
    await done;
  });
});

function stringOf(key: string): string {
  return t(key).slice(0, 6);
}
