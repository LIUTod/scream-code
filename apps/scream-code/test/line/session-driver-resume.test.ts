/**
 * After a daemon start, chat sessions that still hold scheduled tasks are
 * opened right away instead of waiting for the chat's next message — and that
 * background open never deletes or replaces anything when it fails.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScreamHarness } from '@scream-code/scream-code-sdk';

import { createScreamCodeHostIdentity } from '#/cli/version';
import { LineSessionDriver } from '#/line/session-driver';
import type { LineSessionDriverOptions } from '#/line/session-driver';

interface Summary {
  id: string;
  workDir: string;
  sessionDir: string;
  createdAt: number;
  updatedAt: number;
}

interface DriverInternals {
  harness: unknown;
  sessions: Map<string, unknown>;
  cronForwarders: Map<string, unknown>;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  steps.length = 0;
});

/** Records the order a chat session is wired up in. */
const steps: string[] = [];

function fakeSession(id: string, opts: { promptFails?: boolean } = {}): Record<string, unknown> {
  return {
    id,
    onEvent: () => {
      steps.push(`subscribe:${id}`);
      return () => {};
    },
    setRuntimeSystemPrompt: async () => {
      steps.push(`prompt:${id}`);
      if (opts.promptFails === true) throw new Error('prompt rejected');
    },
    startScheduledTasks: vi.fn(async () => {
      steps.push(`start:${id}`);
      return true;
    }),
    registerTool: async () => {},
    setApprovalHandler: () => {},
    setQuestionHandler: () => {},
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

/**
 * A session dir on disk laid out like the core's: the main agent's tasks are
 * `agents/main/cron/<id>.json`. `cron` lists the files placed there.
 */
function sessionOnDisk(root: string, id: string, cron?: readonly string[]): Summary {
  const sessionDir = join(root, id);
  mkdirSync(sessionDir, { recursive: true });
  if (cron !== undefined) {
    const cronDir = join(sessionDir, 'agents', 'main', 'cron');
    mkdirSync(cronDir, { recursive: true });
    for (const name of cron) writeFileSync(join(cronDir, name), '{}');
  }
  return { id, workDir: '/work', sessionDir, createdAt: 0, updatedAt: 0 };
}

function setup(summaries: Summary[], overrides: Record<string, unknown> = {}) {
  const harness = {
    listSessions: vi.fn(async (input: { sessionId?: string } = {}) =>
      input.sessionId === undefined ? summaries : summaries.filter((s) => s.id === input.sessionId),
    ),
    resumeSession: vi.fn(async ({ id }: { id: string }) => fakeSession(id)),
    deleteSession: vi.fn(async () => {}),
    createSession: vi.fn(async ({ id }: { id: string }) => fakeSession(id)),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  const driver = new LineSessionDriver({
    platform: 'feishu',
    workDir: '/work',
    permissionMode: 'yolo',
  } as unknown as LineSessionDriverOptions);
  const internals = driver as unknown as DriverInternals;
  internals.harness = harness;
  return { driver, internals, harness };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'line-resume-'));
  dirs.push(root);
  return root;
}

describe('resumeScheduledSessions', () => {
  it('opens exactly the chat sessions of live platforms that have scheduled tasks', async () => {
    const root = tempRoot();
    const summaries = [
      sessionOnDisk(root, 'line-feishu-aaaaaaaaaaaaaaaa', ['0123abcd.json']),
      sessionOnDisk(root, 'line-feishu-bbbbbbbbbbbbbbbb'), // no cron dir
      sessionOnDisk(root, 'line-feishu-cccccccccccccccc', []), // empty cron dir (all tasks deleted)
      sessionOnDisk(root, 'line-feishu-dddddddddddddddd', ['0123abcd.json.tmp-1']), // half-written
      sessionOnDisk(root, 'line-weixin-eeeeeeeeeeeeeeee', ['0123abcd.json']), // platform not running
      sessionOnDisk(root, 'session_terminal', ['0123abcd.json']), // a TUI session, not a chat
    ];
    // A subagent's directory is not where tasks live; a stray file there is ignored.
    const subOnly = sessionOnDisk(root, 'line-feishu-9999999999999999');
    mkdirSync(join(subOnly.sessionDir, 'agents', 'sub-1', 'cron'), { recursive: true });
    writeFileSync(join(subOnly.sessionDir, 'agents', 'sub-1', 'cron', '0123abcd.json'), '{}');
    summaries.push(subOnly);
    const { driver, internals, harness } = setup(summaries);

    await expect(driver.resumeScheduledSessions(['line-feishu-'])).resolves.toEqual([
      'line-feishu-aaaaaaaaaaaaaaaa',
    ]);
    expect(harness.resumeSession).toHaveBeenCalledTimes(1);
    // Opened with scheduling held, so nothing fires before the forwarder listens…
    expect(harness.resumeSession).toHaveBeenCalledWith({
      id: 'line-feishu-aaaaaaaaaaaaaaaa',
      scheduledTasks: false,
    });
    // …which is subscribed first, then the channel prompt, then firing starts.
    expect(steps).toEqual([
      'subscribe:line-feishu-aaaaaaaaaaaaaaaa',
      'prompt:line-feishu-aaaaaaaaaaaaaaaa',
      'start:line-feishu-aaaaaaaaaaaaaaaa',
    ]);
    // Every session, not just the configured work directory's.
    expect(harness.listSessions).toHaveBeenCalledWith();
    // Opened like a chat that wrote: live, and forwarding its task results.
    expect(internals.sessions.has('line-feishu-aaaaaaaaaaaaaaaa')).toBe(true);
    expect(internals.cronForwarders.has('line-feishu-aaaaaaaaaaaaaaaa')).toBe(true);

    // Already open: a second pass (or a message that got there first) is a no-op.
    await expect(driver.resumeScheduledSessions(['line-feishu-'])).resolves.toEqual([]);
    expect(harness.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('covers every running platform', async () => {
    const root = tempRoot();
    const { driver } = setup([
      sessionOnDisk(root, 'line-feishu-aaaaaaaaaaaaaaaa', ['0123abcd.json']),
      sessionOnDisk(root, 'line-weixin-eeeeeeeeeeeeeeee', ['89abcdef.json']),
    ]);
    const opened = await driver.resumeScheduledSessions(['line-feishu-', 'line-weixin-']);
    expect([...opened].toSorted()).toEqual(['line-feishu-aaaaaaaaaaaaaaaa', 'line-weixin-eeeeeeeeeeeeeeee']);
  });

  it('never repairs on failure: no delete, no new session, the others still open', async () => {
    const root = tempRoot();
    const broken = sessionOnDisk(root, 'line-feishu-aaaaaaaaaaaaaaaa', ['0123abcd.json']);
    const fine = sessionOnDisk(root, 'line-feishu-ffffffffffffffff', ['0123abcd.json']);
    const resumeSession = vi.fn(async ({ id }: { id: string }) => {
      if (id === broken.id) throw new Error('model provider not reachable');
      return fakeSession(id);
    });
    const { driver, harness, internals } = setup([broken, fine], { resumeSession });

    await expect(driver.resumeScheduledSessions(['line-feishu-'])).resolves.toEqual([fine.id]);
    // The message path would wipe the directory and start over; a background
    // open must leave history and tasks exactly as they were.
    expect(harness.deleteSession).not.toHaveBeenCalled();
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(internals.sessions.has(broken.id)).toBe(false);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(broken.sessionDir, 'agents', 'main', 'cron', '0123abcd.json'))).toBe(true);
  });

  it('returns quietly when listing fails, when closed, or with no platforms', async () => {
    const failing = setup([], {
      listSessions: vi.fn(async () => {
        throw new Error('store locked');
      }),
    });
    await expect(failing.driver.resumeScheduledSessions(['line-feishu-'])).resolves.toEqual([]);

    const root = tempRoot();
    const closed = setup([sessionOnDisk(root, 'line-feishu-aaaaaaaaaaaaaaaa', ['0123abcd.json'])]);
    await expect(closed.driver.resumeScheduledSessions([])).resolves.toEqual([]);
    await closed.driver.close();
    await expect(closed.driver.resumeScheduledSessions(['line-feishu-'])).resolves.toEqual([]);
    expect(closed.harness.resumeSession).not.toHaveBeenCalled();
  });
});

describe('chat sessions start their scheduled tasks only once they are wired up', () => {
  it('still starts them when the channel prompt fails', async () => {
    const root = tempRoot();
    const summary = sessionOnDisk(root, 'line-feishu-aaaaaaaaaaaaaaaa', ['0123abcd.json']);
    const resumeSession = vi.fn(async ({ id }: { id: string }) => fakeSession(id, { promptFails: true }));
    const { driver } = setup([summary], { resumeSession });
    // The open itself reports the failure (as before) …
    await expect(driver.resumeScheduledSessions(['line-feishu-'])).resolves.toEqual([]);
    // … but the cached session's tasks are not left held for good.
    expect(steps).toEqual([
      'subscribe:line-feishu-aaaaaaaaaaaaaaaa',
      'prompt:line-feishu-aaaaaaaaaaaaaaaa',
      'start:line-feishu-aaaaaaaaaaaaaaaa',
    ]);
  });

  it('wakes a chat whose session lives under another work directory', async () => {
    const root = tempRoot();
    const moved = { ...sessionOnDisk(root, 'line-weixin-eeeeeeeeeeeeeeee', ['0123abcd.json']), workDir: '/old-project' };
    const { driver } = setup([moved]);
    await expect(driver.resumeScheduledSessions(['line-weixin-'])).resolves.toEqual([moved.id]);
  });

  it('a brand-new chat session is created held and started the same way', async () => {
    const createSession = vi.fn(async ({ id }: { id: string }) => fakeSession(id));
    const { internals, harness } = setup([], { createSession });
    await (internals as unknown as { resolveSession(key: string): Promise<unknown> }).resolveSession(
      'line-feishu-1111111111111111',
    );
    expect(harness.createSession).toHaveBeenCalledWith(expect.objectContaining({ scheduledTasks: false }));
    expect(steps.at(-1)).toBe('start:line-feishu-1111111111111111');
  });
});

describe('channel prompt on a cached chat session', () => {
  it('is retried on the next use after it failed, and applied only once it landed', async () => {
    let calls = 0;
    const session = fakeSession('line-feishu-2222222222222222');
    session['setRuntimeSystemPrompt'] = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('core busy');
    });
    const createSession = vi.fn(async () => session);
    const { internals } = setup([], { createSession });
    const resolve = (internals as unknown as { resolveSession(key: string): Promise<unknown> }).resolveSession.bind(
      internals,
    );

    // First open: the prompt fails and the open reports it (as before) …
    await expect(resolve('line-feishu-2222222222222222')).rejects.toThrow('core busy');
    // … the next message reuses the cached session and retries the prompt …
    await expect(resolve('line-feishu-2222222222222222')).resolves.toBe(session);
    expect(calls).toBe(2);
    // … and once it landed it is not sent again.
    await resolve('line-feishu-2222222222222222');
    expect(calls).toBe(2);
  });

  it('a repeat failure does not block the chat', async () => {
    const session = fakeSession('line-feishu-3333333333333333');
    session['setRuntimeSystemPrompt'] = vi.fn(async () => {
      throw new Error('still failing');
    });
    const { internals } = setup([], { createSession: vi.fn(async () => session) });
    const resolve = (internals as unknown as { resolveSession(key: string): Promise<unknown> }).resolveSession.bind(
      internals,
    );
    await expect(resolve('line-feishu-3333333333333333')).rejects.toThrow('still failing');
    await expect(resolve('line-feishu-3333333333333333')).resolves.toBe(session);
  });
});

