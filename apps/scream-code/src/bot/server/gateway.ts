/**
 * Bot gateway: REST control plane + SSE stream + static UI.
 *
 * Every write that changes lifecycle goes through `BotRuntime`; the gateway
 * only validates input, reads rows and maps domain errors onto HTTP. There is
 * deliberately no permission decision here — core is the only policy point.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type {
  Approval,
  ApprovalDecision,
  AuditEntry,
  Bot,
  CreateBotInput,
  CreateRoomInput,
  Handoff,
  Question,
  Run,
  Room,
  ServerEvent,
  Thread,
  ToolPolicy,
  UpdateBotInput,
} from '../shared/contracts';
import { type AuthPolicy, createAuthGuard } from './auth';
import { BotFiles, FileAccessError } from './files';
import {
  BotRuntime,
  RuntimeError,
  normalizePermission,
  publicApproval,
  publicBot,
  publicHandoff,
  publicQuestion,
  publicThread,
} from './runtime';
import { type SseHub, eventId } from './sse';
import type { BotStore, RunRecord } from './store';

export interface GatewayOptions {
  readonly store: BotStore;
  readonly runtime: BotRuntime;
  readonly hub: SseHub;
  readonly files?: BotFiles | undefined;
  readonly auth?: AuthPolicy | undefined;
  readonly uiDir?: string | undefined;
}

export interface InboxResponse {
  readonly approvals: readonly Approval[];
  readonly questions: readonly Question[];
  readonly handoffs: readonly Handoff[];
}

export interface SnapshotResponse {
  readonly bots: readonly Bot[];
  readonly threads: readonly Thread[];
  readonly approvals: readonly Approval[];
  readonly questions: readonly Question[];
}

const DECISIONS: readonly ApprovalDecision[] = ['allow_once', 'allow_session', 'deny'];

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function assertToolPolicy(policy: ToolPolicy): void {
  const supported =
    typeof policy === 'object' &&
    policy !== null &&
    !Array.isArray(policy) &&
    Object.keys(policy).every((key) => key === 'allow' || key === 'handoff') &&
    (policy.allow === undefined ||
      (Array.isArray(policy.allow) &&
        policy.allow.every((name) => typeof name === 'string' && name.trim().length > 0))) &&
    (policy.handoff === undefined || typeof policy.handoff === 'boolean');
  if (!supported) {
    throw new RuntimeError(
      'bot.invalid_tool_policy',
      'Only exact tool allow lists and the handoff switch are supported; deny and advanced policies are unsupported',
      400,
    );
  }
}

function badRequest(message: string): RuntimeError {
  return new RuntimeError('request.invalid', message, 400);
}

async function readJson<T>(context: Context): Promise<T> {
  try {
    return (await context.req.json()) as T;
  } catch {
    throw badRequest('Body must be valid JSON');
  }
}

function publicRoom(room: {
  readonly id: string;
  readonly name: string;
  readonly leadBotId: string | null;
  readonly memberIds: readonly string[];
  readonly createdAt: number;
}): Room {
  return {
    id: room.id,
    name: room.name,
    leadBotId: room.leadBotId,
    memberIds: [...room.memberIds],
    createdAt: room.createdAt,
  };
}

/** Wire projection shared by every run endpoint; never invents a start time. */
function runView(run: RunRecord): Run {
  return {
    id: run.id,
    botId: run.botId,
    threadId: run.threadId,
    status: run.status,
    startedAt: run.startedAt ?? run.createdAt,
    endedAt: run.endedAt,
    error: run.error,
    kind:run.kind,origin:run.origin,requestKey:run.requestKey,dispatchStartedAt:run.dispatchStartedAt,
    retryOfRunId:run.retryOfRunId,recoveryDecision:run.recoveryDecision,recoveryAt:run.recoveryAt,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  return value;
}

function expandHome(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

function ensureWorkspace(raw: string): string {
  const workspace = resolve(expandHome(raw));
  let info;
  try {
    info = statSync(workspace);
  } catch {
    throw new RuntimeError('bot.workspace_missing', `Workspace does not exist: ${workspace}`, 400);
  }
  if (!info.isDirectory()) {
    throw new RuntimeError('bot.workspace_invalid', `Workspace is not a directory: ${workspace}`, 400);
  }
  return workspace;
}

export function createGateway(options: GatewayOptions): Hono {
  const { store, runtime, hub } = options;
  const files = options.files ?? new BotFiles(store);
  const app = new Hono();

  app.onError((error, context) => {
    if (error instanceof RuntimeError) {
      return context.json(apiError(error.code, error.message), error.statusCode as ContentfulStatusCode);
    }
    if (error instanceof FileAccessError) {
      return context.json(
        apiError(error.statusCode === 403 ? 'file.forbidden' : 'file.error', error.message),
        error.statusCode as ContentfulStatusCode,
      );
    }
    return context.json(apiError('gateway.error', error.message), 500);
  });

  if (options.auth !== undefined) {
    app.use('/api/*', createAuthGuard(options.auth));
  }
  app.use('/api/*', async (context, next) => {
    await next();
    context.header('Cache-Control', 'no-store');
  });

  const requireBot = (id: string) => {
    const bot = store.getBot(id);
    if (bot === undefined) throw new RuntimeError('bot.not_found', `Bot not found: ${id}`, 404);
    return bot;
  };
  const requireThread = (id: string) => {
    const thread = store.getThread(id);
    if (thread === undefined) throw new RuntimeError('thread.not_found', `Thread not found: ${id}`, 404);
    return thread;
  };

  const snapshot = (botId: string | undefined): SnapshotResponse => {
    const bots = (botId === undefined ? store.listBots() : [requireBot(botId)]).map((bot) =>
      publicBot(store, bot),
    );
    const threads = bots.flatMap((bot) => store.listThreads(bot.id).map((thread) => publicThread(store, thread)));
    const approvals = store
      .listApprovals({ pendingOnly: true, ...(botId === undefined ? {} : { botId }) })
      .map(publicApproval);
    const questions = store
      .listQuestions({ pendingOnly: true, ...(botId === undefined ? {} : { botId }) })
      .map(publicQuestion);
    return { bots, threads, approvals, questions };
  };

  // ------------------------------------------------------------------ meta

  app.get('/api/health', (context) => context.json({ ok: true }));

  // ------------------------------------------------------------------ bots

  app.get('/api/bots', (context) => {
    const bots = store.listBots().map((bot) => publicBot(store, bot));
    return context.json(bots);
  });

  app.get('/api/rooms', (context) => {
    const rooms = store.listRooms().map(publicRoom);
    return context.json(rooms);
  });

  app.post('/api/rooms', async (context) => {
    const body = await readJson<CreateRoomInput>(context);
    const name = requireString(body.name, 'name');
    if (!Array.isArray(body.memberIds) || body.memberIds.length === 0) {
      throw new RuntimeError('room.members_required', 'A room needs at least one Bot', 400);
    }
    const memberIds = body.memberIds.filter((id) => store.getBot(id) !== undefined);
    if (memberIds.length === 0) {
      throw new RuntimeError('room.members_invalid', 'None of those Bots exist', 400);
    }
    const leadBotId =
      body.leadBotId !== undefined && memberIds.includes(body.leadBotId)
        ? body.leadBotId
        : memberIds[0];
    const room = store.createRoom({ name, memberIds, leadBotId });
    return context.json(publicRoom(room), 201);
  });

  app.get('/api/rooms/:id/messages', (context) => {
    const roomId = context.req.param('id');
    if (store.getRoom(roomId) === undefined) {
      throw new RuntimeError('room.not_found', `Room not found: ${roomId}`, 404);
    }
    // Pure read: replies are written when a run ends, never on a GET. Member
    // run states travel with the transcript so the room can show real progress.
    const threads = store.listRoomThreads(roomId);
    const runs = threads
      .flatMap((entry) => store.listRuns({ threadId: entry.threadId, limit: 20 }))
      .toSorted((left, right) => left.createdAt - right.createdAt)
      .slice(-40)
      .map(runView);
    return context.json({ messages: store.listRoomMessages(roomId), runs });
  });

  app.delete('/api/rooms/:id', async (context) => {
    const roomId = context.req.param('id');
    const deleted = await runtime.deleteRoom(roomId);
    if (!deleted) {
      throw new RuntimeError('room.not_found', `Room not found: ${roomId}`, 404);
    }
    return context.body(null, 204);
  });

  app.post('/api/rooms/:id/messages', async (context) => {
    const roomId = context.req.param('id');
    if (store.getRoom(roomId) === undefined) {
      throw new RuntimeError('room.not_found', `Room not found: ${roomId}`, 404);
    }
    const body = await readJson<{ text: string; requestKey?: string }>(context);
    const text = requireString(body.text, 'text');
    const requestKey = typeof body.requestKey === 'string' && body.requestKey.length > 0 ? body.requestKey : undefined;
    try {
      const result = runtime.promptRoom(roomId, text, requestKey);
      return context.json(result, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RuntimeError('room.prompt_failed', message, 400);
    }
  });

  app.post('/api/bots', async (context) => {
    const body = await readJson<CreateBotInput>(context);
    const name = requireString(body.name, 'name');
    const workspace = ensureWorkspace(requireString(body.workspace, 'workspace'));
    if (body.toolPolicy !== undefined) assertToolPolicy(body.toolPolicy);
    const bot = store.createBot({
      name,
      workspace,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.rolePrompt === undefined ? {} : { rolePrompt: body.rolePrompt }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      // The API accepts legacy clients, but only the two tiers can be stored.
      ...(body.permission === undefined ? {} : { permission: normalizePermission(body.permission) }),
      ...(body.toolPolicy === undefined ? {} : { toolPolicy: body.toolPolicy }),
    });
    store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'bot.created',
      decision: 'allowed',
      botId: bot.id,
      payload: { name: bot.name, workspace: bot.workspace },
    });
    // A Bot with no conversation opens on a permanent "Opening a
    // conversation…" placeholder, so the first thread is created with it.
    store.createThread(bot.id);
    runtime.publishBot(bot.id);
    return context.json(publicBot(store, bot), 201);
  });

  app.patch('/api/bots/:id', async (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const body = await readJson<UpdateBotInput>(context);
    if (body.name !== undefined) requireString(body.name, 'name');
    if (body.toolPolicy !== undefined) assertToolPolicy(body.toolPolicy);
    const updated = store.updateBot(botId, {
      ...body,
      ...(body.permission === undefined
        ? {}
        : { permission: normalizePermission(body.permission) }),
    });
    if (updated === undefined) throw new RuntimeError('bot.not_found', `Bot not found: ${botId}`, 404);
    runtime.publishBot(botId);
    return context.json(publicBot(store, updated));
  });

  app.delete('/api/bots/:id', async (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    if (store.countBots() <= 1) {
      throw new RuntimeError('bot.last', 'The last bot cannot be deleted', 409);
    }
    await runtime.closeBot(botId);
    store.deleteBot(botId);
    store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'bot.deleted',
      decision: 'allowed',
      botId,
    });
    return context.body(null, 204);
  });

  app.post('/api/bots/:id/pause', (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const updated = store.setBotPaused(botId, true);
    if (updated === undefined) throw new RuntimeError('bot.not_found', `Bot not found: ${botId}`, 404);
    store.appendAudit({ actor: 'person', initiator: 'person', action: 'bot.paused', decision: 'allowed', botId });
    runtime.publishBot(botId);
    return context.json(publicBot(store, updated));
  });

  app.post('/api/bots/:id/resume', (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const updated = store.setBotPaused(botId, false);
    if (updated === undefined) throw new RuntimeError('bot.not_found', `Bot not found: ${botId}`, 404);
    store.appendAudit({ actor: 'person', initiator: 'person', action: 'bot.resumed', decision: 'allowed', botId });
    runtime.publishBot(botId);
    runtime.kickQueue();
    return context.json(publicBot(store, updated));
  });

  app.get('/api/bots/:id/audit', (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const limitRaw = context.req.query('limit');
    const limit = limitRaw === undefined ? 100 : Number(limitRaw);
    const entries: readonly AuditEntry[] = store.listAudit({
      botId,
      limit: Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 500) : 100,
    });
    return context.json(entries);
  });

  // --------------------------------------------------------------- threads

  app.get('/api/bots/:id/threads', (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const threads = store.listThreads(botId).map((thread) => publicThread(store, thread));
    return context.json(threads);
  });

  app.post('/api/bots/:id/threads', async (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const body = await readJson<{ readonly title?: string }>(context).catch(() => ({}) as { title?: string });
    const thread = store.createThread(botId, body.title === undefined ? {} : { title: body.title });
    const view = publicThread(store, thread);
    hub.publish({ botId, threadId: thread.id, type: 'thread.updated', data: view });
    store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'thread.created',
      decision: 'allowed',
      botId,
      threadId: thread.id,
    });
    return context.json(view, 201);
  });

  app.patch('/api/threads/:id', async (context) => {
    const threadId = context.req.param('id');
    const thread = requireThread(threadId);
    const body = await readJson<{
      readonly title?: string;
      readonly archived?: boolean;
      readonly unread?: boolean;
    }>(context);
    const updated = store.updateThread(threadId, {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.archived === undefined ? {} : { archivedAt: body.archived ? Date.now() : null }),
      ...(body.unread === undefined ? {} : { unread: body.unread ? 1 : 0 }),
    });
    if (updated === undefined) throw new RuntimeError('thread.not_found', `Thread not found: ${threadId}`, 404);
    const view = publicThread(store, updated);
    hub.publish({ botId: thread.botId, threadId, type: 'thread.updated', data: view });
    runtime.publishBot(thread.botId);
    return context.json(view);
  });

  app.delete('/api/threads/:id', async (context) => {
    const threadId = context.req.param('id');
    const deleted = await runtime.deleteThread(threadId);
    if (!deleted) {
      throw new RuntimeError('thread.not_found', `Thread not found: ${threadId}`, 404);
    }
    return context.body(null, 204);
  });

  app.get('/api/threads/:id/messages', async (context) => {
    const threadId = context.req.param('id');
    requireThread(threadId);
    return context.json(await runtime.transcriptSnapshot(threadId));
  });

  app.post('/api/threads/:id/messages', async (context) => {
    const threadId = context.req.param('id');
    const thread = requireThread(threadId);
    const body = await readJson<{
      readonly text: string;
      readonly mode?: 'steer' | 'queue';
      readonly attachments?: readonly string[];
      readonly requestKey?: string;
    }>(context);
    const text = requireString(body.text, 'text');
    if (body.mode !== undefined && body.mode !== 'steer' && body.mode !== 'queue') {
      throw badRequest("mode must be 'steer' or 'queue'");
    }
    if (body.attachments !== undefined && (!Array.isArray(body.attachments) || !body.attachments.every((value) => typeof value === 'string'))) throw badRequest('attachments must be a string array');
    if (body.requestKey !== undefined && (typeof body.requestKey !== 'string' || body.requestKey.length === 0 || body.requestKey.length > 200)) throw badRequest('requestKey must contain 1–200 characters');
    const result = runtime.prompt(threadId, {text,mode:body.mode,attachments:body.attachments,requestKey:body.requestKey});
    store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'message.prompted',
      decision: 'allowed',
      botId: thread.botId,
      threadId,
      payload: { runId: result.runId, mode: body.mode ?? 'queue' },
    });
    return context.json(result, 202);
  });

  app.post('/api/threads/:id/interrupt', async (context) => {
    const threadId = context.req.param('id');
    requireThread(threadId);
    const run = await runtime.interrupt(threadId);
    return context.json({ run: run ?? null });
  });

  // ------------------------------------------------------------------ runs

  app.get('/api/runs', (context) => {
    const botId = context.req.query('botId');
    const threadId = context.req.query('threadId');
    const limitRaw = context.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    const runs = store
      .listRuns({
        ...(botId === undefined || botId.length === 0 ? {} : { botId }),
        ...(threadId === undefined || threadId.length === 0 ? {} : { threadId }),
        ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
      })
      .map(runView);
    return context.json(runs);
  });

  app.get('/api/runs/:id', (context) => {
    const runId = context.req.param('id');
    const run = store.getRun(runId);
    if (run === undefined) throw new RuntimeError('run.not_found', `Run not found: ${runId}`, 404);
    return context.json(runView(run));
  });

  app.post('/api/runs/:id/cancel', (context) => context.json(runtime.cancelQueuedRun(context.req.param('id'))));

  app.post('/api/runs/:id/recovery', async (context) => {
    const body = await readJson<{readonly decision?: string}>(context);
    if (body.decision !== 'continue_queue' && body.decision !== 'retry' && body.decision !== 'cancel_queue') throw badRequest('decision must be continue_queue, retry or cancel_queue');
    return context.json(runtime.recoverRun(context.req.param('id'),body.decision));
  });

  // -------------------------------------------------------------- handoffs

  app.get('/api/handoffs', (context) => {
    const botId = context.req.query('botId');
    const threadId = context.req.query('threadId');
    const limitRaw = context.req.query('limit');
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    const handoffs: readonly Handoff[] = store
      .listHandoffs({
        ...(botId === undefined ? {} : { botId }),
        ...(threadId === undefined ? {} : { threadId }),
        limit: Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 200) : 50,
      })
      .map(publicHandoff);
    return context.json(handoffs);
  });

  // ----------------------------------------------------------------- inbox

  app.get('/api/inbox', (context) => {
    const botId = context.req.query('botId');
    const approvals = store
      .listApprovals({ pendingOnly: true, ...(botId === undefined ? {} : { botId }) })
      .map(publicApproval);
    const questions = store
      .listQuestions({ pendingOnly: true, ...(botId === undefined ? {} : { botId }) })
      .map(publicQuestion);
    const handoffs = store
      .listHandoffs({ ...(botId === undefined ? {} : { botId }), limit: 50 })
      .map(publicHandoff);
    const body: InboxResponse = { approvals, questions, handoffs };
    return context.json(body);
  });

  app.post('/api/approvals/:id', async (context) => {
    const approvalId = context.req.param('id');
    const existing = store.getApproval(approvalId);
    if (existing === undefined) {
      throw new RuntimeError('approval.not_found', `Approval not found: ${approvalId}`, 404);
    }
    const body = await readJson<{ readonly decision?: string; readonly feedback?: string }>(context);
    const decision = body.decision;
    if (decision === undefined || !DECISIONS.includes(decision as ApprovalDecision)) {
      throw badRequest(`decision must be one of: ${DECISIONS.join(', ')}`);
    }
    const updated = await runtime.resolveApproval(
      approvalId,
      decision as ApprovalDecision,
      optionalString(body.feedback, 'feedback'),
    );
    if (updated === undefined) {
      throw new RuntimeError('approval.not_found', `Approval not found: ${approvalId}`, 404);
    }
    return context.json(updated);
  });

  app.post('/api/questions/:id', async (context) => {
    const questionId = context.req.param('id');
    if (store.getQuestion(questionId) === undefined) {
      throw new RuntimeError('question.not_found', `Question not found: ${questionId}`, 404);
    }
    const body = await readJson<{ readonly answers?: unknown }>(context);
    if (typeof body.answers !== 'object' || body.answers === null || Array.isArray(body.answers)) {
      throw badRequest('answers must be an object');
    }
    const answers: Record<string, string | readonly string[]> = {};
    for (const [key, value] of Object.entries(body.answers as Record<string, unknown>)) {
      if (typeof value === 'string') answers[key] = value;
      else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        answers[key] = value;
      } else {
        throw badRequest(`answers.${key} must be a string or string array`);
      }
    }
    const updated = await runtime.resolveQuestion(questionId, answers);
    if (updated === undefined) {
      throw new RuntimeError('question.not_found', `Question not found: ${questionId}`, 404);
    }
    return context.json(updated);
  });

  // ----------------------------------------------------------- rooms (M3)

  for (const path of ['/api/rooms', '/api/rooms/:id/messages']) {
    app.all(path, (context) =>
      context.json(apiError('not_implemented', 'Rooms land in M3'), 501),
    );
  }

  // ----------------------------------------------------------------- files

  app.get('/api/bots/:id/files', async (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const requested = context.req.query('path');
    const threadId = context.req.query('threadId');
    const kind = await files.kind(botId, requested, threadId);
    if (kind === 'dir') return context.json(await files.list(botId, requested, threadId));
    const result = await files.read(botId, requested, threadId);
    return context.json(result);
  });

  app.put('/api/bots/:id/files', async (context) => {
    const botId = context.req.param('id');
    requireBot(botId);
    const requested = context.req.query('path');
    const contentType = context.req.header('content-type') ?? '';
    let content: string;
    if (contentType.includes('application/json')) {
      const body = await readJson<{ readonly content?: unknown }>(context);
      if (typeof body.content !== 'string') throw badRequest('content must be a string');
      content = body.content;
    } else {
      content = await context.req.text();
    }
    const threadId = context.req.query('threadId');
    const result = await files.write(botId, requested, content, threadId);
    store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'file.written',
      decision: 'allowed',
      botId,
      payload: { path: result.path, bytes: result.bytes },
    });
    return context.json(result);
  });

  // ------------------------------------------------------------------- SSE

  app.get('/api/events', (context) => {
    const botId = context.req.query('botId');
    const cursor = context.req.header('Last-Event-ID') ?? context.req.query('lastEventId');
    const scope = botId === undefined || botId.length === 0 ? undefined : botId;
    if (scope !== undefined) requireBot(scope);

    return streamSSE(context, async (stream) => {
      let writes = Promise.resolve();
      const write = (frame: {id?:string;event:string;data:string}): Promise<void> => {
        writes = writes.then(() => stream.writeSSE(frame));
        return writes;
      };
      const subscription = hub.subscribe({botId:scope,lastEventId:cursor,
        snapshot: async (watermark) => { await write({event:'snapshot',data:JSON.stringify({...snapshot(scope),...watermark})}); }
      }, (event:ServerEvent) => { void write({id:eventId(event),event:event.type,data:JSON.stringify(event)}).catch(() => {}); });
      let released = false;
      let release: () => void = () => {};
      const finished = new Promise<void>((resolveDone) => {
        release = resolveDone;
      });
      const cleanup = () => {
        if (released) return;
        released = true;
        subscription.unsubscribe();
        release();
      };
      stream.onAbort(cleanup);

      await subscription.ready;
      await writes;

      const heartbeat = setInterval(() => {
        void write({ event: 'ping', data: String(Date.now()) }).catch(cleanup);
      }, 15_000);
      heartbeat.unref?.();

      await finished;
      clearInterval(heartbeat);
    });
  });

  // ------------------------------------------------------------------- UI

  if (options.uiDir !== undefined && existsSync(options.uiDir)) {
    const root = relative(process.cwd(), options.uiDir);
    app.use('*', serveStatic({ root }));
    app.get('*', serveStatic({ path: join(root, 'index.html') }));
  }

  app.notFound((context) => {
    if (context.req.path.startsWith('/api/')) {
      return context.json(apiError('not_found', `No route for ${context.req.path}`), 404);
    }
    return context.text(
      'Bot UI is not built. Run `pnpm --filter scream-code run bot:build`.\n',
      404,
    );
  });

  return app;
}
