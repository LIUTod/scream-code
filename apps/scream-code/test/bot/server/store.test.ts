import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { BotStore } from '../../../src/bot/server/store';

const dirs: string[] = [];
const stores: BotStore[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scream-bot-store-'));
  dirs.push(dir);
  return join(dir, 'bot.db');
}

function open(path: string): BotStore {
  const store = new BotStore(path);
  store.open();
  stores.push(store);
  return store;
}

function bot(store: BotStore, name = 'Scream'): string {
  return store.createBot({ name, workspace: process.cwd() }).id;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('BotStore schema', () => {
  it('creates every table and survives reopening with rows intact', () => {
    const path = tempDbPath();
    const store = open(path);
    const botId = bot(store);
    const thread = store.createThread(botId, { title: 'hello' });
    store.close();

    const reopened = open(path);
    expect(reopened.getBot(botId)?.name).toBe('Scream');
    expect(reopened.getThread(thread.id)?.title).toBe('hello');

    const db = new DatabaseSync(path, { readOnly: true });
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        readonly name: string;
      }[]
    ).map((row) => row.name);
    db.close();

    for (const table of [
      'bots',
      'threads',
      'runs',
      'approvals',
      'questions',
      'handoffs',
      'rooms',
      'room_members',
      'room_messages',
      'room_threads',
      'audit',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('is idempotent when opened twice on the same handle', () => {
    const path = tempDbPath();
    const store = open(path);
    store.open();
    expect(store.countBots()).toBe(0);
  });
});

describe('BotStore bots', () => {
  it('creates, updates, pauses and derives status from live runs', () => {
    const store = open(':memory:');
    const created = store.createBot({
      name: 'Research',
      title: 'Analyst',
      rolePrompt: 'You research.',
      workspace: process.cwd(),
      model: 'm1',
      permission: 'bot',
      toolPolicy: { allow: ['Read'], handoff: true },
    });
    expect(created.model).toBe('m1');
    expect(created.toolPolicy.handoff).toBe(true);
    // Runtime/API lifecycle owns default conversations, not store fixtures.
    expect(store.listThreads(created.id)).toEqual([]);

    const updated = store.updateBot(created.id, { name: 'Research 2', paused: true });
    expect(updated?.name).toBe('Research 2');
    expect(updated?.paused).toBe(true);
    expect(store.statusForBot(updated!, { unread: 0, needsYou: 2 })).toBe('paused');

    const resumed = store.setBotPaused(created.id, false);
    expect(resumed?.paused).toBe(false);
    expect(store.statusForBot(resumed!, { unread: 0, needsYou: 1 })).toBe('needs_you');

    const thread = store.createThread(created.id);
    const run = store.createRun({ botId: created.id, threadId: thread.id });
    store.updateRunStatus(run.id, 'running');
    expect(store.statusForBot(resumed!, { unread: 0, needsYou: 0 })).toBe('working');
    store.updateRunStatus(run.id, 'done');
    expect(store.statusForBot(resumed!, { unread: 0, needsYou: 0 })).toBe('idle');
  });

  it('defaults new bots to the safe tier', () => {
    const store = open(':memory:');
    expect(store.createBot({ name: 'Safe', workspace: process.cwd() }).permission).toBe('bot');
    expect(
      store.createBot({ name: 'Auto', workspace: process.cwd(), permission: 'auto' }).permission,
    ).toBe('auto');
  });

  it('folds legacy permission values onto the two tiers on open', () => {
    const path = tempDbPath();
    const store = open(path);
    const legacy = ['yolo', 'ask', 'workspace', 'read', 'manual'];
    const ids = legacy.map(
      (_, index) => store.createBot({ name: `Legacy ${String(index)}`, workspace: process.cwd() }).id,
    );
    store.close();

    // Rewrite rows exactly as an older build would have stored them.
    const db = new DatabaseSync(path);
    ids.forEach((id, index) => {
      db.prepare('UPDATE bots SET permission = ? WHERE id = ?').run(legacy[index] ?? 'bot', id);
    });
    db.close();

    const reopened = open(path);
    expect(reopened.getBot(ids[0]!)?.permission).toBe('auto');
    for (const id of ids.slice(1)) {
      expect(reopened.getBot(id)?.permission).toBe('bot');
    }
  });

  it('cascades bot deletion through threads, runs and inbox rows', () => {
    const store = open(':memory:');
    const botId = bot(store);
    const thread = store.createThread(botId);
    const run = store.createRun({ botId, threadId: thread.id });
    store.createApproval({
      botId,
      threadId: thread.id,
      runId: run.id,
      requestId: 'r1',
      toolName: 'Bash',
      action: 'x',
      reasons: [],
      grantOptions: ['once'],
      expiresAt: Date.now() + 1000,
    });

    expect(store.deleteBot(botId)).toBe(true);
    expect(store.getBot(botId)).toBeUndefined();
    expect(store.getThread(thread.id)).toBeUndefined();
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.listApprovals()).toHaveLength(0);
  });

  it('removes a deleted Bot from rooms and clears its lead role', () => {
    const store = open(tempDbPath());
    const first = store.createBot({ name: 'First', workspace: '/tmp' });
    const second = store.createBot({ name: 'Second', workspace: '/tmp' });
    const room = store.createRoom({ name: 'Room', memberIds: [first.id, second.id], leadBotId: first.id });
    store.createThread(first.id); // ensure room threads can reference a real thread

    store.deleteBot(first.id);

    const afterRoom = store.getRoom(room.id);
    expect(afterRoom?.memberIds).toEqual([second.id]);
    expect(afterRoom?.leadBotId).toBeNull();
    expect(store.listRoomThreads(room.id)).toHaveLength(0);
  });
});

describe('BotStore runs', () => {
  it('lists runs newest-first with optional bot, thread and limit filters', () => {
    const store = open(':memory:');
    const botA = bot(store, 'A');
    const botB = bot(store, 'B');
    const threadA = store.createThread(botA);
    const threadA2 = store.createThread(botA);
    const threadB = store.createThread(botB);
    const first = store.createRun({ botId: botA, threadId: threadA.id });
    const second = store.createRun({ botId: botA, threadId: threadA2.id });
    const third = store.createRun({ botId: botB, threadId: threadB.id });

    expect(store.listRuns().map((run) => run.id)).toEqual([third.id, second.id, first.id]);
    expect(store.listRuns({ botId: botA }).map((run) => run.id)).toEqual([second.id, first.id]);
    expect(store.listRuns({ threadId: threadA.id }).map((run) => run.id)).toEqual([first.id]);
    expect(store.listRuns({ botId: botB, threadId: threadA.id })).toEqual([]);
    expect(store.listRuns({ limit: 1 }).map((run) => run.id)).toEqual([third.id]);
    // The cap is 200, so an absurd limit still returns every existing row.
    expect(store.listRuns({ limit: 5_000 })).toHaveLength(3);
  });

  it('tracks the single active run per thread and marks orphans on restart', () => {
    const store = open(':memory:');
    const botId = bot(store);
    const thread = store.createThread(botId);
    const first = store.createRun({ botId, threadId: thread.id });
    expect(store.activeRunForThread(thread.id)?.id).toBe(first.id);

    store.updateRunStatus(first.id, 'running');
    expect(store.getRun(first.id)?.startedAt).not.toBeNull();

    const second = store.createRun({ botId, threadId: thread.id, parentRunId: first.id });
    expect(store.activeRunForThread(thread.id)?.id).toBe(first.id);
    expect(store.getRun(second.id)?.parentRunId).toBe(first.id);

    const marked = store.markOrphanRuns();
    expect(marked).toBe(2);
    expect(store.getRun(first.id)?.status).toBe('interrupted');
    expect(store.getRun(first.id)?.error).toBe('server restarted; execution outcome unknown');
    expect(store.getRun(first.id)?.endedAt).not.toBeNull();
    expect(store.activeRunForThread(thread.id)).toBeUndefined();
  });
});

describe('BotStore room messages', () => {
  it('persists the answerer and collapses a replayed source message', () => {
    const store = open(':memory:');
    const botId = bot(store);
    const room = store.createRoom({ name: 'crew', memberIds: [botId] });
    const input = {
      roomId: room.id,
      speakerKind: 'bot' as const,
      speakerId: botId,
      content: 'on it',
      via: 'direct' as const,
      answeredBy: botId,
      sourceMessageId: 'msg_1',
    };

    const first = store.appendRoomMessage(input);
    const replay = store.appendRoomMessage(input);

    expect(replay.id).toBe(first.id);
    expect(first.answeredBy).toBe(botId);
    expect(store.listRoomMessages(room.id)).toHaveLength(1);
  });

  it('creates the source unique index on a clean database', () => {
    const path = tempDbPath();
    open(path).close();

    const db = new DatabaseSync(path, { readOnly: true });
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'room_messages'")
        .all() as { readonly name: string }[]
    ).map((row) => row.name);
    db.close();

    expect(indexes).toContain('idx_room_messages_source');
  });

  it('still opens a database whose legacy rows duplicate a source message', () => {
    const path = tempDbPath();
    const store = open(path);
    const botId = bot(store);
    const room = store.createRoom({ name: 'crew', memberIds: [botId] });
    store.close();

    const db = new DatabaseSync(path);
    db.exec('DROP INDEX IF EXISTS idx_room_messages_source');
    const insert = db.prepare(
      `INSERT INTO room_messages (id, room_id, speaker_kind, speaker_id, content, via,
        answered_by, source_message_id, created_at)
       VALUES (?, ?, 'bot', ?, 'twice', 'direct', ?, 'msg_dup', 1)`,
    );
    insert.run('rm_legacy_1', room.id, botId, botId);
    insert.run('rm_legacy_2', room.id, botId, botId);
    db.close();

    // The index cannot be built over the duplicates, but startup must survive.
    const reopened = open(path);
    expect(reopened.listRoomMessages(room.id)).toHaveLength(2);
  });
});

describe('BotStore approvals and questions', () => {
  it('decides approvals once and keeps the audit trail', () => {
    const store = open(':memory:');
    const botId = bot(store);
    const thread = store.createThread(botId);
    const run = store.createRun({ botId, threadId: thread.id });
    const approval = store.createApproval({
      botId,
      threadId: thread.id,
      runId: run.id,
      requestId: 'call_1',
      toolName: 'Bash',
      action: 'run',
      reasons: ['risk'],
      grantOptions: ['once', 'session'],
      expiresAt: Date.now() + 60_000,
    });

    expect(store.listApprovals({ pendingOnly: true })).toHaveLength(1);
    const decided = store.decideApproval(approval.id, 'allow_session', 'ok');
    expect(decided?.status).toBe('approved');
    expect(decided?.decision).toBe('allow_session');
    expect(decided?.feedback).toBe('ok');

    // Idempotency: a second decision cannot flip an approved row.
    expect(store.decideApproval(approval.id, 'deny')?.decision).toBe('allow_session');

    const entry = store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'approval.decided',
      decision: 'allow_session',
      botId,
      threadId: thread.id,
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(store.listAudit({ botId })).toHaveLength(1);
  });

  it('expires stale approvals and answered questions', () => {
    const store = open(':memory:');
    const botId = bot(store);
    const thread = store.createThread(botId);
    const approval = store.createApproval({
      botId,
      threadId: thread.id,
      runId: null,
      requestId: 'call_1',
      toolName: 'Bash',
      action: 'run',
      reasons: [],
      grantOptions: ['once'],
      expiresAt: Date.now() - 1,
    });
    expect(store.expireStaleApprovals()).toBe(1);
    expect(store.getApproval(approval.id)?.status).toBe('expired');

    const question = store.createQuestion({
      botId,
      threadId: thread.id,
      runId: null,
      requestId: 'call_q',
      items: [
        {
          id: '0',
          question: 'Pick',
          options: [{ label: 'a' }],
          multiple: false,
          allowOther: false,
        },
      ],
      expiresAt: Date.now() + 60_000,
    });
    const answered = store.answerQuestion(question.id, { '0': 'a' });
    expect(answered?.status).toBe('answered');
    expect(answered?.answers).toEqual({ '0': 'a' });
  });
});
