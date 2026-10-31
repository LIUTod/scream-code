import { describe, expect, it, vi } from 'vitest';

import { LineSessionDriver } from '#/line/session-driver';
import type { LineSessionDriverOptions } from '#/line/session-driver';

/**
 * Chats are independent: the driver serializes turns *per chat* and runs one
 * chat's turn alongside another's. Anything the driver keeps to answer `/stop`
 * or to bound a turn must therefore be keyed by chat — a single slot makes one
 * chat's progress silently overwrite another's.
 */

interface FakeSession {
  id: string;
  prompt: () => Promise<void>;
  onEvent: (handler: (event: unknown) => void) => () => void;
  setRuntimeSystemPrompt: () => Promise<void>;
  registerTool: () => Promise<void>;
  setApprovalHandler: () => void;
  setQuestionHandler: () => void;
  cancel: () => Promise<void>;
  close: () => Promise<void>;
  emit: (event: unknown) => void;
}

interface DriverInternals {
  harness: unknown;
  sessions: Map<string, unknown>;
  runTurn(job: { sessionKey: string; text: string }): Promise<{ ok: boolean; text: string }>;
  runCommand(
    sessionKey: string,
    text: string,
  ): Promise<{ handled: boolean; text?: string }>;
  stopActiveTurn(sessionKey: string): boolean;
  attachCronForwarder(sessionKey: string, session: unknown): void;
}

function fakeSession(id: string, opts: { promptsForever?: boolean } = {}): FakeSession {
  const handlers = new Set<(event: unknown) => void>();
  return {
    id,
    prompt: () => (opts.promptsForever === true ? new Promise<void>(() => {}) : Promise.resolve()),
    onEvent: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    setRuntimeSystemPrompt: async () => {},
    registerTool: async () => {},
    setApprovalHandler: () => {},
    setQuestionHandler: () => {},
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
  };
}

function makeDriver(): { driver: LineSessionDriver; internals: DriverInternals } {
  const driver = new LineSessionDriver({
    platform: 'feishu',
    workDir: '/tmp',
    permissionMode: 'yolo',
  } as unknown as LineSessionDriverOptions);
  const internals = driver as unknown as DriverInternals;
  internals.harness = {};
  return { driver, internals };
}

const cronFired = (): unknown => ({
  type: 'cron.fired',
  agentId: 'main',
  prompt: '检查 CI',
  origin: {
    kind: 'cron_job',
    jobId: 'job-1',
    cron: '*/5 * * * *',
    recurring: true,
    coalescedCount: 1,
    stale: false,
  },
});

const turnStarted = (turnId: number): unknown => ({
  type: 'turn.started',
  turnId,
  agentId: 'main',
  origin: { kind: 'user' },
});

const cronTurnStarted = (turnId: number): unknown => ({
  type: 'turn.started',
  turnId,
  agentId: 'main',
  origin: {
    kind: 'cron_job',
    jobId: 'job-1',
    cron: '*/5 * * * *',
    recurring: true,
    coalescedCount: 1,
    stale: false,
  },
});

const turnEnded = (turnId: number): unknown => ({
  type: 'turn.ended',
  turnId,
  agentId: 'main',
  reason: 'completed',
});

