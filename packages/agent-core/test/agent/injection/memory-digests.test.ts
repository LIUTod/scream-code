import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { MemoryDigestInjector } from '../../../src/agent/injection/memory-digests';
import type { ContextMessage } from '../../../src/agent/context/types';
import type { DigestKind, DigestStatus, MemoryDigest } from '@scream-code/memory';
import { testJian } from '../../fixtures/test-jian';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_TAG = '更新于 2026-10';

interface DigestQuery {
  kinds?: DigestKind[];
  status?: DigestStatus;
  limit?: number;
}

interface StubState {
  history: ContextMessage[];
}

interface StubStore {
  listDigests(options?: DigestQuery): Promise<MemoryDigest[]>;
  touchDigestHits(ids: string[]): Promise<void>;
}

function makeAgent(state: StubState, store?: StubStore, cwd = '/work/project'): Agent {
  return {
    type: 'main',
    jian: testJian,
    config: { cwd },
    memoStore: store,
    context: {
      history: state.history,
      appendSystemReminder: (content: string, origin: unknown) => {
        state.history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin: origin as ContextMessage['origin'],
        });
      },
    },
  } as unknown as Agent;
}

function makeStore(digests: MemoryDigest[]): {
  store: StubStore;
  queries: DigestQuery[];
  touched: string[][];
} {
  const queries: DigestQuery[] = [];
  const touched: string[][] = [];
  return {
    store: {
      listDigests: async (options?: DigestQuery) => {
        queries.push(options ?? {});
        return digests;
      },
      touchDigestHits: async (ids: string[]) => {
        touched.push(ids);
      },
    },
    queries,
    touched,
  };
}

let sequence = 0;

function makeDigest(
  overrides: Partial<MemoryDigest> & Pick<MemoryDigest, 'kind' | 'statement'>,
): MemoryDigest {
  sequence += 1;
  return {
    id: `digest-${sequence}`,
    topic: `topic-${sequence}`,
    confidence: 'high',
    evidence: [],
    evidenceFrom: Date.now(),
    evidenceTo: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.UTC(2026, 9, 15),
    lastConfirmedAt: Date.now(),
    hitCount: 0,
    status: 'active',
    ...overrides,
  };
}

function daysAgo(days: number): number {
  return Date.now() - days * DAY_MS;
}

