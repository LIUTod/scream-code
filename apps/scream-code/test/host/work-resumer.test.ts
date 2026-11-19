import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireProcessLock,
  sessionLockScope,
  type Event,
  type HeldProcessLock,
  type ScreamHarness,
  type Session,
} from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkResumer } from '#/host/work-resumer';

const homes: string[] = [];
const locks: HeldProcessLock[] = [];

afterEach(async () => {
  while (locks.length > 0) await locks.pop()!.release();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'work-resumer-'));
  homes.push(dir);
  return dir;
}

function writeRecord(
  dir: string,
  record: { sessionId: string; kind: 'goal' | 'bot' | 'chat'; handoff?: boolean; startedAt?: number },
): void {
  const runDir = join(dir, 'host', 'running');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, `${encodeURIComponent(record.sessionId)}.json`),
    JSON.stringify({ workDir: '/w', pid: 1, startedAt: record.startedAt ?? Date.now(), ...record }),
  );
}

function records(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'host', 'running'));
  } catch {
    return [];
  }
}

/** A session whose prompt runs one turn and ends it. */
function fakeSession(
  id: string,
  goalStatus?: 'active' | 'paused' | 'blocked',
): Session & { prompts: string[]; wasClosed: boolean; goalStatus: string | undefined } {
  const listeners = new Set<(event: Event) => void>();
  const emit = (type: string): void => {
    for (const listener of listeners) listener({ type, agentId: 'main', sessionId: id } as unknown as Event);
  };
  const session = {
    id,
    summary: { title: `title of ${id}` },
    prompts: [] as string[],
    wasClosed: false,
    goalStatus: goalStatus as string | undefined,
    async getGoal() {
      return { goal: session.goalStatus === undefined ? null : { objective: 'o', status: session.goalStatus } };
    },
    async updateGoalStatus(status: string) {
      session.goalStatus = status;
      return null;
    },
    onEvent(listener: (event: Event) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      session.prompts.push(text);
      setTimeout(() => {
        emit('turn.started');
        emit('turn.ended');
      }, 5);
    },
    async close() {
      session.wasClosed = true;
    },
    async handOff() {
      return { handedOff: true };
    },
  };
  return session as unknown as Session & { prompts: string[]; wasClosed: boolean; goalStatus: string | undefined };
}

function fakeHarness(
  sessions: Map<string, ReturnType<typeof fakeSession>>,
  goalStatus?: 'active' | 'paused' | 'blocked',
): ScreamHarness {
  return {
    resumeSession: vi.fn(async ({ id }: { id: string }) => {
      const session = fakeSession(id, goalStatus);
      sessions.set(id, session);
      return session;
    }),
  } as unknown as ScreamHarness;
}

