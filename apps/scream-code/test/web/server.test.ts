import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ErrorCodes,
  ScreamError,
  type Event,
  type GoalSnapshotData,
  type Session,
  type SessionStatus,
  type TodoItem,
} from '@scream-code/scream-code-sdk';
import { encodeWorkDirKey } from '@scream-code/agent-core';
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
