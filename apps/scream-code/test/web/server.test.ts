import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ErrorCodes,
  ScreamError,
  type ContextMessage,
  type Event,
  type GoalSnapshotData,
  type Session,
  type SessionStatus,
  type TodoItem,
} from '@scream-code/scream-code-sdk';
import { appendSessionIndexEntry, encodeWorkDirKey, normalizeWorkDir } from '@scream-code/agent-core';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionManager, startWebIdleExit, startWebServerForSession, type WebServerHandle } from '#/web/server';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface FakeSessionControl {
  readonly session: Session;
  readonly createGoal: ReturnType<typeof vi.fn>;
  readonly updateGoalStatus: ReturnType<typeof vi.fn>;
  readonly updateGoalObjective: ReturnType<typeof vi.fn>;
  readonly setGoalBudget: ReturnType<typeof vi.fn>;
  readonly cancelGoal: ReturnType<typeof vi.fn>;
  readonly prompt: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  emit: (event: Event) => void;
  getCurrentGoal: () => GoalSnapshotData | null;
}

const handles: WebServerHandle[] = [];
const tempDirs: string[] = [];

const STATUS: SessionStatus = {
  model: 'test-model',
  thinkingLevel: 'off',
  permission: 'manual',
  planMode: false,
  wolfpackMode: false,
  rlmEnabled: false,
  contextTokens: 10,
  maxContextTokens: 1000,
  contextUsage: 0.01,
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function goalSnapshot(objective: string, status = 'active'): GoalSnapshotData {
  return {
    goalId: `goal-${objective}`,
    objective,
    status,
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      overBudget: false,
    },
    notes: [],
  };
}

function goalEvent(sessionId: string, snapshot: GoalSnapshotData | null, agentId = 'main'): Event {
  return {
    type: 'goal.updated',
    sessionId,
    agentId,
    snapshot,
  } as unknown as Event;
}

function todoEvent(sessionId: string, todos: readonly TodoItem[], agentId = 'main'): Event {
  return {
    type: 'todo.updated',
    sessionId,
    agentId,
    todos,
  } as Event;
}

