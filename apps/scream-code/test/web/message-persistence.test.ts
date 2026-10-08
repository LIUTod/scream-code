import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ContextMessage, Event, GoalSnapshotData, Session, SessionStatus, TodoItem } from '@scream-code/scream-code-sdk';
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

function makeFakeSession(
  id: string,
  getContext?: () => Promise<{ history: readonly ContextMessage[]; tokenCount: number }>,
): FakeSessionControl {
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
    // The activation/fork seed paths read the core wire history; without a
    // provider the call throws and is swallowed by those paths' catch.
    ...(getContext ? { getContext: vi.fn(getContext) } : {}),
  };
  return {
    session: session as unknown as Session,
    emit: (event: Event) => {
      for (const listener of listeners) listener(event);
    },
    close: session.close as unknown as ReturnType<typeof vi.fn>,
  };
}

function makeHarness(resumed: FakeSessionControl, forked?: FakeSessionControl) {
  return {
    createSession: vi.fn(),
    resumeSession: vi.fn(async () => resumed.session),
    forkSession: vi.fn(async () => forked?.session),
  };
}

async function newManager(homeDir: string, resumed: FakeSessionControl, forked?: FakeSessionControl) {
  const manager = new SessionManager({
    harness: makeHarness(resumed, forked) as never,
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

  it('drains in-flight metadata writes before close resolves', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-msg-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-p3.meta.json'), JSON.stringify({
      sessionId: 'web-p3', coreSessionId: 'web-p3', workDir: '/tmp/project',
      title: 'Stale', createdAt: 1, model: 'test-model', permission: 'manual',
    }));
    const control = makeFakeSession('web-p3');
    const manager = await newManager(homeDir, control);
    const live = await manager.activateSession('web-p3');
    expect(live).not.toBeNull();

    // A finished turn fires the fire-and-forget title/metadata update. The
    // journal line landing is NOT sufficient to prove the meta write is done;
    // close() itself must drain it.
    turnEvents(control, '正文内容', '思考内容');
    await waitForJournal(homeDir, 'web-p3', 'web.message.finalized');
    await manager.closeAll();

    const raw = await readFile(join(sessionsDir, 'web-p3.meta.json'), 'utf-8');
    const meta = JSON.parse(raw) as { title: string };
    // Derived from the (user-message-less) transcript; proves the pending
    // saveMetadata finished and the file was never observed half-written.
    expect(meta.title).toBe('New Session');
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

describe('web journal / message FIFO caps', () => {
  it('truncates the journal past 200 entries and counts the elided rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-cap-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'web-cap.meta.json'),
      JSON.stringify({
        sessionId: 'web-cap',
        coreSessionId: 'web-cap',
        workDir: '/tmp/project',
        title: 'Cap',
        createdAt: 1,
        model: 'test-model',
        permission: 'manual',
      }),
    );
    const control = makeFakeSession('web-cap');
    const manager = await newManager(homeDir, control);
    const live = await manager.activateSession('web-cap');
    expect(live).not.toBeNull();

    // 250 journaled events (each turn.* / custom payload hits appendEvent).
    for (let i = 0; i < 250; i++) {
      control.emit({
        type: 'session.meta.updated',
        turnId: 0,
        sessionId: 'web-cap',
        agentId: 'main',
        meta: { tick: i },
      } as unknown as Event);
    }

    const bounds = live!.getMemoryBounds();
    expect(bounds.journal).toBeLessThanOrEqual(200);
    expect(bounds.journalLimit).toBe(200);
    // FIFO: 250 in, 200 kept → 50 elided and tallied.
    expect(bounds.journalElided).toBeGreaterThanOrEqual(50);
    expect(bounds.messages).toBeLessThanOrEqual(200);
    expect(bounds.messagesElided).toBe(0);
    await manager.closeAll();
  });

  it('truncates message stores past 200 rows and counts the elided rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-msgcap-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'web-msgcap.meta.json'),
      JSON.stringify({
        sessionId: 'web-msgcap',
        coreSessionId: 'web-msgcap',
        workDir: '/tmp/project',
        title: 'MsgCap',
        createdAt: 1,
        model: 'test-model',
        permission: 'manual',
      }),
    );
    const control = makeFakeSession('web-msgcap');
    const manager = await newManager(homeDir, control);
    const live = await manager.activateSession('web-msgcap');
    expect(live).not.toBeNull();

    // 250 seeded message rows → message store FIFO-caps at 200 with a tally.
    live!.seedHistory(
      Array.from({ length: 250 }, (_, i) => ({
        role: 'user' as const,
        content: `user-${i}`,
        tools: [],
      })),
    );

    const bounds = live!.getMemoryBounds();
    expect(bounds.messages).toBeLessThanOrEqual(200);
    expect(bounds.messageLimit).toBe(200);
    expect(bounds.messagesElided).toBeGreaterThanOrEqual(50);
    // FIFO means the oldest rows go: the surviving window is the newest 200
    // (user-0..user-49 dropped), so the visible tail of the chat survives.
    const { messages } = live!.getMessagesOlder(Number.MAX_SAFE_INTEGER, 200);
    expect(messages).toHaveLength(200);
    expect(messages[0]?.content).toBe('user-50');
    expect(messages.at(-1)?.content).toBe('user-249');
    await manager.closeAll();
  });
});

