/**
 * The 2.0 gap fixes: a repeating CronCreate becomes a background job while
 * the host runs; missed job runs are coalesced or skipped; unattended
 * memories and "allow for this session" in the inbox; friction trend window.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeSharedMemoStore, createMemoryMemo, sharedMemoStore } from '@scream-code/memory';
import { afterEach, describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { CronManager } from '../../src/agent/cron/manager';
import { BotModePermissionPolicy } from '../../src/agent/permission/policies/bot-mode-permission';
import type { PermissionPolicyContext } from '../../src/agent/permission/types';
import { collectFriction, renderFrictionBlock } from '../../src/evolution/friction';
import { JobStore } from '../../src/jobs/store';
import type { ExecutableToolResult, RunnableToolExecution } from '../../src/loop/types';
import { addMemoryItem, decideInboxItem, listInbox, saveInboxMemories } from '../../src/session/inbox';
import { CronCreateTool } from '../../src/tools/cron/cron-create';
import { acquireProcessLock, type HeldProcessLock } from '../../src/utils/process-lock';
import { sessionLockScope } from '../../src/utils/session-lock';
import { createAgentStub, createClocks } from '../agent/cron/harness/stub';

const homes: string[] = [];
const locks: HeldProcessLock[] = [];
afterEach(async () => {
  for (const lock of locks.splice(0)) await lock.release();
  for (const dir of homes.splice(0)) {
    closeSharedMemoStore(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gaps-'));
  homes.push(dir);
  return dir;
}

async function holdHost(dir: string): Promise<void> {
  const lock = await acquireProcessLock({ scope: sessionLockScope(dir), name: 'host' });
  if (!lock.held) throw new Error('host lock busy');
  locks.push(lock);
}

async function runCron(tool: CronCreateTool, input: Record<string, unknown>): Promise<string> {
  const execution = tool.resolveExecution(input as never) as RunnableToolExecution;
  const result: ExecutableToolResult = await execution.execute({
    turnId: 't',
    toolCallId: 'c',
    signal: new AbortController().signal,
  } as never);
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

function cronTool(dir: string, sessionId: string): { tool: CronCreateTool; manager: CronManager } {
  const stub = createAgentStub();
  const manager = new CronManager(stub.agent, { clocks: createClocks().clocks, pollIntervalMs: null });
  return { tool: new CronCreateTool(manager, { screamHomeDir: dir, sessionId, workDir: () => dir }), manager };
}

describe('CronCreate while the background host runs', () => {
  it('makes a repeating task a background job', async () => {
    const dir = home();
    await holdHost(dir);
    const { tool, manager } = cronTool(dir, 'session_abc');
    const output = await runCron(tool, { cron: '0 9 * * 1-5', prompt: 'check CI and report', recurring: true });
    expect(output).toContain('Made a background job');
    expect(new JobStore(dir).list()).toHaveLength(1);
    expect(new JobStore(dir).list()[0]).toMatchObject({ createdBy: 'agent', does: 'act', prompt: 'check CI and report' });
    expect(manager.store.list()).toHaveLength(0);
  });

  it('keeps one-shots, frequent tasks, in_session and chat sessions in the conversation', async () => {
    const dir = home();
    await holdHost(dir);
    const terminal = cronTool(dir, 'session_abc').tool;
    for (const input of [
      { in: '20m', prompt: 'check again' },
      { cron: '*/5 * * * *', prompt: 'poll', recurring: true },
      { cron: '0 9 * * *', prompt: 'daily', recurring: true, in_session: true },
    ]) {
      expect(await runCron(terminal, input)).not.toContain('background job');
    }
    const chat = cronTool(dir, 'line-weixin-x').tool;
    expect(await runCron(chat, { cron: '0 9 * * *', prompt: 'daily', recurring: true })).not.toContain('background job');
    expect(new JobStore(dir).list()).toHaveLength(0);
  });

  it('keeps the task in the session when no host runs', async () => {
    const dir = home();
    const { tool } = cronTool(dir, 'session_abc');
    expect(await runCron(tool, { cron: '0 9 * * *', prompt: 'daily', recurring: true })).not.toContain('background job');
  });
});

