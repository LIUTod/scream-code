import { describe, expect, it, vi } from 'vitest';

import { RuntimeError, mergeMessages, normalizePermission } from '../../../src/bot/server/runtime';
import type { BotRecord, RoomRecord, ThreadRecord } from '../../../src/bot/server/store';
import type { Message, ServerEvent } from '../../../src/bot/shared/contracts';
import {
  approvalRequest,
  contextMessage,
  createRuntimeFixture,
  FakeSession,
  type RuntimeFixture,
} from './fakes';

interface Fixture extends RuntimeFixture {
  readonly bot: BotRecord;
  readonly thread: ThreadRecord;
}

function setup(workspace = process.cwd()): Fixture {
  const fixture = createRuntimeFixture();
  const bot = fixture.store.createBot({ name: 'Scream', workspace });
  const thread = fixture.store.createThread(bot.id);
  return { ...fixture, bot, thread };
}

describe('normalizePermission', () => {
  it('maps every legacy value onto the safe tier and keeps only auto', () => {
    for (const legacy of ['ask', 'workspace', 'read', 'yolo', 'manual', '', undefined]) {
      expect(normalizePermission(legacy)).toBe('bot');
    }
    expect(normalizePermission('bot')).toBe('bot');
    expect(normalizePermission('auto')).toBe('auto');
  });
});

