import { describe, expect, it, vi } from 'vitest';

import { createGateway } from '../../../src/bot/server/gateway';
import type { BotRecord, ThreadRecord } from '../../../src/bot/server/store';
import type { Handoff } from '../../../src/bot/shared/contracts';
import { createRuntimeFixture, type RuntimeFixture } from './fakes';

interface HandoffFixture extends RuntimeFixture {
  readonly from: BotRecord;
  readonly to: BotRecord;
  readonly fromThread: ThreadRecord;
  readonly runId: string;
}

/** Two Bots, one live run on the sender, so `message_bot` has somewhere to start. */
async function setup(): Promise<HandoffFixture> {
  const fixture = createRuntimeFixture();
  const from = fixture.store.createBot({ name: 'Scream', workspace: process.cwd() });
  const to = fixture.store.createBot({ name: 'Research', workspace: process.cwd() });
  const fromThread = fixture.store.createThread(from.id);
  const result = fixture.runtime.prompt(fromThread.id, { text: 'plan the audit' });
  await vi.waitFor(() => {
    expect(fixture.factory.sessionFor(fromThread.id).prompts).toEqual(['plan the audit']);
  });
  return { ...fixture, from, to, fromThread, runId: result.runId };
}

function sessionIdFor(fixture: RuntimeFixture, threadId: string): string {
  const sessionId = fixture.store.getThread(threadId)?.coreSessionId;
  if (sessionId === null || sessionId === undefined) {
    throw new Error(`Thread ${threadId} has no core session yet`);
  }
  return sessionId;
}

const DEFAULT_HANDOFF_ARGS: Record<string, unknown> = { to: 'Research', task: 'Audit the shell' };

/** One hand-off from the live sender run; returns the stored row. */
async function offerHandoff(
  fixture: HandoffFixture,
  args: Record<string, unknown> = DEFAULT_HANDOFF_ARGS,
  toolCallId = 'call_handoff_1',
): Promise<{
  readonly output: unknown;
  readonly isError: boolean | undefined;
  readonly handoff: ReturnType<RuntimeFixture['store']['listHandoffs']>[number] | undefined;
}> {
  const response = await fixture.runtime.handleToolCall({
    toolCallId,
    name: 'message_bot',
    sessionId: sessionIdFor(fixture, fixture.fromThread.id),
    args,
  });
  return {
    output: response.output,
    isError: response.isError,
    handoff: fixture.store.listHandoffs()[0],
  };
}

describe('durable relay recovery', () => {
  it('resumes a pending relay on start without re-running the target', async () => {
    const fixture = await setup();
    // Let the original turn finish so the relay is not queued behind it.
    fixture.factory.sessionFor(fixture.fromThread.id).complete('planned');
    await vi.waitFor(() => {
      expect(fixture.store.getRun(fixture.runId)?.status).toBe('done');
    });
    const toThread = fixture.store.createThread(fixture.to.id);
    const handoff = fixture.store.createHandoff({
      fromBotId: fixture.from.id,
      fromThreadId: fixture.fromThread.id,
      toBotId: fixture.to.id,
      toThreadId: toThread.id,
      parentRunId: fixture.runId,
      depth: 1,
      task: 'Audit the shell',
      constraints: null,
      expecting: null,
      idempotencyKey: 'crash-relay-1',
    });
    fixture.store.markHandoffAwaitingRelay(handoff.handoff.id, 'answer before crash');

    fixture.runtime.start();

    const session = fixture.factory.sessionFor(fixture.fromThread.id);
    await vi.waitFor(() => {
      expect(session.prompts).toHaveLength(2);
    });
    expect(session.prompts[1]).toContain('[handoff result] Research answered:');
    expect(session.prompts[1]).toContain('answer before crash');
    // The target must not run again just because the relay was pending.
    expect(fixture.store.listRuns({ threadId: toThread.id })).toHaveLength(0);

    session.complete('Relayed after restart.');
    await vi.waitFor(() => {
      expect(fixture.store.getHandoff(handoff.handoff.id)?.status).toBe('delivered');
    });
  });
});