async function settle(resumer: WorkResumer): Promise<void> {
  for (let i = 0; i < 100 && resumer.busy(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('WorkResumer', () => {
  it('says "handed over" to work a terminal handed over, and "interrupted" to work that was cut off', async () => {
    const dir = home();
    writeRecord(dir, { sessionId: 'ses-handed', kind: 'chat', handoff: true });
    writeRecord(dir, { sessionId: 'ses-cut', kind: 'goal' });
    const sessions = new Map<string, ReturnType<typeof fakeSession>>();
    const resumer = new WorkResumer({
      harness: fakeHarness(sessions),
      screamHomeDir: dir,
      continuationText: 'interrupted',
      handoffText: 'handed over',
      settleMs: 10,
    });
    await resumer.sweep();
    await settle(resumer);
    expect(sessions.get('ses-handed')!.prompts).toEqual(['handed over']);
    expect(sessions.get('ses-cut')!.prompts).toEqual(['interrupted']);
  });

  it('drives a goal that reopening paused, and leaves a blocked one waiting for the person', async () => {
    for (const [before, after] of [['paused', 'active'], ['blocked', 'blocked']] as const) {
      const dir = home();
      writeRecord(dir, { sessionId: 'ses-g', kind: 'goal' });
      const sessions = new Map<string, ReturnType<typeof fakeSession>>();
      const resumer = new WorkResumer({
        harness: fakeHarness(sessions, before),
        screamHomeDir: dir,
        continuationText: 'continue',
        settleMs: 10,
      });
      await resumer.sweep();
      await settle(resumer);
      expect(sessions.get('ses-g')!.goalStatus).toBe(after);
      expect(sessions.get('ses-g')!.prompts).toEqual(['continue']);
    }
  });

  it('continues an interrupted goal: opens it, prompts once, drops the old record, closes it', async () => {
    const dir = home();
    writeRecord(dir, { sessionId: 'ses-goal', kind: 'goal' });
    const sessions = new Map<string, ReturnType<typeof fakeSession>>();
    const continued: string[] = [];
    const resumer = new WorkResumer({
      harness: fakeHarness(sessions),
      screamHomeDir: dir,
      continuationText: 'continue please',
      onContinued: (_record, title) => continued.push(title ?? ''),
      settleMs: 10,
    });

    expect(await resumer.sweep()).toBe(1);
    await settle(resumer);

    const session = sessions.get('ses-goal')!;
    expect(session.prompts).toEqual(['continue please']);
    expect(session.wasClosed).toBe(true);
    expect(continued).toEqual(['title of ses-goal']);
    expect(records(dir)).toEqual([]);
  });

  it('continues a handed-off conversation, but not one that was merely cut off', async () => {
    const dir = home();
    writeRecord(dir, { sessionId: 'ses-handed', kind: 'chat', handoff: true });
    writeRecord(dir, { sessionId: 'ses-cut', kind: 'chat' });
    const sessions = new Map<string, ReturnType<typeof fakeSession>>();
    const resumer = new WorkResumer({
      harness: fakeHarness(sessions),
      screamHomeDir: dir,
      continuationText: 'go on',
      settleMs: 10,
    });

    expect(await resumer.sweep()).toBe(1);
    await settle(resumer);

    expect([...sessions.keys()]).toEqual(['ses-handed']);
    expect(records(dir)).toEqual([`${encodeURIComponent('ses-cut')}.json`]);
  });

  it('forgets a cut-off conversation record after a week', async () => {
    const dir = home();
    writeRecord(dir, { sessionId: 'ses-old', kind: 'chat', startedAt: Date.now() - 8 * 24 * 3600 * 1000 });
    const resumer = new WorkResumer({
      harness: fakeHarness(new Map()),
      screamHomeDir: dir,
      continuationText: 'x',
    });
    await resumer.sweep();
    expect(records(dir)).toEqual([]);
  });

  it('leaves a session alone while another process holds it', async () => {
    const dir = home();
    writeRecord(dir, { sessionId: 'ses-held', kind: 'bot' });
    const lock = await acquireProcessLock({ scope: sessionLockScope(dir), name: 'session:ses-held' });
    if (!lock.held) throw new Error('expected the session lock');
    locks.push(lock);
    const sessions = new Map<string, ReturnType<typeof fakeSession>>();
    const resumer = new WorkResumer({
      harness: fakeHarness(sessions),
      screamHomeDir: dir,
      continuationText: 'x',
    });

    expect(await resumer.sweep()).toBe(0);
    expect(sessions.size).toBe(0);
    expect(records(dir)).toHaveLength(1);
  });

  it('routes a chat-channel session through the channel, and waits when none runs', async () => {
    const dir = home();
    writeRecord(dir, { sessionId: 'line-feishu-abc', kind: 'chat', handoff: true });
    const harness = fakeHarness(new Map());

    const withoutChannel = new WorkResumer({ harness, screamHomeDir: dir, continuationText: 'x' });
    expect(await withoutChannel.sweep()).toBe(0);
    expect(records(dir)).toHaveLength(1);

    const channel = vi.fn(async () => {});
    const withChannel = new WorkResumer({
      harness,
      screamHomeDir: dir,
      continuationText: 'resume it',
      continueChannelSession: channel,
    });
    expect(await withChannel.sweep()).toBe(1);
    await settle(withChannel);
    expect(channel).toHaveBeenCalledWith('line-feishu-abc', 'resume it');
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(records(dir)).toEqual([]);
  });
});
