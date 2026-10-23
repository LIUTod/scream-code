import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Approval,
  Bot,
  Message,
  Question,
  Room,
  RoomMessage,
  Run,
  Thread,
} from '../../../src/bot/shared/contracts';
import { createGateway } from '../../../src/bot/server/gateway';
import { approvalRequest, createRuntimeFixture, type RuntimeFixture } from './fakes';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scream-bot-gw-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface AppFixture extends RuntimeFixture {
  readonly app: Hono;
}

function createApp(): AppFixture {
  const fixture = createRuntimeFixture();
  const app = createGateway({
    store: fixture.store,
    runtime: fixture.runtime,
    hub: fixture.hub,
  });
  return { ...fixture, app };
}

async function createBot(app: Hono, workspace = tempDir(), name = 'Scream'): Promise<Bot> {
  const response = await app.request('/api/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, workspace }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Bot;
}

async function createThread(app: Hono, botId: string): Promise<Thread> {
  const response = await app.request(`/api/bots/${botId}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Test thread' }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Thread;
}

describe('gateway bots and threads', () => {
  it('serves GET /api/bots as JSON and validates workspaces', async () => {
    const { app } = createApp();
    const empty = await app.request('/api/bots');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const invalid = await app.request('/api/bots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Broken', workspace: join(tempDir(), 'nope') }),
    });
    expect(invalid.status).toBe(400);

    const bot = await createBot(app);
    const listed = (await (await app.request('/api/bots')).json()) as Bot[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: bot.id, name: 'Scream', status: 'idle' });
  });

  it('creates threads, pauses/resumes bots and guards the last bot', async () => {
    const { app, store } = createApp();
    const bot = await createBot(app);
    const thread = await createThread(app, bot.id);

    const threads = (await (await app.request(`/api/bots/${bot.id}/threads`)).json()) as Thread[];
    // A Bot is created with a default conversation; the explicit one is added
    // alongside it.
    expect(threads).toHaveLength(2);
    expect(threads.map((entry) => entry.id)).toContain(thread.id);

    const paused = await app.request(`/api/bots/${bot.id}/pause`, { method: 'POST' });
    expect(((await paused.json()) as Bot).status).toBe('paused');
    await app.request(`/api/bots/${bot.id}/resume`, { method: 'POST' });

    const refused = await app.request(`/api/bots/${bot.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);

    const second = await createBot(app, tempDir(), 'Research');
    expect(store.countBots()).toBe(2);
    const deleted = await app.request(`/api/bots/${bot.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await (await app.request('/api/bots')).json()) as Bot[]).toHaveLength(1);
    await app.request(`/api/bots/${second.id}`, { method: 'DELETE' });
  });

  it('makes a fresh empty conversation available when deleting the last thread', async () => {
    const { app, factory } = createApp();
    const bot = await createBot(app);
    const path = `/api/bots/${bot.id}/threads`;
    const before = (await (await app.request(path)).json()) as Thread[];
    expect(before).toHaveLength(1);
    const deletedId = before[0]!.id;

    const deleted = await app.request(`/api/threads/${deletedId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    const after = (await (await app.request(path)).json()) as Thread[];
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(deletedId);
    expect(after[0]).toMatchObject({ botId: bot.id, runStatus: null, unread: 0, archivedAt: null });
    const messages = await app.request(`/api/threads/${after[0]!.id}/messages`);
    expect(messages.status).toBe(200);
    expect(await messages.json()).toEqual({threadId:after[0]!.id,version:0,epoch:expect.any(String),messages:[]});
    expect(factory.openCalls).toEqual([]);
    expect((await app.request(`/api/threads/${deletedId}/messages`)).status).toBe(404);
  });

  it('stores only the two permission tiers, whatever the client sends', async () => {
    const { app } = createApp();
    const created = async (name: string, permission: string): Promise<Bot> => {
      const response = await app.request('/api/bots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, permission, workspace: tempDir() }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as Bot;
    };

    expect((await created('Safe', 'bot')).permission).toBe('bot');
    expect((await created('Auto', 'auto')).permission).toBe('auto');
    // Legacy values are folded to the safe tier instead of being stored.
    const legacy = await created('Legacy', 'ask');
    expect(legacy.permission).toBe('bot');

    const patched = await app.request(`/api/bots/${legacy.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permission: 'yolo' }),
    });
    expect(((await patched.json()) as Bot).permission).toBe('bot');

    const promoted = await app.request(`/api/bots/${legacy.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permission: 'auto' }),
    });
    expect(((await promoted.json()) as Bot).permission).toBe('auto');

    const rejected = await app.request(`/api/bots/${legacy.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolPolicy: { deny: ['Bash'] } }),
    });
    expect(rejected.status).toBe(400);
  });
});

describe('gateway prompts and runs', () => {
  it('accepts a prompt with 202 and hydrates the transcript', async () => {
    const { app, factory } = createApp();
    const bot = await createBot(app);
    const thread = await createThread(app, bot.id);

    const accepted = await app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello gateway' }),
    });
    expect(accepted.status).toBe(202);
    const { runId } = (await accepted.json()) as { runId: string };
    expect(runId).toMatch(/^run_/);

    const early = (await (
      await app.request(`/api/threads/${thread.id}/messages`)
    ).json()) as {messages:Message[];version:number};
    expect(early.messages.map((message) => message.content)).toEqual(['hello gateway']);

    await vi.waitFor(() => {
      expect(factory.sessionFor(thread.id).prompts).toEqual(['hello gateway']);
    });
    factory.sessionFor(thread.id).complete('hello human');

    await vi.waitFor(async () => {
      await expect(createRunStatus(app, runId)).resolves.toBe('done');
    });

    const messages = (await (
      await app.request(`/api/threads/${thread.id}/messages`)
    ).json() as {messages:Message[];version:number}).messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages.map((message) => message.content)).toEqual([
      'hello gateway',
      'hello human',
    ]);

    const run = (await (await app.request(`/api/runs/${runId}`)).json()) as Run;
    expect(run).toMatchObject({ id: runId, botId: bot.id, threadId: thread.id, status: 'done' });
  });

  it('interrupts the active run over HTTP', async () => {
    const { app, factory } = createApp();
    const bot = await createBot(app);
    const thread = await createThread(app, bot.id);
    const accepted = await app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'long job' }),
    });
    const { runId } = (await accepted.json()) as { runId: string };
    await vi.waitFor(() => {
      expect(factory.sessionFor(thread.id).prompts).toEqual(['long job']);
    });

    const response = await app.request(`/api/threads/${thread.id}/interrupt`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: Run | null };
    expect(body.run?.status).toBe('cancelled');
    expect(factory.sessionFor(thread.id).cancelCount).toBe(1);
    await expect(createRunStatus(app, runId)).resolves.toBe('cancelled');
  });

  it('lists runs by bot and thread through GET /api/runs', async () => {
    const { app, factory } = createApp();
    const bot = await createBot(app);
    const thread = await createThread(app, bot.id);
    const accepted = await app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'activity run' }),
    });
    const { runId } = (await accepted.json()) as { runId: string };
    await vi.waitFor(() => {
      expect(factory.sessionFor(thread.id).prompts).toEqual(['activity run']);
    });
    factory.sessionFor(thread.id).complete('finished');
    await vi.waitFor(async () => {
      await expect(createRunStatus(app, runId)).resolves.toBe('done');
    });

    const listed = (await (await app.request(`/api/runs?botId=${bot.id}`)).json()) as Run[];
    expect(listed.map((run) => run.id)).toEqual([runId]);
    expect(listed[0]).toMatchObject({ botId: bot.id, threadId: thread.id, status: 'done' });

    const scoped = (await (
      await app.request(`/api/runs?threadId=${thread.id}&limit=1`)
    ).json()) as Run[];
    expect(scoped.map((run) => run.id)).toEqual([runId]);

    const other = await createBot(app, tempDir(), 'Other');
    expect(await (await app.request(`/api/runs?botId=${other.id}`)).json()).toEqual([]);
  });

  it('returns 404 for unknown threads and 400 for empty text', async () => {
    const { app } = createApp();
    const bot = await createBot(app);
    const thread = await createThread(app, bot.id);

    const missing = await app.request('/api/threads/th_missing/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(missing.status).toBe(404);

    const empty = await app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(empty.status).toBe(400);
  });
});

async function createRunStatus(app: Hono, runId: string): Promise<string> {
  const response = await app.request(`/api/runs/${runId}`);
  const run = (await response.json()) as Run;
  return run.status;
}

describe('gateway inbox', () => {
  it('lists pending approvals/questions and applies decisions', async () => {
    const { app, factory, store } = createApp();
    const bot = await createBot(app);
    const thread = await createThread(app, bot.id);
    await app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'needs permission' }),
    });
    await vi.waitFor(() => {
      expect(factory.sessionFor(thread.id).prompts).toEqual(['needs permission']);
    });

    const session = factory.sessionFor(thread.id);
    const decision = session.requestApproval(approvalRequest({ toolCallId: 'call_http' }));
    await vi.waitFor(() => {
      expect(store.listApprovals({ pendingOnly: true })).toHaveLength(1);
    });

    const inbox = (await (await app.request('/api/inbox')).json()) as {
      approvals: Approval[];
      questions: Question[];
    };
    expect(inbox.approvals).toHaveLength(1);
    expect(inbox.questions).toHaveLength(0);
    expect(inbox.approvals[0]?.status).toBe('pending');

    const invalid = await app.request(`/api/approvals/${inbox.approvals[0]!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(invalid.status).toBe(400);

    const approved = await app.request(`/api/approvals/${inbox.approvals[0]!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow_once' }),
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as Approval).status).toBe('approved');
    await expect(decision).resolves.toEqual({ decision: 'approved' });
    expect(store.listApprovals({ pendingOnly: true })).toHaveLength(0);
  });

  it('answers questions and rejects malformed payloads', async () => {
    const { app, factory, store } = createApp();
    const bot = await createBot(app);
    const thread = await createThread(app, bot.id);
    await app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask me' }),
    });
    await vi.waitFor(() => {
      expect(factory.sessionFor(thread.id).prompts).toEqual(['ask me']);
    });
    const session = factory.sessionFor(thread.id);
    const answer = session.requestQuestion({
      questions: [
        { question: 'Target?', options: [{ label: 'staging' }, { label: 'prod' }] },
      ],
    });
    await vi.waitFor(() => {
      expect(store.listQuestions({ pendingOnly: true })).toHaveLength(1);
    });
    const row = store.listQuestions({ pendingOnly: true })[0]!;

    const malformed = await app.request(`/api/questions/${row.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: 'staging' }),
    });
    expect(malformed.status).toBe(400);

    const answered = await app.request(`/api/questions/${row.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { '0': 'staging' } }),
    });
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as Question).status).toBe('answered');
    await expect(answer).resolves.toEqual({ answers: { 'Target?': 'staging' } });
  });
});

describe('gateway rooms', () => {
  it('queues every mentioned member and keeps the message read pure', async () => {
    const { app, factory, store } = createApp();
    const tony = await createBot(app, tempDir(), 'Tony');
    const vera = await createBot(app, tempDir(), 'Vera');
    const created = await app.request('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'crew', memberIds: [tony.id, vera.id], leadBotId: tony.id }),
    });
    expect(created.status).toBe(201);
    const room = (await created.json()) as Room;

    const posted = await app.request(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '@Tony @Vera: sync up' }),
    });
    expect(posted.status).toBe(202);
    const body = (await posted.json()) as { runId: string; runIds: string[] };
    expect(body.runIds).toHaveLength(2);
    expect(body.runId).toBe(body.runIds[0]);

    const threads = [tony.id, vera.id].map((botId) => {
      const threadId = store.getRoomThread(room.id, botId);
      expect(threadId).toBeDefined();
      return threadId!;
    });
    await vi.waitFor(() => {
      for (const threadId of threads) {
        expect(factory.sessionFor(threadId).prompts).toEqual(['@Tony @Vera: sync up']);
      }
    });
    factory.sessionFor(threads[0]!).complete('tony here');
    factory.sessionFor(threads[1]!).complete('vera here');
    await vi.waitFor(() => {
      expect(store.listRoomMessages(room.id).filter((row) => row.speakerKind === 'bot')).toHaveLength(2);
    });

    const read = async (): Promise<{ messages: RoomMessage[]; runs: Run[] }> =>
      (await (await app.request(`/api/rooms/${room.id}/messages`)).json()) as { messages: RoomMessage[]; runs: Run[] };
    const first = await read();
    const second = await read();
    expect(first.messages.filter((row) => row.speakerKind === 'bot')).toHaveLength(2);
    expect(first.runs).toHaveLength(2);
    // A GET is a pure read: it can never append a reply.
    expect(second.messages).toHaveLength(first.messages.length);
    const replies = first.messages.filter((row) => row.speakerKind === 'bot');
    expect(new Set(replies.map((row) => row.answeredBy))).toEqual(new Set([tony.id, vera.id]));
  });
});

describe('gateway files', () => {
  it('lists, reads and writes inside the bot workspace only', async () => {
    const workspace = tempDir();
    writeFileSync(join(workspace, 'notes.md'), '# notes', 'utf-8');
    const { app } = createApp();
    const bot = await createBot(app, workspace);

    const listing = (await (
      await app.request(`/api/bots/${bot.id}/files?path=`)
    ).json()) as { path: string; entries: { name: string }[] };
    expect(listing.entries.map((entry) => entry.name)).toContain('notes.md');

    const read = (await (
      await app.request(`/api/bots/${bot.id}/files?path=notes.md`)
    ).json()) as { content: string };
    expect(read.content).toBe('# notes');

    const written = await app.request(`/api/bots/${bot.id}/files?path=new.txt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(written.status).toBe(200);
    expect(((await written.json()) as { bytes: number }).bytes).toBe(5);

    const escaped = await app.request(`/api/bots/${bot.id}/files?path=../outside.txt`);
    expect(escaped.status).toBe(403);

    const otherWorkspace = tempDir();
    const other = await createBot(app, otherWorkspace, 'Other');
    const crossRead = await app.request(
      `/api/bots/${other.id}/files?path=${encodeURIComponent(join(workspace, 'notes.md'))}`,
    );
    expect(crossRead.status).toBe(403);
  });
});

describe('gateway misc', () => {
  it('returns a JSON 404 for unknown API routes', async () => {
    const { app } = createApp();
    const response = await app.request('/api/nope');
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('lists rooms', async () => {
    const { app } = createApp();
    const response = await app.request('/api/rooms');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('streams a snapshot first on /api/events', async () => {
    const { app } = createApp();
    const bot = await createBot(app);
    const controller = new AbortController();
    const response = await app.request(`/api/events?botId=${bot.id}`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await Promise.race([
      reader!.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('SSE snapshot timed out'));
        }, 2_000);
      }),
    ]);
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain('event: snapshot');
    expect(text).toContain(bot.id);
    controller.abort();
    await reader!.cancel().catch(() => {});
  });
});

describe('gateway recovery protocol', () => {
  it('records idempotent recovery decisions without rewriting the interrupted run', async () => {
    const f = createApp();
    const bot = await createBot(f.app);
    const thread = await createThread(f.app,bot.id);
    f.store.setBotPaused(bot.id,true);
    const unknown = f.store.createRun({botId:bot.id,threadId:thread.id,text:'unknown outcome'});
    f.store.markDispatch(unknown.id,'old','generation');
    f.store.markOrphanRuns();
    const decide = () => f.app.request(`/api/runs/${unknown.id}/recovery`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'retry'}),
    });
    const first = await decide();
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {run:Run;retryRun:Run};
    const second = await decide();
    expect(await second.json()).toEqual(firstBody);
    expect(firstBody.run.status).toBe('interrupted');
    expect(firstBody.retryRun.retryOfRunId).toBe(unknown.id);
    const cancel = await f.app.request(`/api/runs/${firstBody.retryRun.id}/cancel`,{method:'POST'});
    expect(cancel.status).toBe(200);
    expect((await cancel.json() as Run).status).toBe('cancelled');
    await f.runtime.close();
  });

  it('rejects nonempty attachments instead of accepting an incomplete prompt', async () => {
    const f = createApp();
    const bot = await createBot(f.app);
    const thread = await createThread(f.app,bot.id);
    const response = await f.app.request(`/api/threads/${thread.id}/messages`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'read it',attachments:['file.txt']}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:{code:'attachments.unsupported'}});
    expect(f.store.listRunsForThread(thread.id)).toEqual([]);
    await f.runtime.close();
  });
});

describe('gateway fixed thread workspace', () => {
  it('passes threadId to file reads, listings and writes after the Bot default changes', async () => {
    const f = createApp();
    const original = tempDir();
    const next = tempDir();
    const bot = await createBot(f.app,original);
    const thread = await createThread(f.app,bot.id);
    writeFileSync(join(original,'old.txt'),'old workspace');
    f.store.updateBot(bot.id,{workspace:next});
    const root = await f.app.request(`/api/bots/${bot.id}/files?threadId=${thread.id}`);
    expect(await root.json()).toMatchObject({path:original,entries:[{name:'old.txt'}]});
    const read = await f.app.request(`/api/bots/${bot.id}/files?threadId=${thread.id}&path=old.txt`);
    expect(await read.json()).toMatchObject({path:join(original,'old.txt'),content:'old workspace'});
    const write = await f.app.request(`/api/bots/${bot.id}/files?threadId=${thread.id}&path=new.txt`,{
      method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:'new'}),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({path:join(original,'new.txt')});
    const defaultRoot = await f.app.request(`/api/bots/${bot.id}/files`);
    expect(await defaultRoot.json()).toEqual({path:next,entries:[]});
    await f.runtime.close();
  });
});
