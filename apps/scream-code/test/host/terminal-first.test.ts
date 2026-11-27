/**
 * The terminal-first pieces: what background work did is logged and shown
 * when a terminal opens; the footer counts jobs; jobs start the background
 * without /service; system notifications; "同意" in the chat.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore, listInbox } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ running: false, started: 0 }));
vi.mock('#/host/control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/host/control')>();
  return {
    ...actual,
    readHostStatus: vi.fn(async () => ({ running: control.running })),
    startHostDetached: vi.fn(async () => {
      control.started += 1;
      return { pid: 1, alreadyRunning: false };
    }),
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'terminal-first-'));
  vi.stubEnv('SCREAM_CODE_HOME', home);
  control.running = false;
  control.started = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('activity log and the away note', () => {
  it('shows what happened since the terminal was last open, and only that', async () => {
    const { appendActivity, readLastSeen, writeLastSeen } = await import('#/host/activity');
    const { readAwayEntries, renderAwaySummary } = await import('#/tui/utils/jobs-status');
    expect(readLastSeen()).toBe(0);
    appendActivity({ kind: 'job', title: 'old run', ok: true, at: 1_000 });
    writeLastSeen(2_000);
    appendActivity({ kind: 'job', title: 'CI check', ok: true, detail: 'all green\nmore', at: 3_000 });
    appendActivity({ kind: 'continued', title: 'fix flaky tests', ok: false, detail: 'stopped', at: 4_000 });
    const entries = readAwayEntries(readLastSeen());
    expect(entries.map((e) => e.title)).toEqual(['CI check', 'fix flaky tests']);
    const lines = renderAwaySummary(entries, 1).join('\n');
    expect(lines).toContain('✓ CI check');
    expect(lines).toContain('all green');
    expect(lines).not.toContain('more');
    expect(lines).toContain('✗');
    expect(lines).toContain('/jobs');
    expect(readAwayEntries(0)).toEqual([]);
  });
});

describe('jobs without /service', () => {
  it('counts jobs and starts the background when jobs are on and it is not up, at most every 5 minutes', async () => {
    const { ensureBackgroundForJobs, readJobsFooterStatus, resetAutoStartForTests } = await import('#/tui/utils/jobs-status');
    resetAutoStartForTests();
    expect(await readJobsFooterStatus()).toMatchObject({ enabled: 0, waiting: 0, hostRunning: false });
    expect(await ensureBackgroundForJobs(await readJobsFooterStatus())).toBe(false);
    await new JobStore(home).add({ title: 'CI', prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' }, workDir: home, createdBy: 'person' });
    const status = await readJobsFooterStatus(1_000_000);
    expect(status).toMatchObject({ enabled: 1, waiting: 0, hostRunning: false, jobs: [{ title: 'CI', lastOk: undefined }] });
    expect(await ensureBackgroundForJobs(status, 1_000_000)).toBe(true);
    expect(await ensureBackgroundForJobs(status, 1_000_000 + 60_000)).toBe(false);
    expect(await ensureBackgroundForJobs(status, 1_000_000 + 6 * 60_000)).toBe(true);
    expect(control.started).toBe(2);
    control.running = true;
    expect(await ensureBackgroundForJobs(await readJobsFooterStatus(), 1_000_000 + 20 * 60_000)).toBe(false);
  });

  it('counts memories as waiting but not as needing a heads-up, like the background', async () => {
    const { readJobsFooterStatus } = await import('#/tui/utils/jobs-status');
    const dir = join(home, 'host', 'inbox');
    mkdirSync(dir, { recursive: true });
    const item = (id: string, kind: string): void => {
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({ id, kind, sessionId: 's', workDir: home, createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, status: 'pending' }),
      );
    };
    item('inbox-a', 'memory');
    item('inbox-b', 'approval');
    item('inbox-c', 'question');
    expect(await readJobsFooterStatus()).toMatchObject({ waiting: 3, needsYou: 2 });
  });
});

describe('footer jobs item', () => {
  async function line2(overrides: Record<string, unknown>): Promise<string> {
    const { FooterComponent } = await import('#/tui/components/chrome/footer');
    const { darkColors } = await import('#/tui/theme/colors');
    const state = {
      model: 'k2', workDir: '/tmp', sessionId: 's', permissionMode: 'yolo', planMode: 'off', thinkingLevel: 'off',
      contextUsage: 0.1, contextTokens: 1, maxContextTokens: 10, isCompacting: false, isReplaying: false,
      streamingPhase: 'idle', streamingStartTime: 0, pendingUserAction: null, pendingUserActionSince: null,
      theme: 'dark', version: 't', editorCommand: null, notifications: { enabled: true, condition: 'unfocused' },
      availableModels: {}, lineActive: true, linePlatform: 'lark', ...overrides,
    };
    const footer = new FooterComponent(state as never, darkColors, { requestRender: () => {} } as never);
    // eslint-disable-next-line no-control-regex
    const text = (footer.render(200)[0] ?? '').replaceAll(/\u001B\[[0-9;]*m/g, '');
    footer.dispose();
    return text;
  }

  it('shows only what needs the person, next to the channel', async () => {
    expect(await line2({})).not.toMatch(/jobs|待处理|waiting/);
    expect(await line2({ jobsEnabled: 3, jobsWaiting: 0, jobsHostRunning: true })).not.toMatch(/jobs|待处理|waiting/);
    expect(await line2({ jobsEnabled: 3, jobsWaiting: 1, jobsHostRunning: true })).toMatch(/◆ (待处理 1|1 waiting)\s+◆ Line/);
    expect(await line2({ jobsEnabled: 2, jobsWaiting: 0, jobsHostRunning: false })).toMatch(/◆ jobs (未运行|not running)\s+◆ Line/);

    // The channel only shows while it runs; the jobs item stands on its own without it.
    expect(await line2({ jobsEnabled: 3, jobsWaiting: 1, jobsHostRunning: true, lineActive: false })).toMatch(/◆ (待处理 1|1 waiting)/);
    expect(await line2({ jobsEnabled: 3, jobsWaiting: 1, jobsHostRunning: true, lineActive: false })).not.toContain('Line');
  });
});

describe('system notifications', () => {
  it('builds a safe command per platform and nothing elsewhere', async () => {
    const { desktopNotifyCommand } = await import('#/host/desktop-notify');
    // Never osascript: its banners belong to Script Editor and a click opens it.
    expect(desktopNotifyCommand('darwin', 't', 'b', null)).toBeUndefined();
    const mac = desktopNotifyCommand('darwin', 'Scream: "x"', '-line1\nline2', '/opt/homebrew/bin/terminal-notifier');
    expect(mac).toEqual({
      command: '/opt/homebrew/bin/terminal-notifier',
      args: ['-title', 'Scream: "x"', '-message', ' -line1 line2', '-group', 'scream'],
    });
    expect(desktopNotifyCommand('linux', 't', 'b')).toEqual({ command: 'notify-send', args: ['--app-name=Scream', '--', 't', 'b'] });
    const win = desktopNotifyCommand('win32', 'title; rm -rf', 'body');
    expect(win?.args.at(-1)).not.toContain('rm -rf');
    expect(desktopNotifyCommand('aix', 't', 'b')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('finds terminal-notifier installed after a miss (a miss is not remembered)', async () => {
    const { chmodSync } = await import('node:fs');
    const { desktopNotifyCommand } = await import('#/host/desktop-notify');
    const bin = mkdtempSync(join(tmpdir(), 'notifier-bin-'));
    const previousPath = process.env['PATH'];
    process.env['PATH'] = bin;
    try {
      expect(desktopNotifyCommand('darwin', 't', 'b')).toBeUndefined();
      writeFileSync(join(bin, 'terminal-notifier'), '#!/bin/sh\n');
      chmodSync(join(bin, 'terminal-notifier'), 0o755);
      expect(desktopNotifyCommand('darwin', 't', 'b')?.command).toBe(join(bin, 'terminal-notifier'));
    } finally {
      process.env['PATH'] = previousPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('leaves the heads-up to the terminal where the background cannot reach the person', async () => {
    const { hostShowsDesktopNotifications } = await import('#/host/desktop-notify');
    const all = (): boolean => true;
    const none = (): boolean => false;
    expect(hostShowsDesktopNotifications('darwin', {}, all)).toBe(true);
    expect(hostShowsDesktopNotifications('darwin', {}, none)).toBe(false);
    expect(hostShowsDesktopNotifications('linux', { WAYLAND_DISPLAY: 'wayland-0' }, all)).toBe(true);
    expect(hostShowsDesktopNotifications('linux', { DISPLAY: ':0' }, none)).toBe(false);
    expect(hostShowsDesktopNotifications('linux', {}, all)).toBe(false);
    expect(hostShowsDesktopNotifications('win32', {}, all)).toBe(true);
    expect(hostShowsDesktopNotifications('linux', { DISPLAY: ':0', SSH_CONNECTION: '1 2 3 4' }, all)).toBe(false);
    expect(hostShowsDesktopNotifications('win32', { SSH_TTY: '/dev/pts/1' }, all)).toBe(false);
    expect(hostShowsDesktopNotifications('aix', {}, all)).toBe(false);
  });
});

describe('"同意" in the chat', () => {
  it('answers the one pushed approval, lists several, and leaves other text to the model', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { quickInboxReply } = await import('#/line/background-commands');
    const item = (id: string, notifiedTo: string | undefined) => {
      mkdirSync(join(home, 'host', 'inbox'), { recursive: true });
      writeFileSync(
        join(home, 'host', 'inbox', `${id}.json`),
        JSON.stringify({
          id, kind: 'approval', sessionId: 's', workDir: '/w', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
          status: 'pending', notified: notifiedTo !== undefined, ...(notifiedTo === undefined ? {} : { notifiedTo }), approval: { tool: 'Bash', action: `git push ${id}`, key: id, reason: '' },
        }),
      );
    };
    expect(quickInboxReply(home, 'line-a', '同意')).toBeUndefined();
    item('inbox-q1', 'line-a');
    item('inbox-q0', undefined);
    item('inbox-qx', 'line-other');
    expect(quickInboxReply(home, 'line-a', '好的我同意你的看法')).toBeUndefined();
    // An item pushed to another chat is never answered from this one.
    expect(quickInboxReply(home, 'line-b', '同意')).toBeUndefined();
    expect(quickInboxReply(home, 'line-a', '同意。')).toContain('同意');
    expect(listInbox(home).find((i) => i.id === 'inbox-qx')?.status).toBe('pending');
    expect(listInbox(home).find((i) => i.id === 'inbox-q1')).toMatchObject({ status: 'decided', decision: 'approve' });
    item('inbox-q2', 'line-a');
    item('inbox-q3', 'line-a');
    const several = quickInboxReply(home, 'line-a', '拒绝')!;
    expect(several).toContain('inbox-q2');
    expect(several).toContain('inbox-q3');
    expect(listInbox(home).find((i) => i.id === 'inbox-q2')?.status).toBe('pending');
  });
});