function makeFakeSession(options: {
  id?: string;
  initialGoal?: GoalSnapshotData | null;
  initialTodos?: readonly TodoItem[];
  getGoal?: () => Promise<{ goal: GoalSnapshotData | null }>;
  getTodos?: () => Promise<readonly TodoItem[]>;
  getContext?: () => Promise<{ history: readonly ContextMessage[]; tokenCount: number }>;
  promptError?: Error;
  pauseGate?: Promise<void>;
} = {}): FakeSessionControl {
  const id = options.id ?? 'session-1';
  const listeners = new Set<(event: Event) => void>();
  let currentGoal = options.initialGoal ?? null;
  const currentTodos = options.initialTodos ?? [];

  const emit = (event: Event): void => {
    for (const listener of listeners) listener(event);
  };

  const createGoal = vi.fn(async (
    objective: string,
    createOptions?: { completionCriterion?: string; replace?: boolean },
  ): Promise<GoalSnapshotData> => {
    if (currentGoal !== null && createOptions?.replace !== true) {
      throw new ScreamError(ErrorCodes.GOAL_ALREADY_EXISTS, 'A goal already exists');
    }
    currentGoal = {
      ...goalSnapshot(objective),
      completionCriterion: createOptions?.completionCriterion,
    };
    emit(goalEvent(id, currentGoal));
    return structuredClone(currentGoal);
  });

  const updateGoalStatus = vi.fn(async (status: 'active' | 'complete' | 'paused' | 'blocked') => {
    if (status === 'paused') await options.pauseGate;
    if (currentGoal === null) throw new ScreamError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    if (status === 'active' && currentGoal.status !== 'paused' && currentGoal.status !== 'blocked') {
      throw new ScreamError(ErrorCodes.GOAL_NOT_RESUMABLE, 'Goal cannot be resumed');
    }
    currentGoal = { ...currentGoal, status };
    emit(goalEvent(id, currentGoal));
    return structuredClone(currentGoal);
  });

  const updateGoalObjective = vi.fn(async (objective: string): Promise<GoalSnapshotData> => {
    if (currentGoal === null) throw new ScreamError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    currentGoal = { ...currentGoal, objective };
    emit(goalEvent(id, currentGoal));
    return structuredClone(currentGoal);
  });

  const setGoalBudget = vi.fn(async (value: number, unit: string): Promise<GoalSnapshotData> => {
    if (currentGoal === null) throw new ScreamError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    const budget = { ...currentGoal.budget };
    if (unit === 'turns') budget.turnBudget = value;
    else if (unit === 'tokens') budget.tokenBudget = value;
    else budget.wallClockBudgetMs = unit === 'minutes' ? value * 60_000 : value;
    currentGoal = { ...currentGoal, budget };
    emit(goalEvent(id, currentGoal));
    return structuredClone(currentGoal);
  });

  const cancelGoal = vi.fn(async (): Promise<GoalSnapshotData | null> => {
    const previous = currentGoal;
    currentGoal = null;
    emit(goalEvent(id, null));
    return previous;
  });

  const prompt = vi.fn(async (): Promise<void> => {
    if (options.promptError) throw options.promptError;
  });
  const close = vi.fn(async (): Promise<void> => {});

  const session = {
    id,
    workDir: '/tmp/project',
    onEvent: (listener: (event: Event) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    getStatus: vi.fn(async () => STATUS),
    getGoal: options.getGoal ?? vi.fn(async () => ({ goal: structuredClone(currentGoal) })),
    getTodos: options.getTodos ?? vi.fn(async () => structuredClone(currentTodos)),
    // The activation/fork paths seed history from the core context; an empty history
    // by default means no seeding (existing suites keep their wording).
    getContext: options.getContext ?? vi.fn(async () => ({ history: [], tokenCount: 0 })),
    generateText: vi.fn(async () => 'Refined objective'),
    createGoal,
    updateGoalStatus,
    updateGoalObjective,
    setGoalBudget,
    cancelGoal,
    prompt,
    close,
  } as unknown as Session;

  return {
    session,
    createGoal,
    updateGoalStatus,
    updateGoalObjective,
    setGoalBudget,
    cancelGoal,
    prompt,
    close,
    emit,
    getCurrentGoal: () => structuredClone(currentGoal),
  };
}

async function start(control: FakeSessionControl): Promise<WebServerHandle> {
  const handle = await startWebServerForSession(control.session, {
    port: 0,
    workDir: '/tmp/project',
    yolo: false,
    open: false,
  });
  handles.push(handle);
  return handle;
}

async function jsonRequest(url: string, path: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json();
  return { response, body };
}

async function openSocket(url: string): Promise<{ socket: WebSocket; hello: Record<string, unknown> }> {
  const socket = new WebSocket(url.replace('http://', 'ws://'));
  const helloPromise = nextMessage(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, hello: await helloPromise };
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

async function nextMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const onMessage = (data: Buffer): void => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (messages.length === count) {
          socket.off('message', onMessage);
          resolve(messages);
        }
      } catch (error) {
        reject(error);
      }
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Web Goal/Todo state', () => {
  it('subscribes before initial reads, ignores subagent state, and replays each durable event once', async () => {
    const initialGoal = deferred<{ goal: GoalSnapshotData | null }>();
    const initialTodos = deferred<readonly TodoItem[]>();
    const goalReadStarted = deferred<void>();
    const todosReadStarted = deferred<void>();
    const control = makeFakeSession({
      getGoal: async () => {
        goalReadStarted.resolve();
        return initialGoal.promise;
      },
      getTodos: async () => {
        todosReadStarted.resolve();
        return initialTodos.promise;
      },
    });

    const starting = start(control);
    await Promise.all([goalReadStarted.promise, todosReadStarted.promise]);

    const liveGoal = goalSnapshot('live goal');
    const liveTodos: TodoItem[] = [{ title: 'live todo', status: 'in_progress', phase: 'Web' }];
    control.emit(goalEvent(control.session.id, goalSnapshot('subagent goal'), 'child-1'));
    control.emit(todoEvent(control.session.id, [{ title: 'subagent todo', status: 'pending' }], 'child-1'));
    control.emit(goalEvent(control.session.id, liveGoal));
    control.emit(todoEvent(control.session.id, liveTodos));

    (liveGoal as { objective: string }).objective = 'mutated outside';
    (liveTodos[0] as { title: string }).title = 'mutated outside';

    initialGoal.resolve({ goal: goalSnapshot('stale RPC goal') });
    initialTodos.resolve([{ title: 'stale RPC todo', status: 'pending' }]);
    const handle = await starting;

    const snapshotResult = await jsonRequest(handle.url, '/api/v1/sessions/session-1/snapshot');
    expect(snapshotResult.response.status).toBe(200);
    expect(snapshotResult.body).toMatchObject({
      seq: 2,
      goal: { objective: 'live goal' },
      todos: [{ title: 'live todo', status: 'in_progress', phase: 'Web' }],
    });

    const { socket, hello } = await openSocket(handle.url);
    expect(hello).toMatchObject({ type: 'server_hello', epoch: 1 });
    const replay = nextMessages(socket, 2);
    socket.send(JSON.stringify({ type: 'client_hello', lastSeq: 0, epoch: 0 }));
    const replayed = await replay;
    expect(replayed.map((message) => [message['seq'], (message['payload'] as Event).type])).toEqual([
      [1, 'goal.updated'],
      [2, 'todo.updated'],
    ]);

    const second = await openSocket(handle.url);
    const secondReady = nextMessage(second.socket);
    second.socket.send(JSON.stringify({ type: 'client_hello', lastSeq: 2, epoch: 1 }));
    second.socket.send(JSON.stringify({ type: 'ping' }));
    expect(await secondReady).toMatchObject({ type: 'pong' });
    const firstTabUpdate = nextMessage(socket);
    const secondTabUpdate = nextMessage(second.socket);
    control.emit(goalEvent(control.session.id, goalSnapshot('broadcast goal')));
    const expectedUpdate = {
      type: 'event',
      seq: 3,
      epoch: 1,
      payload: { type: 'goal.updated', snapshot: { objective: 'broadcast goal' } },
    };
    expect(await firstTabUpdate).toMatchObject(expectedUpdate);
    expect(await secondTabUpdate).toMatchObject(expectedUpdate);

    second.socket.close();
    control.emit(todoEvent(control.session.id, [{ title: 'offline update', status: 'done' }]));
    const reconnected = await openSocket(handle.url);
    const missing = nextMessage(reconnected.socket);
    reconnected.socket.send(JSON.stringify({ type: 'client_hello', lastSeq: 3, epoch: 1 }));
    expect(await missing).toMatchObject({
      type: 'event',
      seq: 4,
      payload: { type: 'todo.updated', todos: [{ title: 'offline update', status: 'done' }] },
    });
    socket.close();
    reconnected.socket.close();
  });
});