describe('BotRuntime run lifecycle', () => {
  it('returns a run id immediately, then drives running → done through turn events', async () => {
    const fixture = setup();
    const result = fixture.runtime.prompt(fixture.thread.id, { text: 'hello' });
    expect(result.status).toBe('queued');
    expect(fixture.store.getRun(result.runId)?.status).toBe('queued');

    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['hello']);
    });
    expect(fixture.store.getRun(result.runId)?.status).toBe('running');
    expect(fixture.store.getRun(result.runId)?.startedAt).not.toBeNull();

    fixture.factory.sessionFor(fixture.thread.id).complete('hi there');
    await vi.waitFor(() => {
      expect(fixture.store.getRun(result.runId)?.status).toBe('done');
    });
    expect(fixture.store.getRun(result.runId)?.endedAt).not.toBeNull();

    const messages = await fixture.runtime.hydrate(fixture.thread.id);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages.map((message) => message.content)).toEqual(['hello', 'hi there']);
  });

  it('queues a second prompt behind the active run on the same thread', async () => {
    const fixture = setup();
    const first = fixture.runtime.prompt(fixture.thread.id, { text: 'one' });
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['one']);
    });
    const second = fixture.runtime.prompt(fixture.thread.id, { text: 'two' });

    expect(second.runId).not.toBe(first.runId);
    expect(fixture.store.getRun(second.runId)?.status).toBe('queued');
    expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['one']);

    fixture.factory.sessionFor(fixture.thread.id).complete('first answer');
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['one', 'two']);
    });
    expect(fixture.store.getRun(first.runId)?.status).toBe('done');
    expect(fixture.store.getRun(second.runId)?.status).toBe('running');

    fixture.factory.sessionFor(fixture.thread.id).complete('second answer');
    await vi.waitFor(() => {
      expect(fixture.store.getRun(second.runId)?.status).toBe('done');
    });
  });

  it('steers into the live run instead of creating a new one', async () => {    const fixture = setup();
    const first = fixture.runtime.prompt(fixture.thread.id, { text: 'plan' });
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['plan']);
    });

    const steered = fixture.runtime.prompt(fixture.thread.id, { text: 'also do X', mode: 'steer' });
    expect(steered.runId).toBe(first.runId);
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).steers).toEqual(['also do X']);
    });
    expect(fixture.store.listRunsForThread(fixture.thread.id)).toHaveLength(1);
  });

  it('cancels the live run and expires its pending inbox items on interrupt', async () => {
    const fixture = setup();
    const result = fixture.runtime.prompt(fixture.thread.id, { text: 'work' });
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['work']);
    });

    const session = fixture.factory.sessionFor(fixture.thread.id);
    const decision = session.requestApproval(approvalRequest());
    await vi.waitFor(() => {
      expect(fixture.store.listApprovals({ pendingOnly: true })).toHaveLength(1);
    });

    const run = await fixture.runtime.interrupt(fixture.thread.id);
    expect(run?.status).toBe('cancelled');
    expect(session.cancelCount).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'cancelled' });
    expect(fixture.store.listApprovals({ pendingOnly: true })).toHaveLength(0);
    expect(fixture.store.getRun(result.runId)?.status).toBe('cancelled');
  });

  it('marks in-flight runs and inbox rows from a previous process as dead', async () => {
    const fixture = setup();
    const run = fixture.store.createRun({ botId: fixture.bot.id, threadId: fixture.thread.id });
    fixture.store.updateRunStatus(run.id, 'waiting_user');
    fixture.store.createApproval({
      botId: fixture.bot.id,
      threadId: fixture.thread.id,
      runId: run.id,
      requestId: 'old',
      toolName: 'Bash',
      action: 'run',
      reasons: [],
      grantOptions: ['once'],
      expiresAt: Date.now() + 60_000,
    });
    fixture.store.createQuestion({
      botId: fixture.bot.id,
      threadId: fixture.thread.id,
      runId: run.id,
      requestId: 'old_q',
      items: [
        { id: '0', question: 'Pick', options: [{ label: 'a' }], multiple: false, allowOther: false },
      ],
      expiresAt: Date.now() + 60_000,
    });

    const recovery = fixture.runtime.start();
    expect(recovery.orphanRuns).toBe(1);
    expect(recovery.expiredApprovals).toBe(1);
    expect(recovery.expiredQuestions).toBe(1);
    expect(fixture.store.getRun(run.id)?.status).toBe('interrupted');
    expect(fixture.store.listApprovals()[0]?.status).toBe('expired');
    expect(fixture.store.listQuestions()[0]?.status).toBe('expired');
  });

  it('rejects prompts for paused bots and unknown threads', async () => {
    const fixture = setup();
    fixture.store.setBotPaused(fixture.bot.id, true);
    expect(() => fixture.runtime.prompt(fixture.thread.id, { text: 'hi' })).toThrow(RuntimeError);
    try {
      fixture.runtime.prompt(fixture.thread.id, { text: 'hi' });
    } catch (error) {
      expect((error as RuntimeError).code).toBe('bot.paused');
      expect((error as RuntimeError).statusCode).toBe(409);
    }
    expect(() => fixture.runtime.prompt('th_missing', { text: 'hi' })).toThrow(/Thread not found/);
  });

  it('records a failed run and keeps the error on the row', async () => {
    const fixture = setup();
    const result = fixture.runtime.prompt(fixture.thread.id, { text: 'boom' });
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['boom']);
    });
    fixture.factory.sessionFor(fixture.thread.id).fail(new Error('provider exploded'));
    await vi.waitFor(() => {
      expect(fixture.store.getRun(result.runId)?.status).toBe('failed');
    });
    expect(fixture.store.getRun(result.runId)?.error).toBe('provider exploded');
  });

  it('runs two bots concurrently without cross-talk', async () => {
    const fixture = createRuntimeFixture();
    const botA = fixture.store.createBot({ name: 'A', workspace: process.cwd() });
    const botB = fixture.store.createBot({ name: 'B', workspace: process.cwd() });
    const threadA = fixture.store.createThread(botA.id);
    const threadB = fixture.store.createThread(botB.id);

    const runA = fixture.runtime.prompt(threadA.id, { text: 'a' });
    const runB = fixture.runtime.prompt(threadB.id, { text: 'b' });
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(threadA.id).prompts).toEqual(['a']);
      expect(fixture.factory.sessionFor(threadB.id).prompts).toEqual(['b']);
    });

    fixture.factory.sessionFor(threadA.id).complete('A done');
    await vi.waitFor(() => {
      expect(fixture.store.getRun(runA.runId)?.status).toBe('done');
    });
    expect(fixture.store.getRun(runB.runId)?.status).toBe('running');

    fixture.factory.sessionFor(threadB.id).complete('B done');
    await vi.waitFor(() => {
      expect(fixture.store.getRun(runB.runId)?.status).toBe('done');
    });
  });
});