function userPrompt(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function assistant(text: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function memoryInjections(state: StubState): string[] {
  return state.history
    .filter((m) => m.origin?.kind === 'injection' && m.origin?.variant === 'memory_digests')
    .map((m) => (m.content[0] as { text: string }).text);
}

function bodyOf(message: string): string {
  return message
    .replace(/^<system-reminder>\n/, '')
    .replace(/\n<\/system-reminder>$/, '');
}

describe('MemoryDigestInjector', () => {
  it('injects the top five active fact/procedure/pitfall cards with their date', async () => {
    const digests = [
      makeDigest({ kind: 'fact', statement: 'pnpm 是包管理器', lastConfirmedAt: daysAgo(1) }),
      makeDigest({
        kind: 'procedure',
        statement: '发版流程：先跑 typecheck',
        lastConfirmedAt: daysAgo(5),
      }),
      makeDigest({
        kind: 'pitfall',
        statement: '不要手改 dist 产物',
        lastConfirmedAt: daysAgo(10),
      }),
      makeDigest({ kind: 'fact', statement: 'Node 22 才有 node:sqlite', lastConfirmedAt: daysAgo(20) }),
      makeDigest({
        kind: 'procedure',
        statement: '改 injector 时同步更新 manager',
        lastConfirmedAt: daysAgo(30),
      }),
      makeDigest({ kind: 'fact', statement: '这张太旧不应注入', lastConfirmedAt: daysAgo(400) }),
    ];
    const { store, queries } = makeStore(digests);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();

    expect(queries).toEqual([
      { status: 'active', kinds: ['fact', 'procedure', 'pitfall'], limit: 200 },
    ]);
    const injections = memoryInjections(state);
    expect(injections).toHaveLength(1);
    const body = bodyOf(injections[0]!);
    const lines = body.split('\n');
    expect(lines[0]).toBe('MEMORY DIGESTS (from /dream):');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe('- [fact · 更新于 2026-10] pnpm 是包管理器');
    expect(lines[2]).toContain('[procedure · 更新于 2026-10]');
    expect(lines[3]).toContain('[pitfall ·');
    expect(body).not.toContain('这张太旧不应注入');
    expect(body).toContain(MONTH_TAG);
  });

  it('excludes preference digests', async () => {
    const preference = makeDigest({
      kind: 'preference',
      statement: '用户偏好：回答要简短',
      lastConfirmedAt: daysAgo(1),
    });
    const fact = makeDigest({ kind: 'fact', statement: '真实事实卡', lastConfirmedAt: daysAgo(2) });
    const { store } = makeStore([preference, fact]);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();

    const body = bodyOf(memoryInjections(state)[0]!);
    expect(body).toContain('真实事实卡');
    expect(body).not.toContain('用户偏好：回答要简短');
  });

  it('returns null when there are no digests', async () => {
    const { store } = makeStore([]);
    const state: StubState = { history: [] };
    await new MemoryDigestInjector(makeAgent(state, store)).inject();
    expect(state.history).toHaveLength(0);

    const noStoreState: StubState = { history: [] };
    await new MemoryDigestInjector(makeAgent(noStoreState)).inject();
    expect(noStoreState.history).toHaveLength(0);
  });

  it('truncates to the line and character budget', async () => {
    const digests = Array.from({ length: 6 }, (_, index) =>
      makeDigest({
        kind: 'fact',
        statement: `卡 ${index}：${'长'.repeat(5000)}`,
        lastConfirmedAt: daysAgo(index),
      }),
    );
    const { store } = makeStore(digests);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();

    const body = bodyOf(memoryInjections(state)[0]!);
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body.split('\n').length).toBeLessThanOrEqual(40);
    for (const line of body.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(700);
    }
    expect(body).toContain('…');
  });

  it('ranks project-matching and fresher cards first', async () => {
    const projectFresh = makeDigest({
      kind: 'procedure',
      statement: 'P-fresh 项目内最新',
      appliesTo: '/work/project',
      lastConfirmedAt: daysAgo(0),
    });
    const globalFresh = makeDigest({
      kind: 'procedure',
      statement: 'G-fresh 全局最新',
      lastConfirmedAt: daysAgo(1),
    });
    const projectStale = makeDigest({
      kind: 'procedure',
      statement: 'P-old 项目内陈旧',
      appliesTo: '/work/project/packages/app',
      lastConfirmedAt: daysAgo(180),
    });
    const globalStale = makeDigest({
      kind: 'procedure',
      statement: 'G-old 全局陈旧',
      lastConfirmedAt: daysAgo(180),
    });
    const foreign = makeDigest({
      kind: 'procedure',
      statement: '其他项目的最新卡',
      appliesTo: '/work/other',
      lastConfirmedAt: daysAgo(0),
    });
    const { store } = makeStore([projectStale, globalStale, foreign, globalFresh, projectFresh]);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();

    const body = bodyOf(memoryInjections(state)[0]!);
    const order = ['P-fresh', 'G-fresh', 'P-old', 'G-old'].map((marker) => body.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(body).not.toContain('其他项目的最新卡');
  });

  it('records hits for the injected digests', async () => {
    const first = makeDigest({ kind: 'fact', statement: 'A', lastConfirmedAt: daysAgo(1) });
    const second = makeDigest({ kind: 'fact', statement: 'B', lastConfirmedAt: daysAgo(2) });
    const { store, touched } = makeStore([first, second]);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();

    expect(touched).toEqual([[first.id, second.id]]);

    // No new user prompt → no re-injection → no additional hit bookkeeping.
    await injector.inject();
    expect(touched).toHaveLength(1);
  });

  it('does not re-inject before a new user prompt arrives', async () => {
    const { store } = makeStore([
      makeDigest({ kind: 'fact', statement: 'reusable rule', lastConfirmedAt: daysAgo(1) }),
    ]);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();
    state.history.push(assistant('working'));
    await injector.inject();

    expect(memoryInjections(state)).toHaveLength(1);
  });

  it('re-injects after a new prompt when the cards changed', async () => {
    const digests = [
      makeDigest({ kind: 'fact', statement: 'first rule', lastConfirmedAt: daysAgo(2) }),
    ];
    const { store } = makeStore(digests);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();
    digests.push(makeDigest({ kind: 'fact', statement: 'second rule', lastConfirmedAt: daysAgo(1) }));
    state.history.push(assistant('ok'));
    state.history.push(userPrompt('next task'));
    await injector.inject();

    const injections = memoryInjections(state);
    expect(injections).toHaveLength(2);
    expect(bodyOf(injections[1]!)).toContain('second rule');
  });
});

describe('subagent and truncation guards', () => {
  it('never injects into subagents', async () => {
    const { store } = makeStore([makeDigest({ kind: 'fact', statement: '只给主 agent' })]);
    const state: StubState = { history: [] };
    const agent = makeAgent(state, store);
    (agent as unknown as { type: string }).type = 'sub';
    const injector = new MemoryDigestInjector(agent);

    await injector.inject();

    expect(state.history).toHaveLength(0);
  });

  it('never splits a surrogate pair when truncating a statement', async () => {
    const statement = `${'a'.repeat(598)}😀${'b'.repeat(10)}`;
    const { store } = makeStore([makeDigest({ kind: 'procedure', statement })]);
    const state: StubState = { history: [] };
    const injector = new MemoryDigestInjector(makeAgent(state, store));

    await injector.inject();

    const body = bodyOf(memoryInjections(state)[0]!);
    // A lone high surrogate would mean the cut landed mid-pair.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body)).toBe(false);
    expect(body).toContain('😀');
    expect(body).toContain('…');
  });
});