describe('Goal REST operations', () => {
  it('validates input, maps replace conflicts, and delegates create/update/lifecycle operations', async () => {
    const control = makeFakeSession();
    const handle = await start(control);
    const base = '/api/v1/sessions/session-1/goal';

    const invalid = await jsonRequest(handle.url, `${base}/refine`, {
      method: 'POST',
      body: JSON.stringify({ description: '   ' }),
    });
    expect(invalid.response.status).toBe(400);

    const refined = await jsonRequest(handle.url, `${base}/refine`, {
      method: 'POST',
      body: JSON.stringify({ description: 'rough task' }),
    });
    expect(refined.response.status).toBe(200);
    expect(refined.body).toEqual({ objective: 'Refined objective' });

    const missing = await jsonRequest(handle.url, `${base}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    expect(missing.response.status).toBe(404);
    expect(missing.body).toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });

    const duplicateTimeBudget = await jsonRequest(handle.url, base, {
      method: 'POST',
      body: JSON.stringify({
        objective: 'Invalid budgets',
        budgets: [
          { value: 1, unit: 'minutes' },
          { value: 1, unit: 'hours' },
        ],
      }),
    });
    expect(duplicateTimeBudget.response.status).toBe(400);
    expect(control.createGoal).not.toHaveBeenCalled();

    const created = await jsonRequest(handle.url, base, {
      method: 'POST',
      body: JSON.stringify({
        objective: 'Ship Web Goal',
        completionCriterion: 'Focused tests pass',
        budgets: [{ value: 12, unit: 'turns' }],
      }),
    });
    expect(created.response.status).toBe(202);
    expect(control.createGoal).toHaveBeenCalledWith('Ship Web Goal', {
      completionCriterion: 'Focused tests pass',
      replace: false,
    });
    expect(control.setGoalBudget).toHaveBeenCalledWith(12, 'turns');
    expect(control.prompt).toHaveBeenCalledWith('Ship Web Goal');

    const busy = await jsonRequest(handle.url, base, {
      method: 'PATCH',
      body: JSON.stringify({ objective: 'Must wait' }),
    });
    expect(busy.response.status).toBe(409);
    expect(busy.body).toMatchObject({ message: 'Session is busy' });

    control.emit({ type: 'turn.ended', sessionId: 'session-1', agentId: 'main', turnId: 1, reason: 'completed' });
    const conflict = await jsonRequest(handle.url, base, {
      method: 'POST',
      body: JSON.stringify({ objective: 'Conflicting goal' }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: ErrorCodes.GOAL_ALREADY_EXISTS });

    const replaced = await jsonRequest(handle.url, base, {
      method: 'POST',
      body: JSON.stringify({ objective: 'Replacement goal', replace: true }),
    });
    expect(replaced.response.status).toBe(202);
    expect(control.createGoal).toHaveBeenLastCalledWith('Replacement goal', {
      completionCriterion: undefined,
      replace: true,
    });
    control.emit({ type: 'turn.ended', sessionId: 'session-1', agentId: 'main', turnId: 2, reason: 'completed' });

    const updated = await jsonRequest(handle.url, base, {
      method: 'PATCH',
      body: JSON.stringify({ objective: 'Updated objective', budgets: [{ value: 5000, unit: 'tokens' }] }),
    });
    expect(updated.response.status).toBe(202);
    expect(control.updateGoalObjective).toHaveBeenCalledWith('Updated objective');
    expect(control.setGoalBudget).toHaveBeenCalledWith(5000, 'tokens');

    expect((await jsonRequest(handle.url, `${base}/pause`, { method: 'POST', body: '{}' })).response.status).toBe(202);
    expect((await jsonRequest(handle.url, `${base}/resume`, { method: 'POST', body: '{}' })).response.status).toBe(202);
    expect(control.prompt).toHaveBeenLastCalledWith(expect.stringContaining('Continue working'));
    expect((await jsonRequest(handle.url, `${base}/cancel`, { method: 'POST', body: '{}' })).response.status).toBe(202);
    expect(control.cancelGoal).toHaveBeenCalledOnce();
  });

  it('serializes concurrent mutations per session', async () => {
    const pauseGate = deferred<void>();
    const control = makeFakeSession({ initialGoal: goalSnapshot('serial goal'), pauseGate: pauseGate.promise });
    const handle = await start(control);
    const base = '/api/v1/sessions/session-1/goal';

    const pausing = jsonRequest(handle.url, `${base}/pause`, { method: 'POST', body: '{}' });
    await vi.waitFor(() => expect(control.updateGoalStatus).toHaveBeenCalledWith('paused'));
    const cancelling = jsonRequest(handle.url, `${base}/cancel`, { method: 'POST', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(control.cancelGoal).not.toHaveBeenCalled();

    pauseGate.resolve();
    expect((await pausing).response.status).toBe(202);
    expect((await cancelling).response.status).toBe(202);
    expect(control.cancelGoal).toHaveBeenCalledOnce();
  });

  it('pauses an active goal and returns an explicit error when auto-start submission fails', async () => {
    const control = makeFakeSession({ promptError: new Error('launch rejected') });
    const handle = await start(control);

    const result = await jsonRequest(handle.url, '/api/v1/sessions/session-1/goal', {
      method: 'POST',
      body: JSON.stringify({ objective: 'Cannot launch' }),
    });

    expect(result.response.status).toBe(500);
    expect(result.body).toMatchObject({ message: expect.stringContaining('it was paused') });
    expect(control.getCurrentGoal()).toMatchObject({ objective: 'Cannot launch', status: 'paused' });
  });
});

describe('Web/core session ID restoration', () => {
  it('resumes and migrates a legacy metadata ID, then forks by the core ID', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-legacy.meta.json'), JSON.stringify({
      sessionId: 'web-legacy', workDir: '/tmp/project', title: 'Legacy', createdAt: 1,
      model: 'test-model', permission: 'manual',
    }));

    const resumed = makeFakeSession({ id: 'web-legacy' });
    const forked = makeFakeSession({ id: 'core-fork' });
    const harness = {
      createSession: vi.fn(),
      resumeSession: vi.fn(async () => resumed.session),
      forkSession: vi.fn(async () => forked.session),
    };
    const manager = new SessionManager({
      harness: harness as never, homeDir, workDir: '/tmp/project',
      model: 'test-model', permission: 'manual', yolo: false,
    });

    await manager.init();
    const active = await manager.activateSession('web-legacy');
    if (!active) throw new Error('Expected restored session');
    expect(active.sessionId).toBe('web-legacy');
    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'web-legacy' });
    expect(harness.createSession).not.toHaveBeenCalled();

    const migrated = JSON.parse(await readFile(join(sessionsDir, 'web-legacy.meta.json'), 'utf-8')) as Record<string, unknown>;
    expect(migrated['coreSessionId']).toBe('web-legacy');

    await manager.forkSession('web-legacy');
    expect(harness.forkSession).toHaveBeenCalledWith({ id: 'web-legacy' });

    await active.close();
    await expect(active.updateGoal('archived mutation', [])).rejects.toMatchObject({
      statusCode: 409,
      message: 'Session is archived (read-only)',
    });
    await manager.closeAll();
  });

  it('uses a distinct saved coreSessionId instead of the Web ID', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-id.meta.json'), JSON.stringify({
      sessionId: 'web-id', coreSessionId: 'core-id', workDir: '/tmp/project',
      title: 'Saved', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const resumed = makeFakeSession({ id: 'core-id' });
    const forked = makeFakeSession({ id: 'core-fork-2' });
    const harness = {
      createSession: vi.fn(),
      resumeSession: vi.fn(async () => resumed.session),
      forkSession: vi.fn(async () => forked.session),
    };
    const manager = new SessionManager({
      harness: harness as never, homeDir, workDir: '/tmp/project',
      model: 'test-model', permission: 'manual', yolo: false,
    });

    await manager.init();
    await manager.activateSession('web-id');
    expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'core-id' });
    expect(harness.createSession).not.toHaveBeenCalled();
    await manager.forkSession('web-id');
    expect(harness.forkSession).toHaveBeenCalledWith({ id: 'core-id' });
    await manager.closeAll();
  });

  it('re-indexes a core session missing from the global index, then resumes it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-orphan.meta.json'), JSON.stringify({
      sessionId: 'web-orphan', coreSessionId: 'core-orphan', workDir: '/tmp/project',
      title: 'Orphan', createdAt: 1, model: 'test-model', permission: 'manual',
    }));
    // The core session directory exists on disk, but the global index lost its
    // entry (older builds never appended one) — the exact 1011 storm trigger.
    const coreDir = join(homeDir, 'sessions', encodeWorkDirKey('/tmp/project'), 'core-orphan');
    await mkdir(coreDir, { recursive: true });
    await writeFile(join(coreDir, 'state.json'), '{}');

    const resumed = makeFakeSession({ id: 'core-orphan' });
    const harness = {
      createSession: vi.fn(),
      resumeSession: vi.fn(async () => {
        if (harness.resumeSession.mock.calls.length === 1) {
          throw new ScreamError(ErrorCodes.SESSION_NOT_FOUND, 'Session "core-orphan" was not found');
        }
        return resumed.session;
      }),
      forkSession: vi.fn(),
    };
    const manager = new SessionManager({
      harness: harness as never, homeDir, workDir: '/tmp/project',
      model: 'test-model', permission: 'manual', yolo: false,
    });

    await manager.init();
    const active = await manager.activateSession('web-orphan');

    expect(active?.sessionId).toBe('web-orphan');
    expect(harness.resumeSession).toHaveBeenCalledTimes(2);
    // Self-heal: the global index regained the entry.
    const indexRaw = await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8');
    expect(indexRaw).toContain('"sessionId":"core-orphan"');
    await manager.closeAll();
  });

  it('returns null (terminal 1008 path) when the core session directory is truly gone', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-gone.meta.json'), JSON.stringify({
      sessionId: 'web-gone', coreSessionId: 'core-gone', workDir: '/tmp/project',
      title: 'Gone', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const harness = {
      createSession: vi.fn(),
      resumeSession: vi.fn(async () => {
        throw new ScreamError(ErrorCodes.SESSION_NOT_FOUND, 'Session "core-gone" was not found');
      }),
      forkSession: vi.fn(),
    };
    const manager = new SessionManager({
      harness: harness as never, homeDir, workDir: '/tmp/project',
      model: 'test-model', permission: 'manual', yolo: false,
    });

    await manager.init();
    // null → the WS layer closes 1008 (terminal) instead of 1011 (retry storm).
    await expect(manager.activateSession('web-gone')).resolves.toBeNull();
    // No point retrying a session whose directory does not exist.
    expect(harness.resumeSession).toHaveBeenCalledTimes(1);
    await manager.closeAll();
  });

  it('keeps non-not-found activation failures on the retryable (1011) path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-boom.meta.json'), JSON.stringify({
      sessionId: 'web-boom', coreSessionId: 'core-boom', workDir: '/tmp/project',
      title: 'Boom', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const harness = {
      createSession: vi.fn(),
      resumeSession: vi.fn(async () => {
        throw new Error('provider init exploded');
      }),
      forkSession: vi.fn(),
    };
    const manager = new SessionManager({
      harness: harness as never, homeDir, workDir: '/tmp/project',
      model: 'test-model', permission: 'manual', yolo: false,
    });

    await manager.init();
    // Transient failures must keep propagating so the WS layer answers 1011.
    await expect(manager.activateSession('web-boom')).rejects.toThrow('provider init exploded');
    expect(harness.resumeSession).toHaveBeenCalledTimes(1);
    await manager.closeAll();
  });
});

/**
 * The "core index restoration" branch of the session list: an entry that exists in
 * the index, whose directory exists, and whose workDir matches must be collected.
 * An index entry's sessionDir can only be <home>/sessions/<wdKey>/<id> (the
 * agent-core layout) and its workDir can only be the normalizeWorkDir value - both
 * wordings have to agree with agent-core, otherwise this restoration is dead code.
 */
describe('Session list: core index restoration', () => {
  it('collects index entries under the core sessions root with a normalized workDir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(root);
    const homeDir = join(root, 'home');
    // Repo root + subdirectory: when the server starts from a subdirectory,
    // this.workDir is that subdirectory, while the workDir agent-core writes into the
    // index is the repo root found by walking up to package.json.
    const repo = join(root, 'repo');
    const subDir = join(repo, 'sub');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(repo, 'package.json'), '{}');
    expect(normalizeWorkDir(subDir)).toBe(repo);

    const bucket = join(homeDir, 'sessions', encodeWorkDirKey(subDir));
    const coreDir = join(bucket, 'session_idx1');
    await mkdir(coreDir, { recursive: true });
    await writeFile(join(coreDir, 'state.json'), JSON.stringify({ title: '从索引恢复', createdAt: 1_700_000_000_000 }));
    await appendSessionIndexEntry(homeDir, { sessionId: 'session_idx1', sessionDir: coreDir, workDir: repo });
    // The second entry uses an id without the session_ prefix: the directory
    // fallback scan only accepts that prefix, so only the index path can recover it.
    // Asserting both entries together is what makes "is the index path really
    // collecting" bite: with only the session_ entry, the scan fallback would list
    // the dropped entry again and the case would go mute.
    const legacyDir = join(bucket, 'legacy-from-index');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'state.json'), JSON.stringify({ title: '索引独有' }));
    await appendSessionIndexEntry(homeDir, { sessionId: 'legacy-from-index', sessionDir: legacyDir, workDir: repo });

    const manager = new SessionManager({
      harness: { createSession: vi.fn(), resumeSession: vi.fn(), forkSession: vi.fn() } as never,
      homeDir,
      workDir: subDir,
      model: 'test-model',
      permission: 'manual',
      yolo: false,
    });
    await manager.init();

    const items = manager.list();
    // Assert first that the index path really collects: an entry without the session_
    // prefix can only be recovered through the index.
    expect(items.some((s) => s.sessionId === 'legacy-from-index')).toBe(true);
    const listed = items.find((s) => s.sessionId === 'session_idx1');
    expect(listed).toBeDefined();
    expect(listed?.title).toBe('从索引恢复');
    // workDir comes from the normalized index value (the agent-core wording), not from
    // the raw startup subdirectory.
    expect(listed?.workDir).toBe(repo);
    await manager.closeAll();
  });
});

/**
 * Delete must move **the session's own** core directory to trash: the workspace a
 * session is bound to need not be the server process directory, and the core session
 * id need not equal the web sessionId. Locating it wrongly leaves the directory in
 * the sessions tree while the index and in-memory entries are already removed - the
 * user believes it is deleted, and the next start lists it again from disk.
 */
describe('Delete: move the session\'s own core directory to trash', () => {
  it('trashes the core dir derived from the session workDir + core id, and drops its index entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(root);
    const homeDir = join(root, 'home');
    const serverBase = join(root, 'server-base');
    const otherWorkspace = join(root, 'ws-alpha');
    await mkdir(serverBase, { recursive: true });
    await mkdir(otherWorkspace, { recursive: true });

    const coreId = 'session_del1';
    const coreDir = join(homeDir, 'sessions', encodeWorkDirKey(otherWorkspace), coreId);
    await mkdir(coreDir, { recursive: true });
    await writeFile(join(coreDir, 'state.json'), JSON.stringify({ title: '别的 workspace 的会话' }));
    await appendSessionIndexEntry(homeDir, {
      sessionId: coreId,
      sessionDir: coreDir,
      workDir: normalizeWorkDir(otherWorkspace),
    });
    const webSessionsDir = join(homeDir, 'web-sessions');
    await mkdir(webSessionsDir, { recursive: true });
    await writeFile(join(webSessionsDir, 'web-del1.meta.json'), JSON.stringify({
      sessionId: 'web-del1', coreSessionId: coreId, workDir: otherWorkspace,
      title: '别的 workspace 的会话', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const manager = new SessionManager({
      harness: { createSession: vi.fn(), resumeSession: vi.fn(), forkSession: vi.fn() } as never,
      homeDir,
      // The server process directory differs from the target session workspace - the
      // old implementation is where the path was assembled wrongly.
      workDir: serverBase,
      model: 'test-model',
      permission: 'manual',
      yolo: false,
    });
    await manager.init();
    expect(manager.list().map((s) => s.sessionId)).toEqual(['web-del1']);

    await expect(manager.delete('web-del1')).resolves.toBe(true);

    // The directory really left the sessions tree (otherwise a disk scan would list it
    // again after a restart).
    expect(existsSync(coreDir)).toBe(false);
    const trashed = await readdir(join(homeDir, 'trash')).catch(() => [] as string[]);
    expect(trashed.some((name) => name.startsWith(`${coreId}-`))).toBe(true);
    // The index is pruned by core session id: an index entry's sessionId is the core
    // id, so pruning with the web id would be a no-op.
    const indexRaw = await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8').catch(() => '');
    expect(indexRaw).not.toContain(coreId);
    await manager.closeAll();
  });

  it('keeps the core dir and its index entry when the trash move fails (no silent data loss)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(root);
    const homeDir = join(root, 'home');
    const serverBase = join(root, 'server-base');
    const otherWorkspace = join(root, 'ws-beta');
    await mkdir(serverBase, { recursive: true });
    await mkdir(otherWorkspace, { recursive: true });

    const coreId = 'session_del2';
    const coreDir = join(homeDir, 'sessions', encodeWorkDirKey(otherWorkspace), coreId);
    await mkdir(coreDir, { recursive: true });
    await writeFile(join(coreDir, 'state.json'), JSON.stringify({ title: '搬不动' }));
    await appendSessionIndexEntry(homeDir, {
      sessionId: coreId,
      sessionDir: coreDir,
      workDir: normalizeWorkDir(otherWorkspace),
    });
    // The trash location is occupied by a regular file -> mkdir(recursive) throws
    // EEXIST, simulating a "move failed" outcome.
    await writeFile(join(homeDir, 'trash'), 'not a directory');
    const webSessionsDir = join(homeDir, 'web-sessions');
    await mkdir(webSessionsDir, { recursive: true });
    await writeFile(join(webSessionsDir, 'web-del2.meta.json'), JSON.stringify({
      sessionId: 'web-del2', coreSessionId: coreId, workDir: otherWorkspace,
      title: '搬不动', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const manager = new SessionManager({
      harness: { createSession: vi.fn(), resumeSession: vi.fn(), forkSession: vi.fn() } as never,
      homeDir, workDir: serverBase, model: 'test-model', permission: 'manual', yolo: false,
    });
    await manager.init();
    // UI semantics unchanged: the session still disappears from the list (otherwise
    // clicking delete would appear to do nothing).
    await expect(manager.delete('web-del2')).resolves.toBe(true);
    expect(manager.list()).toEqual([]);
    // But the data must not "pretend to be deleted": the directory stays as it is and
    // the index entry stays too, so the next start still sees it.
    expect(existsSync(coreDir)).toBe(true);
    const indexRaw = await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8');
    expect(indexRaw).toContain(coreId);
    await manager.closeAll();
  });
});

/**
 * fork seeding: when a source session only has history because activation seeded it
 * from the core transcript (its journal holds no messages), the copied journal is an
 * empty shell - the forked session has to be seeded from its own core wire the same
 * way, otherwise the fork looks like a blank page.
 */
describe('Fork: seed history from the forked core transcript', () => {
  it('shows the source conversation in the fork even when the journal held no messages', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-test-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-seed.meta.json'), JSON.stringify({
      sessionId: 'web-seed', coreSessionId: 'core-seed', workDir: '/tmp/project',
      title: 'Seed', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const history: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '源历史提问' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: '源历史回答' }], toolCalls: [] },
    ];
    const source = makeFakeSession({ id: 'core-seed', getContext: async () => ({ history, tokenCount: 2 }) });
    // The forked core session carries the same wire (a fork copies the agent state).
    const forked = makeFakeSession({ id: 'core-fork', getContext: async () => ({ history, tokenCount: 2 }) });
    const harness = {
      createSession: vi.fn(),
      resumeSession: vi.fn(async () => source.session),
      forkSession: vi.fn(async () => forked.session),
    };
    const manager = new SessionManager({
      harness: harness as never, homeDir, workDir: '/tmp/project',
      model: 'test-model', permission: 'manual', yolo: false,
    });

    await manager.init();
    const active = await manager.activateSession('web-seed');
    expect(active).not.toBeNull();
    // The source session itself shows history through seeding: its durable journal has
    // no message entries, so whatever the fork copied is necessarily empty - seeding is
    // the forked session's only source.
    expect(manager.get('web-seed')?.getSnapshot().messages.map((m) => m.content))
      .toEqual(['源历史提问', '源历史回答']);

    const result = await manager.forkSession('web-seed');
    expect(result).not.toBeNull();
    expect(harness.forkSession).toHaveBeenCalledWith({ id: 'core-seed' });
    const forkedView = manager.get(result!.sessionId);
    expect(forkedView?.getSnapshot().messages.map((m) => m.content))
      .toEqual(['源历史提问', '源历史回答']);
    await manager.closeAll();
  });
});

describe('Web idle exit (watchdog unit)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits after the idle window when nobody is connected', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const exit = vi.fn();
    const watch = startWebIdleExit({ idleMs: 1000, busy: () => false, shutdown, exit });
    await vi.advanceTimersByTimeAsync(1100);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    watch.stop();
  });

  it('defers the exit while a browser connection is open, then exits after it disconnects', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const exit = vi.fn();
    const watch = startWebIdleExit({ idleMs: 1000, busy: () => false, shutdown, exit });
    watch.noteConnection();
    await vi.advanceTimersByTimeAsync(5000);
    expect(shutdown).not.toHaveBeenCalled();
    watch.noteDisconnect();
    await vi.advanceTimersByTimeAsync(1100);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    watch.stop();
  });

  it('defers the exit while an agent turn is in flight, then exits after it ends', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const exit = vi.fn();
    let busy = true;
    const watch = startWebIdleExit({ idleMs: 1000, busy: () => busy, shutdown, exit });
    await vi.advanceTimersByTimeAsync(3000);
    expect(shutdown).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(shutdown).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('resets the idle window on HTTP activity', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const exit = vi.fn();
    const watch = startWebIdleExit({ idleMs: 1000, busy: () => false, shutdown, exit });
    await vi.advanceTimersByTimeAsync(600);
    watch.touch();
    await vi.advanceTimersByTimeAsync(600);
    expect(shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(shutdown).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('is a no-op when idleMs is not positive', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const exit = vi.fn();
    const watch = startWebIdleExit({ idleMs: 0, busy: () => false, shutdown, exit });
    await vi.advanceTimersByTimeAsync(5000);
    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    watch.touch();
    watch.noteConnection();
    watch.noteDisconnect();
    watch.stop();
  });
});

describe('Web idle exit (server integration)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  async function waitForServerClosed(timeoutMs = 8000): Promise<void> {
    // Poll the exit spy instead of fetching the server: any HTTP request would
    // reset the idle window and keep the server alive forever.
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    }, { timeout: timeoutMs, interval: 50 });
  }

  it('shuts itself down when the browser never connects', async () => {
    const control = makeFakeSession();
    const handle = await startWebServerForSession(control.session, {
      port: 0,
      workDir: '/tmp/project',
      yolo: false,
      open: false,
      idleMinutes: 0.006, // 360 ms
    });
    handles.push(handle);
    await waitForServerClosed();
  }, 10_000);

  it('stays alive while a browser socket is connected', async () => {
    const control = makeFakeSession();
    const handle = await startWebServerForSession(control.session, {
      port: 0,
      workDir: '/tmp/project',
      yolo: false,
      open: false,
      idleMinutes: 0.006,
    });
    handles.push(handle);
    const { socket } = await openSocket(handle.url);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // > 3× idle window
    expect(exitSpy).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  }, 10_000);

  it('resets the idle window on HTTP activity', async () => {
    const control = makeFakeSession();
    const handle = await startWebServerForSession(control.session, {
      port: 0,
      workDir: '/tmp/project',
      yolo: false,
      open: false,
      idleMinutes: 0.006,
    });
    handles.push(handle);
    for (let i = 0; i < 5; i++) {
      await fetch(`${handle.url}/`).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250)); // every 250ms < 360ms window
    }
    expect(exitSpy).not.toHaveBeenCalled();
  }, 10_000);

  it('never exits when idle exit is disabled', async () => {
    const control = makeFakeSession();
    const handle = await startWebServerForSession(control.session, {
      port: 0,
      workDir: '/tmp/project',
      yolo: false,
      open: false,
      idleMinutes: 0,
    });
    handles.push(handle);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(exitSpy).not.toHaveBeenCalled();
    const response = await fetch(`${handle.url}/`).catch(() => null);
    expect(response).not.toBeNull();
  }, 10_000);

  it('defers the exit while a subagent turn is nested under the main turn', async () => {
    const control = makeFakeSession();
    const handle = await startWebServerForSession(control.session, {
      port: 0,
      workDir: '/tmp/project',
      yolo: false,
      open: false,
      idleMinutes: 0.006,
    });
    handles.push(handle);
    // Main turn starts → subagent runs and finishes → main turn still in flight.
    control.emit({ type: 'turn.started', sessionId: 'session-1', agentId: 'main' } as unknown as Event);
    control.emit({ type: 'turn.started', sessionId: 'session-1', agentId: 'sub' } as unknown as Event);
    control.emit({ type: 'turn.ended', sessionId: 'session-1', agentId: 'sub' } as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // > 3× idle window
    expect(exitSpy).not.toHaveBeenCalled();
    control.emit({ type: 'turn.ended', sessionId: 'session-1', agentId: 'main' } as unknown as Event);
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    }, { timeout: 8000, interval: 50 });
  }, 10_000);

  it('stops the watchdog when the port is already taken', async () => {
    const control = makeFakeSession();
    const first = await startWebServerForSession(control.session, {
      port: 0,
      workDir: '/tmp/project',
      yolo: false,
      open: false,
      idleMinutes: 0,
    });
    handles.push(first);
    const takenPort = Number(new URL(first.url).port);
    const control2 = makeFakeSession();
    await expect(startWebServerForSession(control2.session, {
      port: takenPort,
      workDir: '/tmp/project',
      yolo: false,
      open: false,
      idleMinutes: 0.006,
    })).rejects.toThrow(/已被占用/);
    // Wait past one watchdog check cycle: a leaked timer would crash on the
    // TDZ bound `close` (uncaught exception fails the test runner).
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 10_000);
});

describe('Web transcript ownership (multi-agent merge regression)', () => {
  it('a subagent turn, text and tool events never merge into the main agent message', async () => {
    // Original incident: on a single session the main agent and 3 subagents ran
    // concurrently and all four event streams shared one liveAssistant, so the text was
    // split into two blocks alternating per chunk, the tool list merged into 97 entries
    // and the model badge spanned 4 rows. The fix: transcript events only accept
    // agentId=main and are bucketed by turnId.
    const control = makeFakeSession();
    const handle = await start(control);
    const emit = (event: Record<string, unknown>): void => control.emit(event as unknown as Event);

    emit({ type: 'turn.started', sessionId: 'session-1', agentId: 'main', turnId: 1 });
    emit({ type: 'assistant.delta', sessionId: 'session-1', agentId: 'main', turnId: 1, delta: '主代理A' });
    emit({ type: 'turn.started', sessionId: 'session-1', agentId: 'agent-0', turnId: 2 });
    emit({ type: 'assistant.delta', sessionId: 'session-1', agentId: 'agent-0', turnId: 2, delta: '子代理B' });
    emit({
      type: 'tool.call.started',
      sessionId: 'session-1',
      agentId: 'agent-0',
      turnId: 2,
      toolCallId: 'sub-tool',
      name: 'FetchURL',
      args: {},
    });
    emit({
      type: 'tool.result',
      sessionId: 'session-1',
      agentId: 'agent-0',
      turnId: 2,
      toolCallId: 'sub-tool',
      output: '子代理工具输出',
    });
    emit({ type: 'turn.ended', sessionId: 'session-1', agentId: 'agent-0', turnId: 2 });
    emit({ type: 'assistant.delta', sessionId: 'session-1', agentId: 'main', turnId: 1, delta: '主代理A2' });
    emit({ type: 'turn.ended', sessionId: 'session-1', agentId: 'main', turnId: 1 });

    const snapshot = await jsonRequest(handle.url, '/api/v1/sessions/session-1/snapshot');
    expect(snapshot.response.status).toBe(200);
    const messages = (snapshot.body as {
      messages: Array<{ role: string; content: string; tools: unknown[] }>;
    }).messages;
    const assistant = messages.filter((message) => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toBe('主代理A主代理A2');
    expect(assistant[0]!.tools).toHaveLength(0);
    expect(JSON.stringify(messages)).not.toContain('子代理');
  }, 10_000);
});