describe('message_bot tool registration', () => {
  it('registers the tool on every opened session', async () => {
    const fixture = await setup();
    const session = fixture.factory.sessionFor(fixture.fromThread.id);
    const registration = session.registeredTools.find((tool) => tool.name === 'message_bot');
    expect(registration?.description).toMatch(/one hop only/i);
    expect(registration?.parameters).toMatchObject({
      properties: { action: { enum: ['send', 'list'] } },
    });
  });
});

describe('message_bot hand-off', () => {
  it('queues a row, opens the target thread and prompts the target Bot', async () => {
    const fixture = await setup();
    const response = await fixture.runtime.handleToolCall({
      toolCallId: 'call_handoff_1',
      name: 'message_bot',
      sessionId: sessionIdFor(fixture, fixture.fromThread.id),
      args: {
        to: 'Research',
        task: 'Audit the shell',
        constraints: 'Read only',
        expecting: 'A short report',
      },
    });

    expect(response.isError).toBe(false);
    expect(response.output).toBe(
      'Handed to Research. Its answer will come back to this conversation.',
    );

    const handoffs = fixture.store.listHandoffs();
    expect(handoffs).toHaveLength(1);
    const handoff = handoffs[0];
    expect(handoff).toMatchObject({
      fromBotId: fixture.from.id,
      toBotId: fixture.to.id,
      fromThreadId: fixture.fromThread.id,
      parentRunId: fixture.runId,
      depth: 1,
      status: 'running',
      targetRunId: expect.any(String),
      relayStatus: null,
      task: 'Audit the shell',
      constraints: 'Read only',
      expecting: 'A short report',
      answer: null,
      completedAt: null,
    });

    const toThread = fixture.store.getThread(handoff?.toThreadId ?? '');
    expect(toThread).toMatchObject({
      botId: fixture.to.id,
      title: 'handoff from Scream',
      handoffDepth: 1,
    });

    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(toThread?.id ?? '').prompts).toHaveLength(1);
    });
    const envelope = fixture.factory.sessionFor(toThread?.id ?? '').prompts[0] ?? '';
    expect(envelope).toContain(
      'You received this task from Scream, another Bot in the same workbench.',
    );
    expect(envelope).toContain('Task: Audit the shell');
    expect(envelope).toContain('Constraints: Read only');
    expect(envelope).toContain('Expected: A short report');
    expect(envelope).toContain('your answer is relayed back to Scream');

    const audit = fixture.store.listAudit({ botId: fixture.from.id });
    expect(audit.some((entry) => entry.action === 'handoff.offered')).toBe(true);
  });

  it('reuses the target thread a second hand-off already opened', async () => {
    const fixture = await setup();
    await offerHandoff(fixture);
    await offerHandoff(fixture, { to: 'Research', task: 'Check the tests' }, 'call_handoff_2');

    const handoffs = fixture.store.listHandoffs();
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]?.toThreadId).toBe(handoffs[1]?.toThreadId);
    expect(fixture.store.listThreads(fixture.to.id)).toHaveLength(1);
  });

  it('returns the same row for a replayed task instead of handing it over twice', async () => {
    const fixture = await setup();
    const first = await offerHandoff(fixture);
    const second = await offerHandoff(
      fixture,
      { to: 'Research', task: 'Audit the shell' },
      'call_handoff_2',
    );

    expect(first.output).toBe('Handed to Research. Its answer will come back to this conversation.');
    expect(second.output).toBe('That task was already handed to Research.');
    expect(second.isError).toBe(false);
    expect(fixture.store.listHandoffs()).toHaveLength(1);
    const toThreadId = fixture.store.listHandoffs()[0]?.toThreadId ?? '';
    expect(fixture.store.listRunsForThread(toThreadId)).toHaveLength(1);
  });

  it('writes the target answer back and gives the sender a follow-up turn', async () => {
    const fixture = await setup();
    const { handoff } = await offerHandoff(fixture);
    const handoffId = handoff?.id ?? '';
    const toThreadId = handoff?.toThreadId ?? '';

    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(toThreadId).prompts).toHaveLength(1);
    });
    // The sender finishes its own turn first; the follow-up queues behind it.
    fixture.factory.sessionFor(fixture.fromThread.id).complete('I asked Research.');
    await vi.waitFor(() => {
      expect(fixture.store.getRun(fixture.runId)?.status).toBe('done');
    });

    fixture.factory.sessionFor(toThreadId).complete('The shell is clean.');
    await vi.waitFor(() => {
      expect(fixture.store.getHandoff(handoffId)?.status).toBe('awaiting_relay');
    });

    const answered = fixture.store.getHandoff(handoffId);
    expect(answered?.answer).toBe('The shell is clean.');
    expect(answered?.completedAt).not.toBeNull();

    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.fromThread.id).prompts).toHaveLength(2);
    });
    const followUp = fixture.factory.sessionFor(fixture.fromThread.id).prompts[1] ?? '';
    expect(followUp).toContain('[handoff result] Research answered:');
    expect(followUp).toContain('The shell is clean.');
    expect(followUp).toContain('Do not call message_bot for this result.');

    // Delivery is only claimed once the relay turn actually finishes.
    fixture.factory.sessionFor(fixture.fromThread.id).complete('Research says the shell is clean.');
    await vi.waitFor(() => {
      expect(fixture.store.getHandoff(handoffId)?.status).toBe('delivered');
    });

    const audit = fixture.store.listAudit({ botId: fixture.to.id });
    expect(audit.some((entry) => entry.action === 'handoff.answered')).toBe(true);
  });

  it('fails the hand-off and tells the sender when the target run fails', async () => {
    const fixture = await setup();
    const { handoff } = await offerHandoff(fixture);
    const handoffId = handoff?.id ?? '';
    const toThreadId = handoff?.toThreadId ?? '';

    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(toThreadId).prompts).toHaveLength(1);
    });
    fixture.factory.sessionFor(fixture.fromThread.id).complete('I asked Research.');
    await vi.waitFor(() => {
      expect(fixture.store.getRun(fixture.runId)?.status).toBe('done');
    });

    fixture.factory.sessionFor(toThreadId).fail(new Error('model exploded'));
    await vi.waitFor(() => {
      expect(fixture.store.getHandoff(handoffId)?.status).toBe('failed');
    });
    expect(fixture.store.getHandoff(handoffId)?.error).toContain('model exploded');

    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.fromThread.id).prompts).toHaveLength(2);
    });
    expect(fixture.factory.sessionFor(fixture.fromThread.id).prompts[1]).toBe(
      '[handoff failed] Research could not finish: model exploded',
    );
  });
});