describe('per-chat turn tracking', () => {
  it('aborts the turn of its own chat while another chat is running', async () => {
    // Both chats run a turn; the second registration must not hide the first
    // from `/stop`, or the chat is told "stopped" while its turn keeps going.
    const { internals } = makeDriver();
    const a = fakeSession('sess-a', { promptsForever: true });
    const b = fakeSession('sess-b', { promptsForever: true });
    internals.sessions.set('A', a);
    internals.sessions.set('B', b);

    void internals.runTurn({ sessionKey: 'A', text: 'a' });
    await Promise.resolve();
    void internals.runTurn({ sessionKey: 'B', text: 'b' });
    await Promise.resolve();

    expect(internals.stopActiveTurn('A')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).not.toHaveBeenCalled();
  });

  it('keeps a second chat’s turn deadline when the first chat finishes', async () => {
    // A shared deadline slot means the finishing chat cancels the other one's
    // timer, leaving that turn with no way out if its provider never settles.
    vi.useFakeTimers();
    try {
      const { internals } = makeDriver();
      const a = fakeSession('sess-a', { promptsForever: true });
      const b = fakeSession('sess-b', { promptsForever: true });
      internals.sessions.set('A', a);
      internals.sessions.set('B', b);

      const first = internals.runTurn({ sessionKey: 'A', text: 'a' });
      const second = internals.runTurn({ sessionKey: 'B', text: 'b' });
      await vi.advanceTimersByTimeAsync(0);

      a.emit(turnStarted(1));
      a.emit(turnEnded(1));
      await first;

      await vi.advanceTimersByTimeAsync(15 * 60_000 + 10);
      const outcome = await Promise.race([second, Promise.resolve('hung')]);

      expect(outcome).not.toBe('hung');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a /stop escalation armed when another chat’s turn ends', async () => {
    // The escalation window exists for a turn that ignores the abort. Clearing
    // it from an unrelated chat's normal end disarms the only recovery path.
    vi.useFakeTimers();
    try {
      const { internals } = makeDriver();
      const a = fakeSession('sess-a', { promptsForever: true });
      a.cancel = () => new Promise<void>(() => {});
      const b = fakeSession('sess-b', { promptsForever: true });
      internals.sessions.set('A', a);
      internals.sessions.set('B', b);

      void internals.runTurn({ sessionKey: 'A', text: 'a' });
      await vi.advanceTimersByTimeAsync(0);
      const other = internals.runTurn({ sessionKey: 'B', text: 'b' });
      await vi.advanceTimersByTimeAsync(0);

      expect(internals.stopActiveTurn('A')).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      b.emit(turnStarted(2));
      b.emit(turnEnded(2));
      await other;

      await vi.advanceTimersByTimeAsync(10_000 + 1);

      expect(a.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scheduled task output under concurrency', () => {
  it('delivers to its own chat while another chat is mid-turn', async () => {
    // Busy-ness is a property of one chat; another chat's turn must not
    // suppress this chat's scheduled result (or its "fired" notice).
    const { driver, internals } = makeDriver();
    const sent: string[] = [];
    driver.setProactiveSender(async (_key, text) => {
      sent.push(text);
      return 'sent';
    });
    const a = fakeSession('sess-a');
    const b = fakeSession('sess-b', { promptsForever: true });
    internals.sessions.set('A', a);
    internals.sessions.set('B', b);
    internals.attachCronForwarder('A', a);

    void internals.runTurn({ sessionKey: 'B', text: 'b' });
    await Promise.resolve();

    a.emit(turnStarted(1));
    a.emit(cronFired());
    a.emit({ type: 'assistant.delta', turnId: 1, agentId: 'main', delta: '结果' });
    a.emit(turnEnded(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toContain('结果');
  });

  it('refuses /new while a scheduled task turn is running', async () => {
    // The reset deletes the session underneath the running task, so its
    // `turn.ended` never arrives and its result is lost.
    const { internals } = makeDriver();
    const a = fakeSession('sess-a');
    internals.sessions.set('A', a);
    internals.attachCronForwarder('A', a);

    a.emit(turnStarted(1));
    a.emit(cronFired());

    const result = await internals.runCommand('A', '/new');

    expect(result.text).toContain('/stop');
    expect(a.close).not.toHaveBeenCalled();
  });

  it('drops a scheduled turn on /stop without reporting it as empty', async () => {
    // `/stop` disposes the relay before cancelling, so the cancelled turn is
    // not mistaken for "ran and produced nothing" — the chat asked for it.
    const { driver, internals } = makeDriver();
    const sent: string[] = [];
    driver.setProactiveSender(async (_key, text) => {
      sent.push(text);
      return 'sent';
    });
    const a = fakeSession('sess-a');
    internals.sessions.set('A', a);
    internals.attachCronForwarder('A', a);

    a.emit(turnStarted(1));
    a.emit(cronFired());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toHaveLength(1);

    expect(internals.stopActiveTurn('A')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.emit(turnEnded(1));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sent).toHaveLength(1);
  });

  it('stops a running muted task turn instead of claiming nothing is running', async () => {
    // `--mute` sends nothing, so it has no collector to notice; the turn is
    // still running and `/stop` must be able to end it.
    const { driver, internals } = makeDriver();
    const sent: string[] = [];
    driver.setProactiveSender(async (_key, text) => {
      sent.push(text);
      return 'sent';
    });
    const a = fakeSession('sess-a');
    internals.sessions.set('A', a);
    internals.attachCronForwarder('A', a);

    a.emit(cronTurnStarted(3));
    a.emit({
      ...(cronFired() as Record<string, unknown>),
      origin: {
        kind: 'cron_job',
        jobId: 'job-1',
        cron: '*/5 * * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
        mute: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toHaveLength(0);

    expect(internals.stopActiveTurn('A')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(a.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a task turn stoppable after a subagent starts inside it', async () => {
    // A task that spawns a subagent must not make its own turn invisible.
    const { internals } = makeDriver();
    const a = fakeSession('sess-a');
    internals.sessions.set('A', a);
    internals.attachCronForwarder('A', a);

    a.emit(cronTurnStarted(4));
    a.emit({ type: 'turn.started', turnId: 9, agentId: 'sub1', origin: { kind: 'user' } });

    expect(internals.stopActiveTurn('A')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(a.cancel).toHaveBeenCalledTimes(1);
  });
});
