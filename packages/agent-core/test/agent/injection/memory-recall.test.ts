import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { createMemoryMemo, MemoryMemoStore, type EmbeddingEngine, type MemoryMemo } from '@scream-code/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { MEMORY_RECALL_VARIANT, MemoryRecallInjector, renderRecall } from '../../../src/agent/injection/memory-recall';

const PROJECT = '/work/app';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Every query embeds to [1, 0]; a memo's vector sets its similarity. */
const engine: EmbeddingEngine = {
  available: true,
  modelName: 'stub',
  embedBatch: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
  cosineSimilarity: cosine,
  ensureReady: async () => true,
};

let dir: string;
let store: MemoryMemoStore;
let seq = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scream-recall-injector-'));
  store = new MemoryMemoStore(dir);
  await store.init();
  store.setEmbeddingEngine(engine);
  seq = 0;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function memo(similarity: number, overrides: Partial<MemoryMemo> = {}, turn = 0): Promise<MemoryMemo> {
  seq += 1;
  const entry = createMemoryMemo({
    id: `memo-t${String(seq)}-x`,
    userNeed: `need ${String(seq)}`,
    approach: 'approach',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: `worked ${String(seq)}`,
    extractionSource: 'compaction',
    sourceSessionId: `session-${String(seq)}`,
    projectDir: PROJECT,
    ...overrides,
  });
  await store.append(entry);
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model, created_at) VALUES (?, ?, ?, ?)').run(
    entry.id,
    JSON.stringify([similarity, Math.sqrt(1 - similarity * similarity) * Math.cos(turn), Math.sqrt(1 - similarity * similarity) * Math.sin(turn)]),
    'stub',
    Date.now() + seq,
  );
  return entry;
}

async function background(): Promise<void> {
  for (let i = 0; i < 8; i++) await memo(0.5 + (i % 5) * 0.01);
}

function user(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } } as ContextMessage;
}
function assistant(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] } as ContextMessage;
}

function fakeAgent(history: ContextMessage[], overrides: Record<string, unknown> = {}) {
  const agent = {
    type: 'main',
    memoStore: store,
    config: { cwd: PROJECT },
    homedir: '/home/.scream-code/sessions/wd/session-asking/agents/main',
    log: { warn: vi.fn() },
    emitEvent: vi.fn(),
    ensureMemoryEngine: vi.fn(async () => true),
    context: {
      history,
      appendSystemReminder: (content: string, origin: ContextMessage['origin']) => {
        history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin,
        } as ContextMessage);
      },
    },
    ...overrides,
  };
  return agent as unknown as Agent & { ensureMemoryEngine: ReturnType<typeof vi.fn> };
}

function recallBlocks(history: readonly ContextMessage[]): string[] {
  return history
    .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === MEMORY_RECALL_VARIANT)
    .map((message) => (message.content[0] as { text: string }).text);
}