describe('missed job runs', () => {
  async function dueJob(dir: string, nextRunAt: number) {
    const store = new JobStore(dir);
    const job = await store.add(
      { title: 'hourly', prompt: 'p', starts: { kind: 'cron', cron: '0 * * * *' }, workDir: dir, createdBy: 'person' },
      nextRunAt - 1,
    );
    return { store, job };
  }

  it('coalesces recent misses into one run that knows how many', async () => {
    const dir = home();
    const now = Date.UTC(2026, 10, 18, 12, 30);
    const { store, job } = await dueJob(dir, now - 5 * 3_600_000);
    const result = await store.catchUpMissed(job.id, now, 86_400_000);
    expect(result.kind).toBe('coalesced');
    expect(result.missed).toBeGreaterThanOrEqual(5);
    const after = store.get(job.id)!;
    expect(after.missedRuns).toBe(result.missed);
    expect(after.nextRunAt).toBeLessThanOrEqual(now);
    const recorded = await store.recordRun(job.id, { at: now, ok: true, sessionId: 's', summary: 'ok' }, now);
    expect(recorded.job.missedRuns).toBeUndefined();
  });

  it('skips misses older than the replay window and notes them', async () => {
    const dir = home();
    const store = new JobStore(dir);
    const now = Date.UTC(2026, 10, 18, 12, 30);
    const job = await store.add(
      { title: 'once', prompt: 'p', starts: { kind: 'once', at: now - 3 * 86_400_000 }, workDir: dir, createdBy: 'person' },
      now - 4 * 86_400_000,
    );
    const result = await store.catchUpMissed(job.id, now, 86_400_000);
    expect(result).toEqual({ kind: 'skipped', missed: 1 });
    expect(store.get(job.id)).toMatchObject({ enabled: false, lastSkipped: { count: 1, at: now } });
  });
});

describe('inbox: unattended memories and allow-for-session', () => {
  it('keeps memories out of the store until the person saves them', async () => {
    const dir = home();
    const store = sharedMemoStore(dir);
    await store.init();
    const memo = createMemoryMemo({
      sourceSessionId: 'job-run-1',
      userNeed: 'n',
      approach: 'a',
      outcome: 'done',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      projectDir: dir,
    } as Parameters<typeof createMemoryMemo>[0]);
    const item = addMemoryItem(dir, { sessionId: 'job-run-1', workDir: dir, memories: [memo] });
    expect((await store.list()).memos).toHaveLength(0);
    expect(decideInboxItem(dir, item.id, 'always')).toBeUndefined();
    const decided = decideInboxItem(dir, item.id, 'approve')!;
    expect(await saveInboxMemories(dir, decided)).toBe(1);
    expect(await saveInboxMemories(dir, decided)).toBe(0);
    expect((await store.list()).memos).toHaveLength(1);
  });

  it('lets an action allowed for a session through in that session only', () => {
    const dir = home();
    const agentFor = (sessionId: string) =>
      ({
        type: 'main',
        sessionId,
        screamHomeDir: dir,
        config: { cwd: '/w' },
        permission: {
          mode: 'bot',
          taintedPrivateReads: [],
          hasPendingPrivateReads: () => false,
          sessionApprovalRulePatterns: [],
          consumeOneShotApproval: () => false,
        },
      }) as unknown as Agent;
    const push = { toolCall: { id: 'c', name: 'Bash', args: '' }, args: { command: 'git push' } } as unknown as PermissionPolicyContext;
    const policy = new BotModePermissionPolicy(agentFor('s1'));
    expect(policy.evaluate(push)?.kind).toBe('deny');
    const [item] = listInbox(dir);
    decideInboxItem(dir, item!.id, 'session');
    expect(policy.evaluate(push)?.kind).toBe('approve');
    expect(policy.evaluate(push)?.kind).toBe('approve');
    expect(new BotModePermissionPolicy(agentFor('s2')).evaluate(push)?.kind).toBe('deny');
  });
});

describe('friction trend', () => {
  it('counts only the window it is asked for and shows the week before', async () => {
    const dir = home();
    const wireDir = join(dir, 'sessions', 'k', 'ses', 'agents', 'main');
    mkdirSync(wireDir, { recursive: true });
    const now = Date.now();
    const line = (time: number, id: string, isError: boolean) =>
      [
        JSON.stringify({ type: 'context.append_loop_event', time, event: { type: 'tool.call', toolCallId: id, name: 'Edit', args: {} } }),
        JSON.stringify({ type: 'context.append_loop_event', time, event: { type: 'tool.result', toolCallId: id, result: { isError } } }),
      ].join('\n');
    writeFileSync(
      join(wireDir, 'wire.jsonl'),
      [line(now - 10 * 86_400_000, 'a', true), line(now - 10 * 86_400_000, 'b', true), line(now - 3_600_000, 'c', false), line(now - 3_600_000, 'd', true)].join('\n') + '\n',
    );
    const week = await collectFriction(dir, now - 7 * 86_400_000);
    const before = await collectFriction(dir, now - 14 * 86_400_000, now - 7 * 86_400_000);
    expect(week.tools[0]).toMatchObject({ calls: 2, errors: 1 });
    expect(before.tools[0]).toMatchObject({ calls: 2, errors: 2 });
    expect(renderFrictionBlock(week, week, [], before)).toContain('Edit: 2 calls, 1 errors (50%; the week before 100%)');
  });
});
