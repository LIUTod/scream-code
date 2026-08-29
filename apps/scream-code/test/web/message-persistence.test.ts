import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, GoalSnapshotData, Session, SessionStatus, TodoItem } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionManager } from '#/web/server';

interface FakeSessionControl {
  readonly session: Session;
  emit: (event: Event) => void;
  readonly close: ReturnType<typeof vi.fn>;
}

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

function makeFakeSession(id: string): FakeSessionControl {
  const listeners = new Set<(event: Event) => void>();
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
    getGoal: vi.fn(async () => ({ goal: null as GoalSnapshotData | null })),
    getTodos: vi.fn(async () => [] as readonly TodoItem[]),
    generateText: vi.fn(async () => 'Refined objective'),
    close: vi.fn(async () => {}),
  };
  return {
    session: session as unknown as Session,
    emit: (event: Event) => {
      for (const listener of listeners) listener(event);
    },
    close: session.close as unknown as ReturnType<typeof vi.fn>,
  };
}

function makeHarness(resumed: FakeSessionControl) {
  return {
    createSession: vi.fn(),
    resumeSession: vi.fn(async () => resumed.session),
    forkSession: vi.fn(),
  };
}

async function newManager(homeDir: string, resumed: FakeSessionControl) {
  const manager = new SessionManager({
    harness: makeHarness(resumed) as never,
    homeDir,
    workDir: '/tmp/project',
    model: 'test-model',
    permission: 'manual',
    yolo: false,
  });
  await manager.init();
  return manager;
}

function turnEvents(control: FakeSessionControl, body: string, thinking: string): void {
  control.emit({ type: 'turn.started', turnId: 1, origin: 'web', sessionId: control.session.id, agentId: 'main' } as unknown as Event);
  control.emit({ type: 'assistant.delta', turnId: 1, delta: body, sessionId: control.session.id, agentId: 'main' } as unknown as Event);
  control.emit({ type: 'thinking.delta', turnId: 1, delta: thinking, sessionId: control.session.id, agentId: 'main' } as unknown as Event);
  control.emit({
    type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'bash',
    args: { command: 'ls' }, sessionId: control.session.id, agentId: 'main',
  } as unknown as Event);
  control.emit({
    type: 'tool.result', turnId: 1, toolCallId: 'tc1', output: 'a.txt',
    sessionId: control.session.id, agentId: 'main',
  } as unknown as Event);
  control.emit({ type: 'turn.ended', turnId: 1, reason: 'done', sessionId: control.session.id, agentId: 'main' } as unknown as Event);
}

/** Poll until the journal contains the given line fragment (persist is fire-and-forget). */
async function waitForJournal(homeDir: string, sessionId: string, fragment: string): Promise<string> {
  const path = join(homeDir, 'web-sessions', `${sessionId}.jsonl`);
  for (let i = 0; i < 100; i++) {
    try {
      const data = await readFile(path, 'utf-8');
      if (data.includes(fragment)) return data;
    } catch {
      // journal not written yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`journal never contained ${fragment}`);
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('web message persistence (finalized snapshots)', () => {
  it('persists a complete assistant snapshot and rebuilds it after a server restart', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-msg-'));
    tempDirs.push(homeDir);

    // ── First "server process": emit a full turn on the fake core session.
    const control = makeFakeSession('web-p1');
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-p1.meta.json'), JSON.stringify({
      sessionId: 'web-p1', coreSessionId: 'web-p1', workDir: '/tmp/project',
      title: 'First', createdAt: 1, model: 'test-model', permission: 'manual',
    }));
    const manager = await newManager(homeDir, control);
    const live = await manager.activateSession('web-p1');
    expect(live).not.toBeNull();

    turnEvents(control, '完整回答正文', '第一步思考内容');
    // Finalized must land on disk before we "crash".
    await waitForJournal(homeDir, 'web-p1', 'web.message.finalized');
    await manager.closeAll();

    // ── Second "server process": same homeDir, resume the core session.
    const restarted = makeFakeSession('web-p1');
    const manager2 = await newManager(homeDir, restarted);
    const restored = await manager2.activateSession('web-p1');
    expect(restored).not.toBeNull();

    const snapshot = restored!.getSnapshot();
    const assistants = snapshot.messages.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0]!.content).toBe('完整回答正文');
    expect(assistants[0]!.degraded).toBeUndefined();
    const thinking = assistants[0]!.tools.find((t) => t.name === 'thinking');
    expect(thinking?.output).toBe('第一步思考内容');
    const bash = assistants[0]!.tools.find((t) => t.name === 'bash');
    expect(bash?.output).toBe('a.txt');
    await manager2.closeAll();
  });

  it('marks pre-snapshot turns as degraded instead of rendering empty bodies', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-msg-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    // Legacy journal: turn skeleton + tool events but NO finalized snapshot
    // and no delta rows (volatile events never reached disk — the exact
    // on-disk shape of sessions created before the fix).
    const legacy = [
      { type: 'journal', seq: 0, epoch: 1, volatile: false, payload: { type: 'turn.started', turnId: 1, origin: 'web', sessionId: 'web-p2', agentId: 'main' } },
      { type: 'journal', seq: 1, epoch: 1, volatile: false, payload: { type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'bash', args: { command: 'ls' }, sessionId: 'web-p2', agentId: 'main' } },
      { type: 'journal', seq: 2, epoch: 1, volatile: false, payload: { type: 'tool.result', turnId: 1, toolCallId: 'tc1', output: 'ok', sessionId: 'web-p2', agentId: 'main' } },
      { type: 'journal', seq: 3, epoch: 1, volatile: false, payload: { type: 'turn.ended', turnId: 1, reason: 'done', sessionId: 'web-p2', agentId: 'main' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    await writeFile(join(sessionsDir, 'web-p2.jsonl'), legacy);
    await writeFile(join(sessionsDir, 'web-p2.meta.json'), JSON.stringify({
      sessionId: 'web-p2', coreSessionId: 'web-p2', workDir: '/tmp/project',
      title: 'Legacy', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const control = makeFakeSession('web-p2');
    const manager = await newManager(homeDir, control);
    const restored = await manager.activateSession('web-p2');
    expect(restored).not.toBeNull();

    const snapshot = restored!.getSnapshot();
    const assistant = snapshot.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('');
    expect(assistant!.degraded).toBe(true);
    expect(assistant!.tools.find((t) => t.name === 'bash')?.output).toBe('ok');
    await manager.closeAll();
  });
});
