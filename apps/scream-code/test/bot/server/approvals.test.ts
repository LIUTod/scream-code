import { describe, expect, it, vi } from 'vitest';

import type { BotRecord, ThreadRecord } from '../../../src/bot/server/store';
import {
  approvalRequest,
  createRuntimeFixture,
  questionRequest,
  type RuntimeFixture,
} from './fakes';

interface Fixture extends RuntimeFixture {
  readonly bot: BotRecord;
  readonly thread: ThreadRecord;
  readonly runId: string;
}

async function setup(options: { approvalTimeoutMs?: number; questionTimeoutMs?: number } = {}): Promise<Fixture> {
  const fixture = createRuntimeFixture(options);
  const bot = fixture.store.createBot({ name: 'Scream', workspace: process.cwd() });
  const thread = fixture.store.createThread(bot.id);
  const run = fixture.runtime.prompt(thread.id, { text: 'do the thing' });
  await vi.waitFor(() => {
    expect(fixture.factory.sessionFor(thread.id).prompts).toEqual(['do the thing']);
  });
  return { ...fixture, bot, thread, runId: run.runId };
}

describe('BotRuntime approvals', () => {
  it('persists before announcing, parks the run, and resolves the SDK handler', async () => {
    const fixture = await setup();
    const session = fixture.factory.sessionFor(fixture.thread.id);
    const decision = session.requestApproval(approvalRequest());

    await vi.waitFor(() => {
      expect(fixture.store.listApprovals({ pendingOnly: true })).toHaveLength(1);
    });
    const row = fixture.store.listApprovals({ pendingOnly: true })[0]!;
    expect(row).toMatchObject({
      botId: fixture.bot.id,
      threadId: fixture.thread.id,
      runId: fixture.runId,
      toolName: 'Bash',
      status: 'pending',
      reasons: ['writes outside the workspace'],
      grantOptions: ['once', 'session'],
    });
    expect(row.expiresAt).toBeGreaterThan(row.createdAt);
    expect(fixture.store.getRun(fixture.runId)?.status).toBe('waiting_user');

    const events = await fixture.runtime.hydrate(fixture.thread.id);
    expect(events.length).toBeGreaterThan(0);

    const resolved = await fixture.runtime.resolveApproval(row.id, 'allow_session');
    expect(resolved?.status).toBe('approved');
    await expect(decision).resolves.toEqual({ decision: 'approved', scope: 'session' });
    expect(fixture.store.getRun(fixture.runId)?.status).toBe('running');

    // Idempotent: deciding again cannot flip the row.
    const again = await fixture.runtime.resolveApproval(row.id, 'deny');
    expect(again?.status).toBe('approved');
  });

  it('expires after the timeout and resumes the run with a cancelled decision', async () => {
    const fixture = await setup({ approvalTimeoutMs: 30 });
    const session = fixture.factory.sessionFor(fixture.thread.id);
    const decision = session.requestApproval(approvalRequest());

    await expect(decision).resolves.toEqual({ decision: 'cancelled' });
    const row = fixture.store.listApprovals()[0]!;
    expect(row.status).toBe('expired');
    expect(fixture.store.getRun(fixture.runId)?.status).toBe('running');
  });

  it('turns a deny into a rejected approval response with feedback', async () => {
    const fixture = await setup();
    const session = fixture.factory.sessionFor(fixture.thread.id);
    const decision = session.requestApproval(approvalRequest({ toolCallId: 'call_deny' }));
    await vi.waitFor(() => {
      expect(fixture.store.listApprovals({ pendingOnly: true })).toHaveLength(1);
    });
    const row = fixture.store.listApprovals({ pendingOnly: true })[0]!;
    await fixture.runtime.resolveApproval(row.id, 'deny', 'not in this repo');
    await expect(decision).resolves.toEqual({
      decision: 'rejected',
      feedback: 'not in this repo',
    });
    const stored = fixture.store.getApproval(row.id);
    expect(stored?.status).toBe('denied');
    expect(stored?.decision).toBe('deny');
    expect(stored?.feedback).toBe('not in this repo');
  });

  it('publishes approval events on the bot stream', async () => {
    const fixture = await setup();
    const seen: string[] = [];
    fixture.hub.subscribe({ botId: fixture.bot.id }, (event) => seen.push(event.type));
    const session = fixture.factory.sessionFor(fixture.thread.id);
    const decision = session.requestApproval(approvalRequest());
    await vi.waitFor(() => {
      expect(seen).toContain('approval.requested');
    });
    const row = fixture.store.listApprovals({ pendingOnly: true })[0]!;
    await fixture.runtime.resolveApproval(row.id, 'allow_once');
    await expect(decision).resolves.toEqual({ decision: 'approved' });
    expect(seen).toContain('approval.decided');
    expect(seen).toContain('bot.updated');
  });
});