describe('web fork journal copy', () => {
  it('copies the source\'s complete on-disk journal, not the capped in-memory tail', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-fork-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'web-big.meta.json'), JSON.stringify({
      sessionId: 'web-big', coreSessionId: 'web-big', workDir: '/tmp/project',
      title: 'Big', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const source = makeFakeSession('web-big');
    const forked = makeFakeSession('core-fork-big');
    const manager = await newManager(homeDir, source, forked);
    const live = await manager.activateSession('web-big');
    expect(live).not.toBeNull();

    // 60 complete turns: 5 durable rows each (turn.started / tool.call.started /
    // tool.result / finalized snapshot / turn.ended) plus two volatile deltas.
    // The source's file ends up with 300 durable rows while its in-memory
    // journal is FIFO-capped at 200 rows — and since volatile deltas occupy
    // cap slots, the in-memory window covers far fewer turns than 200 durable
    // rows would.
    for (let i = 0; i < 60; i++) turnEvents(source, `正文-${i}`, `思考-${i}`);
    // Fence: appends are serialized per file in arrival order (journal-writer),
    // so once the fence row is readable every earlier durable row is on disk.
    const fence = 'fence-after-60-turns';
    source.emit({
      type: 'session.meta.updated', turnId: 0, sessionId: 'web-big', agentId: 'main', meta: { marker: fence },
    } as unknown as Event);
    const sourceJournal = await waitForJournal(homeDir, 'web-big', fence);
    const sourceLines = sourceJournal.split('\n').filter((line) => line.trim().length > 0);
    expect(sourceLines.length).toBeGreaterThan(200);
    expect(sourceJournal).toContain('正文-0');

    const result = await manager.forkSession('web-big');
    expect(result).not.toBeNull();

    // The fork's journal file is the source's whole history: neither its head
    // (dropped by the in-memory FIFO) nor its tail is lost.
    const forkJournal = await readFile(join(sessionsDir, `${result!.sessionId}.jsonl`), 'utf-8');
    const forkLines = forkJournal.split('\n').filter((line) => line.trim().length > 0);
    expect(forkLines.length).toBe(sourceLines.length);
    expect(forkJournal).toContain('正文-0');
    expect(forkJournal).toContain(fence);

    // The fork's transcript shows the same history a reload of the source
    // shows under the same in-memory caps; the capped memory copy reached only
    // a later turn and silently dropped everything before it.
    const restarted = makeFakeSession('web-big');
    const reloadManager = await newManager(homeDir, restarted);
    const reloaded = await reloadManager.activateSession('web-big');
    expect(reloaded).not.toBeNull();
    const reloadContents = reloaded!.getSnapshot().messages.map((message) => message.content);
    const forkContents = manager.get(result!.sessionId)?.getSnapshot().messages.map((message) => message.content);
    expect(reloadContents.length).toBeGreaterThan(0);
    expect(forkContents).toEqual(reloadContents);
    expect(forkContents).toContain('正文-20');

    await reloadManager.closeAll();
    await manager.closeAll();
  });

  it('copies every user message once when memory and disk both carry it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-forkum-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });
    // A resumed conversation: the journal holds user rows (the fork copy reads
    // them from disk) and the activation path loads them back into memory as
    // well — the copy must not double any of them.
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      // The user row is persisted before its turn and carries the seq the turn
      // then receives (buildMessages interleaves by beforeSeq).
      lines.push(JSON.stringify({
        type: 'user_message', text: `提问-${i}`, beforeSeq: i * 2, clientMessageId: `cm-${i}`,
      }));
      lines.push(JSON.stringify({
        type: 'journal', seq: i * 2, epoch: 1, volatile: false,
        payload: { type: 'turn.started', turnId: i, origin: 'web', sessionId: 'web-um', agentId: 'main' },
      }));
      lines.push(JSON.stringify({
        type: 'journal', seq: i * 2 + 1, epoch: 1, volatile: false,
        payload: { type: 'web.message.finalized', message: { role: 'assistant', content: `回答-${i}`, tools: [] } },
      }));
    }
    await writeFile(join(sessionsDir, 'web-um.jsonl'), lines.join('\n') + '\n');
    await writeFile(join(sessionsDir, 'web-um.meta.json'), JSON.stringify({
      sessionId: 'web-um', coreSessionId: 'web-um', workDir: '/tmp/project',
      title: 'UserMsgs', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const source = makeFakeSession('web-um');
    const manager = await newManager(homeDir, source, makeFakeSession('core-fork-um'));
    const live = await manager.activateSession('web-um');
    expect(live).not.toBeNull();
    const transcript = ['提问-0', '回答-0', '提问-1', '回答-1', '提问-2', '回答-2'];
    expect(live!.getSnapshot().messages.map((message) => message.content)).toEqual(transcript);

    const result = await manager.forkSession('web-um');
    expect(result).not.toBeNull();
    const forkJournal = await readFile(join(sessionsDir, `${result!.sessionId}.jsonl`), 'utf-8');
    expect(forkJournal.split('\n').filter((line) => line.includes('"user_message"'))).toHaveLength(3);
    expect(manager.get(result!.sessionId)?.getSnapshot().messages.map((message) => message.content))
      .toEqual(transcript);
    await manager.closeAll();
  });
});

/**
 * Forking a session whose journal file is damaged (byte-interleaving damage,
 * see journal-writer.ts): the lines that still parse are bodyless shells — a
 * user row and a turn skeleton whose assistant body line never made it. The
 * activation path drops those remnants and rebuilds from the core transcript;
 * the fork copies from the same file and has to walk the same guard, or it
 * inherits the damage: its shell rows count as message-bearing and suppress
 * the seed, so the source shows its history while the fork shows an empty hull.
 */
describe('web fork from a damaged journal', () => {
  it('mirrors the activation damage guard instead of copying the bodyless shells', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-forkdmg-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });

    // What still parses: a user row and a turn skeleton (its finalized body
    // never made it to disk). The other two lines are what the damage left —
    // unparseable, hence the corrupt tally.
    const damaged = [
      JSON.stringify({ type: 'user_message', text: '残存提问', beforeSeq: 0, clientMessageId: 'cm-dmg' }),
      JSON.stringify({
        type: 'journal', seq: 1, epoch: 1, volatile: false,
        payload: { type: 'turn.started', turnId: 0, origin: 'web', sessionId: 'web-dmg', agentId: 'main' },
      }),
      '{"type":"journal","seq":2,"epoch":1,"volatile":false,"payl',
      JSON.stringify({
        type: 'journal', seq: 3, epoch: 1, volatile: false,
        payload: { type: 'turn.ended', turnId: 0, reason: 'done', sessionId: 'web-dmg', agentId: 'main' },
      }),
      '\u0000\u0001interleaved-garbage',
    ].join('\n') + '\n';
    await writeFile(join(sessionsDir, 'web-dmg.jsonl'), damaged);
    await writeFile(join(sessionsDir, 'web-dmg.meta.json'), JSON.stringify({
      sessionId: 'web-dmg', coreSessionId: 'core-dmg', workDir: '/tmp/project',
      title: 'Dmg', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const history: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '源历史提问' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: '源历史回答' }], toolCalls: [] },
    ];
    const source = makeFakeSession('core-dmg', async () => ({ history, tokenCount: 2 }));
    const forked = makeFakeSession('core-fork-dmg', async () => ({ history, tokenCount: 2 }));
    const manager = await newManager(homeDir, source, forked);

    // Reference: activating the damaged source drops the bodyless remnants
    // (the surviving user row included) and rebuilds from the core transcript.
    const live = await manager.activateSession('web-dmg');
    expect(live).not.toBeNull();
    const activated = live!.getSnapshot().messages.map((m) => m.content);
    expect(activated).toEqual(['源历史提问', '源历史回答']);

    const result = await manager.forkSession('web-dmg');
    expect(result).not.toBeNull();
    const forkContents = manager.get(result!.sessionId)?.getSnapshot().messages.map((m) => m.content);
    // Exactly the activated source's history — seed included — not the shells.
    expect(forkContents).toEqual(activated);
    expect(forkContents).toContain('源历史回答');

    // And the durability holds: a fresh server must not repaint the shells
    // from a journal file the fork copied the damage into.
    const restarted = makeFakeSession('core-fork-dmg', async () => ({ history, tokenCount: 2 }));
    const reloadManager = await newManager(homeDir, restarted);
    const reloaded = await reloadManager.activateSession(result!.sessionId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.getSnapshot().messages.map((m) => m.content)).toEqual(activated);

    await reloadManager.closeAll();
    await manager.closeAll();
  });

  it('writes no damaged remnants into the fork journal when no parsed entry carries a message', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'scream-web-forkdmg2-'));
    tempDirs.push(homeDir);
    const sessionsDir = join(homeDir, 'web-sessions');
    await mkdir(sessionsDir, { recursive: true });

    // No message-bearing entry at all: only a state row survived the damage.
    const damaged = [
      JSON.stringify({
        type: 'journal', seq: 5, epoch: 1, volatile: false,
        payload: {
          type: 'session.meta.updated', turnId: 0, sessionId: 'web-dmgstate', agentId: 'main',
          meta: { marker: 'remnant' },
        },
      }),
      '{"type":"journal","seq":6,"epoch":1,"volatile":false,"payl',
    ].join('\n') + '\n';
    await writeFile(join(sessionsDir, 'web-dmgstate.jsonl'), damaged);
    await writeFile(join(sessionsDir, 'web-dmgstate.meta.json'), JSON.stringify({
      sessionId: 'web-dmgstate', coreSessionId: 'core-dmgstate', workDir: '/tmp/project',
      title: 'DmgState', createdAt: 1, model: 'test-model', permission: 'manual',
    }));

    const history: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '源历史提问' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: '源历史回答' }], toolCalls: [] },
    ];
    const source = makeFakeSession('core-dmgstate', async () => ({ history, tokenCount: 2 }));
    const forked = makeFakeSession('core-fork-dmgstate', async () => ({ history, tokenCount: 2 }));
    const manager = await newManager(homeDir, source, forked);

    const live = await manager.activateSession('web-dmgstate');
    expect(live).not.toBeNull();
    const activated = live!.getSnapshot().messages.map((m) => m.content);
    expect(activated).toEqual(['源历史提问', '源历史回答']);

    const result = await manager.forkSession('web-dmgstate');
    expect(result).not.toBeNull();
    expect(manager.get(result!.sessionId)?.getSnapshot().messages.map((m) => m.content)).toEqual(activated);
    // The damaged remnants must not become the fork's durable journal: those
    // rows reserialize as valid lines (no corrupt tally to rearm the guard),
    // so a later load would present the dead state as the fork's history.
    let forkJournal = '';
    try {
      forkJournal = await readFile(join(sessionsDir, `${result!.sessionId}.jsonl`), 'utf-8');
    } catch {
      // No file written — there was nothing trustworthy to copy.
    }
    expect(forkJournal).not.toContain('web-dmgstate');
    await manager.closeAll();
  });
});