describe('message_bot refusals', () => {
  it('answers an unknown Bot in one sentence without a tool error', async () => {
    const fixture = await setup();
    const result = await offerHandoff(fixture, { to: 'Ghost', task: 'anything' });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('No Bot named "Ghost" in this workbench.');
    expect(fixture.store.listHandoffs()).toHaveLength(0);
  });

  it('asks for a stable id when two Bots share a name', async () => {
    const fixture = await setup();
    fixture.store.createBot({ name: 'Research', workspace: '/tmp' });

    const ambiguous = await offerHandoff(fixture, { to: 'Research', task: 'audit' });
    expect(ambiguous.isError).toBe(false);
    expect(ambiguous.output).toMatch(/Several Bots match/);
    expect(ambiguous.output).toContain(fixture.to.id);
    expect(fixture.store.listHandoffs()).toHaveLength(0);

    const byId = await offerHandoff(fixture, { to: fixture.to.id, task: 'audit' });
    expect(byId.isError).toBe(false);
    expect(fixture.store.listHandoffs()).toHaveLength(1);
  });

  it('refuses a hand-off to itself', async () => {
    const fixture = await setup();
    const result = await offerHandoff(fixture, { to: 'Scream', task: 'anything' });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('That is you. Pick another Bot.');
  });

  it('refuses a paused Bot', async () => {
    const fixture = await setup();
    fixture.store.setBotPaused(fixture.to.id, true);
    const result = await offerHandoff(fixture);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('Research is paused and cannot take work right now.');
  });

  it('refuses a second hop', async () => {
    const fixture = await setup();
    fixture.store.updateThread(fixture.fromThread.id, { handoffDepth: 1 });
    const result = await offerHandoff(fixture);
    expect(result.isError).toBe(false);
    expect(result.output).toBe(
      'This task already came from another Bot; it cannot be handed on again.',
    );
  });

  it('refuses a fourth hand-off in one run', async () => {
    const fixture = await setup();
    const targetThread = fixture.store.createThread(fixture.to.id, {
      title: 'handoff from Scream',
      handoffDepth: 1,
    });
    for (let index = 0; index < 3; index += 1) {
      fixture.store.createHandoff({
        fromBotId: fixture.from.id,
        fromThreadId: fixture.fromThread.id,
        toBotId: fixture.to.id,
        toThreadId: targetThread.id,
        parentRunId: fixture.runId,
        depth: 1,
        task: `earlier task ${String(index)}`,
        constraints: null,
        expecting: null,
        idempotencyKey: `seed-${String(index)}`,
      });
    }

    const result = await offerHandoff(fixture);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('This run has already handed off three times, which is the limit.');

    const audit = fixture.store.listAudit({ botId: fixture.from.id });
    const refused = audit.filter((entry) => entry.action === 'handoff.refused');
    expect(refused.map((entry) => entry.decision)).toEqual(['refused']);
  });

  it('reports an unknown tool and a detached session as tool errors', async () => {
    const fixture = await setup();
    const unknown = await fixture.runtime.handleToolCall({
      toolCallId: 'call_x',
      name: 'something_else',
      sessionId: sessionIdFor(fixture, fixture.fromThread.id),
      args: {},
    });
    expect(unknown).toEqual({ output: 'Unknown tool: something_else', isError: true });

    const detached = await fixture.runtime.handleToolCall({
      toolCallId: 'call_y',
      name: 'message_bot',
      sessionId: 'core_session_that_does_not_exist',
      args: { to: 'Research', task: 'x' },
    });
    expect(detached).toEqual({
      output: 'This session is not attached to a Bot thread.',
      isError: true,
    });
  });

  it('refuses to hand off when the Bot policy disables it', async () => {
    const fixture = await setup();
    fixture.store.updateBot(fixture.from.id, { toolPolicy: { handoff: false } });
    const result = await fixture.runtime.handleToolCall({
      toolCallId: 'call_policy',
      name: 'message_bot',
      sessionId: sessionIdFor(fixture, fixture.fromThread.id),
      args: { action: 'send',to: 'Research', task: 'audit' },
    });
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/not allowed to hand work/);
    expect(fixture.store.listHandoffs()).toHaveLength(0);
  });
});

describe('handoff gateway routes', () => {
  it('serves GET /api/handoffs and fills the inbox handoffs list', async () => {
    const fixture = await setup();
    const app = createGateway({
      store: fixture.store,
      runtime: fixture.runtime,
      hub: fixture.hub,
    });
    await offerHandoff(fixture);

    const listed = (await (await app.request('/api/handoffs')).json()) as Handoff[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      fromBotId: fixture.from.id,
      toBotId: fixture.to.id,
      status: 'running',
      targetRunId: expect.any(String),
      relayStatus: null,
      task: 'Audit the shell',
      answer: null,
      completedAt: null,
    });

    const filtered = (await (
      await app.request(`/api/handoffs?botId=${fixture.to.id}&limit=10`)
    ).json()) as Handoff[];
    expect(filtered).toHaveLength(1);
    const none = (await (await app.request('/api/handoffs?botId=bot_nobody')).json()) as Handoff[];
    expect(none).toHaveLength(0);

    const inbox = (await (await app.request('/api/inbox')).json()) as {
      readonly handoffs: readonly Handoff[];
    };
    expect(inbox.handoffs).toHaveLength(1);
    expect(inbox.handoffs[0]?.id).toBe(listed[0]?.id);
  });
});