describe('BotRuntime thread deletion', () => {
  it('replaces the last conversation with one fresh empty thread before resolving', async () => {
    const fixture = setup();
    expect(await fixture.runtime.deleteThread(fixture.thread.id)).toBe(true);

    const remaining = fixture.store.listThreads(fixture.bot.id);
    expect(remaining).toHaveLength(1);
    const fresh = remaining[0]!;
    expect(fresh.id).not.toBe(fixture.thread.id);
    expect(fresh).toMatchObject({ coreSessionId: null, archivedAt: null, unread: 0 });
    expect(fixture.store.getThread(fixture.thread.id)).toBeUndefined();
    expect(await fixture.runtime.hydrate(fresh.id)).toEqual([]);
    expect(fixture.factory.openCalls).toEqual([]);
    // Repeated requests must not accumulate replacement conversations.
    expect(await fixture.runtime.deleteThread(fixture.thread.id)).toBe(false);
    expect(fixture.store.listThreads(fixture.bot.id)).toEqual(remaining);
  });

  it('keeps an existing conversation rather than creating an extra replacement', async () => {
    const fixture = setup();
    const sibling = fixture.store.createThread(fixture.bot.id, { title: 'Keep me' });
    expect(await fixture.runtime.deleteThread(fixture.thread.id)).toBe(true);
    expect(fixture.store.listThreads(fixture.bot.id)).toEqual([sibling]);
  });

  it('does not count archived conversations as a usable landing thread', async () => {
    const fixture = setup();
    const archived = fixture.store.createThread(fixture.bot.id);
    fixture.store.updateThread(archived.id, { archivedAt: Date.now() });

    expect(await fixture.runtime.deleteThread(fixture.thread.id)).toBe(true);
    expect(fixture.store.listThreads(fixture.bot.id)).toHaveLength(1);
    expect(fixture.store.listThreads(fixture.bot.id)[0]?.archivedAt).toBeNull();
    expect(fixture.store.listThreads(fixture.bot.id, { includeArchived: true })).toHaveLength(2);
  });

  it('does not recreate conversations for a Bot deleted during session cleanup', async () => {
    const fixture = setup();
    fixture.runtime.prompt(fixture.thread.id, { text: 'work' });
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['work']);
    });
    const session = fixture.factory.sessionFor(fixture.thread.id);
    vi.spyOn(session, 'close').mockImplementation(async () => {
      fixture.store.deleteBot(fixture.bot.id);
    });

    expect(await fixture.runtime.deleteThread(fixture.thread.id)).toBe(false);
    expect(fixture.store.getBot(fixture.bot.id)).toBeUndefined();
    expect(fixture.store.listThreads(fixture.bot.id, { includeArchived: true })).toEqual([]);
  });

  it('leaves one ordinary conversation per surviving Bot after room cleanup', async () => {
    const fixture = roomFixture();
    for (const botId of [fixture.tony.id, fixture.vera.id]) {
      const thread = fixture.store.createThread(botId);
      fixture.store.setRoomThread(fixture.room.id, botId, thread.id);
    }

    expect(await fixture.runtime.deleteRoom(fixture.room.id)).toBe(true);
    expect(fixture.store.getRoom(fixture.room.id)).toBeUndefined();
    for (const botId of [fixture.tony.id, fixture.vera.id]) {
      const threads = fixture.store.listThreads(botId);
      expect(threads).toHaveLength(1);
      expect(fixture.store.getRoomThreadByThreadId(threads[0]!.id)).toBeUndefined();
    }
    expect(await fixture.runtime.deleteRoom(fixture.room.id)).toBe(false);
    expect(fixture.store.listThreads(fixture.tony.id)).toHaveLength(1);
    expect(fixture.store.listThreads(fixture.vera.id)).toHaveLength(1);
  });
});