describe('resumeScheduledSessions against the real core', () => {
  // The unit tests above lay the session out by hand; this one lets the core
  // write it, so a change in where tasks are stored cannot slip past.
  it('finds a chat session the core persisted a task for, and leaves the rest closed', async () => {
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'line-resume-real-')));
    dirs.push(workDir);
    const withTask = 'line-feishu-0123456789abcdef';
    const without = 'line-feishu-fedcba9876543210';

    const before = new ScreamHarness({
      homeDir: process.env['SCREAM_CODE_HOME']!,
      identity: createScreamCodeHostIdentity(),
    });
    const a = await before.createSession({ id: withTask, workDir });
    await a.createCronTask({ cron: '0 9 * * *', prompt: 'morning report' });
    await a.close();
    const b = await before.createSession({ id: without, workDir });
    await b.close();
    await before.close();

    const driver = new LineSessionDriver({ platform: 'feishu', workDir, permissionMode: 'yolo' });
    await driver.init();
    try {
      const opened = await driver.resumeScheduledSessions(['line-feishu-']);
      expect(opened).toContain(withTask);
      expect(opened).not.toContain(without);
    } finally {
      await driver.close();
    }
  }, 60_000);

  it('delivers a task that fell due while the daemon was down to the chat, at boot', async () => {
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'line-resume-overdue-')));
    dirs.push(workDir);
    const key = 'line-feishu-0000000000000abc';
    const before = new ScreamHarness({
      homeDir: process.env['SCREAM_CODE_HOME']!,
      identity: createScreamCodeHostIdentity(),
    });
    const session = await before.createSession({ id: key, workDir });
    await session.createCronTask({ cron: '* * * * *', prompt: 'overdue check' });
    await session.close();
    await before.close();

    // The daemon was down for ten minutes: the core's test clock jumps ahead,
    // so the task is overdue the moment its session is reopened.
    const clockFile = join(workDir, 'clock');
    writeFileSync(clockFile, String(Date.now() + 10 * 60_000));
    const savedClock = process.env['SCREAM_CRON_CLOCK'];
    process.env['SCREAM_CRON_CLOCK'] = `file:${clockFile}`;
    const driver = new LineSessionDriver({ platform: 'feishu', workDir, permissionMode: 'yolo' });
    try {
      await driver.init();
      const pushed: Array<{ key: string; text: string }> = [];
      driver.setProactiveSender(async (sessionKey, text) => {
        pushed.push({ key: sessionKey, text });
        return 'sent';
      });
      // (The data dir is shared by this file, so other chats may wake too.)
      expect(await driver.resumeScheduledSessions(['line-feishu-'])).toContain(key);
      const mine = (): Array<{ key: string; text: string }> => pushed.filter((p) => p.key === key);
      const deadline = Date.now() + 15_000;
      while (mine().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // The missed fires arrive once, merged, and in this chat.
      expect(mine()[0]?.text).toMatch(/定时任务已触发（合并 \d+ 次）：overdue check/);
    } finally {
      await driver.close();
      if (savedClock === undefined) delete process.env['SCREAM_CRON_CLOCK'];
      else process.env['SCREAM_CRON_CLOCK'] = savedClock;
    }
  }, 60_000);
});