describe('BotRuntime questions', () => {
  it('maps stored items back to SDK answers keyed by question text', async () => {
    const fixture = await setup();
    const session = fixture.factory.sessionFor(fixture.thread.id);
    const answer = session.requestQuestion(questionRequest());

    await vi.waitFor(() => {
      expect(fixture.store.listQuestions({ pendingOnly: true })).toHaveLength(1);
    });
    const row = fixture.store.listQuestions({ pendingOnly: true })[0]!;
    expect(row.items).toHaveLength(2);
    expect(row.items[1]).toMatchObject({ question: 'Which checks?', multiple: true });
    expect(row.items[0]?.allowOther).toBe(false);
    expect(fixture.store.getRun(fixture.runId)?.status).toBe('waiting_user');

    const resolved = await fixture.runtime.resolveQuestion(row.id, {
      '0': 'staging',
      '1': ['unit', 'e2e'],
    });
    expect(resolved?.status).toBe('answered');
    await expect(answer).resolves.toEqual({
      answers: {
        'Which environment?': 'staging',
        'Which checks?': 'unit, e2e',
      },
    });
    expect(fixture.store.getRun(fixture.runId)?.status).toBe('running');
  });

  it('expires after the timeout and answers null (dismissed)', async () => {
    const fixture = await setup({ questionTimeoutMs: 30 });
    const session = fixture.factory.sessionFor(fixture.thread.id);
    const answer = session.requestQuestion(questionRequest());
    await expect(answer).resolves.toBeNull();
    expect(fixture.store.listQuestions()[0]?.status).toBe('expired');
  });
});

describe('BotRuntime inbox', () => {
  it('exposes pending approvals and questions together', async () => {
    const fixture = await setup();
    const session = fixture.factory.sessionFor(fixture.thread.id);
    const approval = session.requestApproval(approvalRequest());
    await vi.waitFor(() => {
      expect(fixture.store.listApprovals({ pendingOnly: true })).toHaveLength(1);
    });
    const question = session.requestQuestion(questionRequest());
    await vi.waitFor(() => {
      expect(fixture.store.listQuestions({ pendingOnly: true })).toHaveLength(1);
    });

    expect(fixture.store.listApprovals({ pendingOnly: true })).toHaveLength(1);
    expect(fixture.store.listQuestions({ pendingOnly: true })).toHaveLength(1);

    await fixture.runtime.resolveApproval(
      fixture.store.listApprovals({ pendingOnly: true })[0]!.id,
      'allow_once',
    );
    await approval;
    await fixture.runtime.resolveQuestion(
      fixture.store.listQuestions({ pendingOnly: true })[0]!.id,
      { '0': 'staging' },
    );
    await question;

    expect(fixture.store.listApprovals({ pendingOnly: true })).toHaveLength(0);
    expect(fixture.store.listQuestions({ pendingOnly: true })).toHaveLength(0);
    expect(fixture.store.listAudit({ botId: fixture.bot.id }).length).toBeGreaterThan(0);
  });
});