describe('BotRuntime hydration', () => {
  it('projects core history, including tool results', async () => {
    const fixture = setup();
    const toolCallId = 'call_read_1';
    const session = new FakeSession('core_hist', [
      contextMessage('user', 'read the file', { id: 'm1' }),
      contextMessage('assistant', '', {
        id: 'm2',
        toolCalls: [
          { type: 'function', id: toolCallId, name: 'Read', arguments: '{"path":"a.ts"}' },
        ],
      }),
      contextMessage('tool', 'file contents', { id: 'm3', toolCallId }),
      contextMessage('assistant', 'done', { id: 'm4' }),
    ]);
    fixture.factory.sessions.set(fixture.thread.id, session);
    fixture.store.updateThread(fixture.thread.id, { coreSessionId: 'core_hist' });

    const messages = await fixture.runtime.hydrate(fixture.thread.id);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'read the file' });
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({
      id: toolCallId,
      name: 'Read',
      status: 'done',
      output: 'file contents',
      args: { path: 'a.ts' },
    });
    expect(messages[2]).toMatchObject({ role: 'assistant', content: 'done' });
  });

  it('returns the live cache while a run is active', async () => {
    const fixture = setup();
    fixture.runtime.prompt(fixture.thread.id, { text: 'live' });
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(fixture.thread.id).prompts).toEqual(['live']);
    });
    const messages = await fixture.runtime.hydrate(fixture.thread.id);
    expect(messages.map((message) => message.content)).toEqual(['live']);
  });
});

function message(id: string, content: string, role: Message['role'] = 'assistant'): Message {
  return {
    id,
    threadId: 'th_test',
    role,
    content,
    createdAt: id.startsWith('hist_') ? 0 : 1_000,
  };
}

describe('mergeMessages', () => {
  it('treats an identical stable id as the same message', () => {
    const merged = mergeMessages([message('msg_1', 'hello')], [message('msg_1', 'hello')]);
    expect(merged.map((entry) => entry.id)).toEqual(['msg_1']);
  });

  it('keeps two messages that share content but not identity', () => {
    const merged = mergeMessages([message('msg_1', 'same')], [message('msg_2', 'same')]);
    expect(merged.map((entry) => entry.id)).toEqual(['msg_1', 'msg_2']);
  });

  it('never treats equal text as identity even with legacy positional IDs', () => {
    const merged = mergeMessages([message('hist_0', 'same')], [message('msg_live', 'same')]);
    expect(merged.map((entry) => entry.id)).toEqual(['hist_0','msg_live']);
  });

  it('requires explicit core alias mapping instead of deduplicating live echoes by text', () => {
    // Core mints `m<n>` when a message enters history; the live cache minted
    // `msg_*` for the very same prompt, so only content can link the two.
    const merged = mergeMessages(
      [message('m1', 'hello', 'user')],
      [message('msg_live', 'hello', 'user')],
    );
    expect(merged.map((entry) => entry.id)).toEqual(['m1','msg_live']);
  });
});

interface RoomFixture extends RuntimeFixture {
  readonly tony: BotRecord;
  readonly vera: BotRecord;
  readonly room: RoomRecord;
}

function roomFixture(): RoomFixture {
  const fixture = createRuntimeFixture();
  const tony = fixture.store.createBot({ name: 'Tony', workspace: process.cwd() });
  const vera = fixture.store.createBot({ name: 'Vera', workspace: process.cwd() });
  const room = fixture.store.createRoom({
    name: 'crew',
    memberIds: [tony.id, vera.id],
    leadBotId: tony.id,
  });
  return { ...fixture, tony, vera, room };
}