describe('MemoryRecallInjector', () => {
  it('brings a fitting memory back right after the prompt, once, and counts it', async () => {
    await background();
    const fits = await memo(0.82, { distilled: 'Retry the login test with a fresh browser profile' });
    const history = [user('the login test is flaky again')];
    const agent = fakeAgent(history);
    const injector = new MemoryRecallInjector(agent);

    await injector.inject();
    const blocks = recallBlocks(history);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(`[${fits.id} · `);
    expect(blocks[0]).toContain('Rule: Retry the login test with a fresh browser profile');
    expect(blocks[0]).toContain('hints, not facts');
    await vi.waitFor(async () => {
      expect((await store.get(fits.id))?.recallCount).toBe(1);
    });
    // The host hears about it, so it can say so in one quiet line.
    expect((agent as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent).toHaveBeenCalledWith({
      type: 'memory.recalled',
      count: 1,
      memoIds: [fits.id],
    });

    // A later step of the same turn: the prompt was already handled, so it is
    // not even searched again.
    await injector.inject();
    expect(recallBlocks(history)).toHaveLength(1);
    expect(agent.ensureMemoryEngine).toHaveBeenCalledTimes(1);
  });

  it('recalls nothing for a turn that no new prompt started', async () => {
    await background();
    await memo(0.82);
    const history = [user('the login test is flaky again'), assistant('Fixed.')];
    const injector = new MemoryRecallInjector(fakeAgent(history));
    await injector.inject();
    expect(recallBlocks(history)).toEqual([]);
  });

  it('never shows a memory twice in one conversation, also after a resume', async () => {
    await background();
    const first = await memo(0.85);
    const second = await memo(0.8, {}, Math.PI);
    const history = [user('the login test is flaky again')];
    await new MemoryRecallInjector(fakeAgent(history)).inject();
    expect(recallBlocks(history)[0]).toContain(first.id);
    expect(recallBlocks(history)[0]).toContain(second.id);

    history.push(assistant('Done.'), user('and the signup test is flaky too'));
    // A new injector, as after reopening the session: the ids come from history.
    await new MemoryRecallInjector(fakeAgent(history)).inject();
    expect(recallBlocks(history)).toHaveLength(1);
  });

  it('answers a steer like a new prompt', async () => {
    await background();
    const fits = await memo(0.82);
    const history = [user('look at the build'), assistant('Looking.')];
    const injector = new MemoryRecallInjector(fakeAgent(history));
    await injector.inject();
    expect(recallBlocks(history)).toEqual([]);
    history.push(user('actually the login test is flaky'));
    await injector.inject();
    expect(recallBlocks(history)[0]).toContain(fits.id);
  });

  it('leaves out the asking session\'s own memories', async () => {
    await background();
    await memo(0.9, { sourceSessionId: 'session-asking' });
    const history = [user('the login test is flaky again')];
    await new MemoryRecallInjector(fakeAgent(history)).inject();
    expect(recallBlocks(history)).toEqual([]);
  });

  it('stays out of subagents and needs the model ready', async () => {
    await background();
    await memo(0.9);
    const history = [user('the login test is flaky again')];
    await new MemoryRecallInjector(fakeAgent(history, { type: 'sub' })).inject();
    expect(recallBlocks(history)).toEqual([]);
    const agent = fakeAgent(history, { ensureMemoryEngine: vi.fn(async () => false) });
    await new MemoryRecallInjector(agent).inject();
    expect(recallBlocks(history)).toEqual([]);
    expect(agent.ensureMemoryEngine).toHaveBeenCalledWith({ projectDir: PROJECT });
  });
});

describe('renderRecall', () => {
  function recalled(overrides: Partial<MemoryMemo>, sameProject = true) {
    return {
      memo: createMemoryMemo({
        id: 'memo-a-1',
        userNeed: 'Fix the flaky login test',
        approach: 'a',
        outcome: '完成',
        whatFailed: 'none',
        whatWorked: 'Use a fresh browser profile',
        extractionSource: 'compaction',
        sourceSessionId: 's',
        projectDir: PROJECT,
        recordedAt: new Date(2026, 10, 12, 9).getTime(),
        ...overrides,
      }),
      similarity: 0.8,
      sameProject,
    };
  }

  it('shows the fields that carry a lesson, in the language they were written in', () => {
    const text = renderRecall([recalled({ whatFailed: '重跑三次也没用', note: 'none' })]);
    expect(text.startsWith('<memories>\n')).toBe(true);
    expect(text.endsWith('</memories>')).toBe(true);
    expect(text).toContain('[memo-a-1 · 2026-11-12]');
    expect(text).toContain('Need: Fix the flaky login test');
    expect(text).toContain('Worked: Use a fresh browser profile');
    expect(text).toContain('Failed: 重跑三次也没用');
    expect(text).not.toContain('Note:');
    expect(text).not.toContain('Rule:');
  });

  it('names another project and keeps the block small', () => {
    const long = 'x'.repeat(2000);
    const text = renderRecall([
      recalled({ id: 'memo-a-1', whatWorked: long }),
      recalled({ id: 'memo-b-2', projectDir: '/work/other-repo' }, false),
      recalled({ id: 'memo-c-3', whatWorked: long }),
    ]);
    expect(text).toContain('[memo-b-2 · 2026-11-12 · project other-repo]');
    // Fields are clipped, so the best memo always fits and the rest share the budget.
    expect(text).toContain('memo-a-1');
    expect(text.length).toBeLessThan(2200);
  });
});