function roomThread(fixture: RoomFixture, botId: string): string {
  const threadId = fixture.store.getRoomThread(fixture.room.id, botId);
  if (threadId === undefined) throw new Error(`No room thread for ${botId}`);
  return threadId;
}

describe('BotRuntime promptRoom', () => {
  it('routes an unaddressed message to the lead', async () => {
    const fixture = roomFixture();
    const result = fixture.runtime.promptRoom(fixture.room.id, 'standup time');

    expect(result.runIds).toEqual([result.runId]);
    expect(fixture.store.getRun(result.runId)?.botId).toBe(fixture.tony.id);
    const threadId = roomThread(fixture, fixture.tony.id);
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(threadId).prompts).toEqual(['standup time']);
    });
  });

  it('emits a room delta while the member is still replying', async () => {
    const fixture = roomFixture();
    const events: ServerEvent[] = [];
    const subscription = fixture.hub.subscribe({}, (event) => { events.push(event); });
    await subscription.ready;

    fixture.runtime.promptRoom(fixture.room.id, '@Tony 说说看');
    const threadId = roomThread(fixture, fixture.tony.id);
    await vi.waitFor(() => { expect(fixture.factory.sessionFor(threadId).prompts).toHaveLength(1); });
    fixture.factory.sessionFor(threadId).delta('先说半句');

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'room.delta')).toBe(true);
    });
    const delta = events.find((event) => event.type === 'room.delta');
    expect(delta?.roomId).toBe(fixture.room.id);
    expect(delta?.data).toMatchObject({ botId: fixture.tony.id, content: '先说半句' });
    subscription.unsubscribe();
  });

  it('gives the next Bot the shared room transcript', async () => {
    const fixture = roomFixture();
    fixture.store.appendRoomMessage({
      roomId: fixture.room.id,
      speakerKind: 'bot',
      speakerId: fixture.tony.id,
      content: 'The parser lives in runtime.ts.',
      via: 'direct',
    });

    const result = fixture.runtime.promptRoom(fixture.room.id, '@Vera what do you think?');
    const threadId = roomThread(fixture, fixture.vera.id);
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(threadId).prompts[0]).toContain('Shared conversation in #');
    });
    const envelope = fixture.factory.sessionFor(threadId).prompts[0] ?? '';
    expect(envelope).toContain(`Tony: The parser lives in runtime.ts.`);
    expect(envelope).toContain('New message from person:\n@Vera what do you think?');
    expect(fixture.store.getRun(result.runId)?.botId).toBe(fixture.vera.id);
  });

  it('reuses the same room request instead of duplicating member runs', async () => {
    const fixture = roomFixture();
    const first = fixture.runtime.promptRoom(fixture.room.id, '@Tony run once', 'room-key-1');
    const second = fixture.runtime.promptRoom(fixture.room.id, '@Tony run once', 'room-key-1');

    expect(second.roomMessage.id).toBe(first.roomMessage.id);
    expect(second.runIds).toEqual([first.runId]);
    const threadId = roomThread(fixture, fixture.tony.id);
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(threadId).prompts).toHaveLength(1);
    });
  });

  it('rejects a reused request key with different text', () => {
    const fixture = roomFixture();
    fixture.runtime.promptRoom(fixture.room.id, '@Tony first', 'same-key');
    expect(() => fixture.runtime.promptRoom(fixture.room.id, '@Tony second', 'same-key')).toThrow(/different message/);
    expect(fixture.store.listRoomMessages(fixture.room.id)).toHaveLength(1);
  });

  it('matches full names with spaces and ignores email addresses', async () => {
    const fixture = roomFixture();
    fixture.store.updateBot(fixture.tony.id, { name: 'Tony Stark' });

    const mentioned = fixture.runtime.promptRoom(fixture.room.id, '@Tony Stark please review');
    expect(fixture.store.getRun(mentioned.runId)?.botId).toBe(fixture.tony.id);

    const email = fixture.runtime.promptRoom(fixture.room.id, 'write to ops@example.com later');
    // No mention, so the lead answers rather than a non-member.
    expect(fixture.store.getRun(email.runId)?.botId).toBe(fixture.tony.id);
  });

  it('skips paused members and refuses when every addressed Bot is paused', () => {
    const fixture = roomFixture();
    fixture.store.updateBot(fixture.vera.id, { paused: true });
    const routed = fixture.runtime.promptRoom(fixture.room.id, '@Tony @Vera status');
    expect(routed.runIds).toHaveLength(1);
    expect(fixture.store.getRun(routed.runId)?.botId).toBe(fixture.tony.id);

    const before = fixture.store.listRoomMessages(fixture.room.id).length;
    fixture.store.updateBot(fixture.tony.id, { paused: true });
    expect(() => fixture.runtime.promptRoom(fixture.room.id, '@Tony @Vera again')).toThrow(/paused/);
    expect(fixture.store.listRoomMessages(fixture.room.id)).toHaveLength(before);
  });

  it('matches a mention case-insensitively and ignores trailing punctuation', async () => {
    const fixture = roomFixture();
    for (const text of ['@Tony, take a look', '@tony. take a look', '@TONY! take a look']) {
      const result = fixture.runtime.promptRoom(fixture.room.id, text);
      expect(result.runIds).toHaveLength(1);
      expect(fixture.store.getRun(result.runId)?.botId).toBe(fixture.tony.id);
    }
  });

  it('queues one run per mentioned member', async () => {
    const fixture = roomFixture();
    const result = fixture.runtime.promptRoom(fixture.room.id, '@Tony @Vera: please sync');

    expect(result.runIds).toHaveLength(2);
    const bots = result.runIds.map((runId) => fixture.store.getRun(runId)?.botId);
    expect(new Set(bots)).toEqual(new Set([fixture.tony.id, fixture.vera.id]));

    for (const botId of [fixture.tony.id, fixture.vera.id]) {
      const threadId = roomThread(fixture, botId);
      await vi.waitFor(() => {
        expect(fixture.factory.sessionFor(threadId).prompts).toEqual(['@Tony @Vera: please sync']);
      });
    }
  });

  it('collapses a repeated mention into one run', async () => {
    const fixture = roomFixture();
    const result = fixture.runtime.promptRoom(fixture.room.id, '@Tony @tony again');
    expect(result.runIds).toHaveLength(1);
  });

  it('falls back to the lead when no mention matches', async () => {
    const fixture = roomFixture();
    const result = fixture.runtime.promptRoom(fixture.room.id, '@Nobody can you help?');

    expect(result.runIds).toHaveLength(1);
    expect(fixture.store.getRun(result.runId)?.botId).toBe(fixture.tony.id);
  });

  it('still refuses a room without members', () => {
    const fixture = roomFixture();
    const empty = fixture.store.createRoom({ name: 'empty', memberIds: [] });
    expect(() => fixture.runtime.promptRoom(empty.id, 'hello')).toThrow(/no Bots/);
  });

  it('writes one room reply when the run ends', async () => {
    const fixture = roomFixture();
    fixture.runtime.promptRoom(fixture.room.id, '@Vera report');
    const threadId = roomThread(fixture, fixture.vera.id);
    await vi.waitFor(() => {
      expect(fixture.factory.sessionFor(threadId).prompts).toEqual(['@Vera report']);
    });

    fixture.factory.sessionFor(threadId).complete('all green');
    await vi.waitFor(() => {
      const replies = fixture.store
        .listRoomMessages(fixture.room.id)
        .filter((entry) => entry.speakerKind === 'bot');
      expect(replies).toHaveLength(1);
    });
    const reply = fixture.store
      .listRoomMessages(fixture.room.id)
      .find((entry) => entry.speakerKind === 'bot');
    expect(reply).toMatchObject({
      speakerId: fixture.vera.id,
      content: 'all green',
      via: 'direct',
      answeredBy: fixture.vera.id,
    });
  });
});
