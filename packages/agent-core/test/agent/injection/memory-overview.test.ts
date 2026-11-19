import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { MEMORY_OVERVIEW_VARIANT, MemoryOverviewInjector, renderOverview } from '../../../src/agent/injection/memory-overview';

function user(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } } as ContextMessage;
}

function agentWith(memos: Array<{ projectDir: string; tags?: string[] }>, history: ContextMessage[], type = 'main') {
  return {
    type,
    config: { cwd: '/work/app' },
    memoStoreReady: Promise.resolve(),
    log: { warn: vi.fn() },
    memoStore: {
      read: async function* () {
        for (const memo of memos) yield memo;
      },
    },
    context: {
      history,
      appendSystemReminder: (content: string, origin: ContextMessage['origin']) => {
        history.push({ role: 'user', content: [{ type: 'text', text: content }], toolCalls: [], origin } as ContextMessage);
      },
    },
  } as unknown as Agent;
}

const overviews = (history: readonly ContextMessage[]) =>
  history.filter((message) => message.origin?.kind === 'injection' && message.origin.variant === MEMORY_OVERVIEW_VARIANT);

describe('MemoryOverviewInjector', () => {
  it('tells the model once what it remembers, with this project\'s topics', async () => {
    const history = [user('what should I watch out for building an agent CLI?')];
    const injector = new MemoryOverviewInjector(
      agentWith(
        [
          { projectDir: '/work/app', tags: ['tui', 'i18n'] },
          { projectDir: '/work/app/packages/core', tags: ['tui'] },
          { projectDir: '/work/other', tags: ['docker'] },
        ],
        history,
      ),
    );
    await injector.inject();
    const [block] = overviews(history);
    const text = (block!.content[0] as { text: string }).text;
    expect(text).toContain('You remember 3 experiences from earlier sessions (2 from this project).');
    expect(text).toContain('Frequent topics: tui (2), i18n (1).');
    expect(text).not.toContain('docker');
    expect(text).toContain('call MemoryLookup before answering');
    // Later prompts of the same conversation do not repeat it.
    history.push(user('and the next thing?'));
    await injector.inject();
    expect(overviews(history)).toHaveLength(1);
  });

  it('is not repeated after a resume, and says nothing without memories or for subagents', async () => {
    const history = [user('q')];
    await new MemoryOverviewInjector(agentWith([{ projectDir: '/work/app' }], history)).inject();
    history.push(user('again'));
    await new MemoryOverviewInjector(agentWith([{ projectDir: '/work/app' }], history)).inject();
    expect(overviews(history)).toHaveLength(1);

    const empty = [user('q')];
    await new MemoryOverviewInjector(agentWith([], empty)).inject();
    expect(overviews(empty)).toEqual([]);
    const sub = [user('q')];
    await new MemoryOverviewInjector(agentWith([{ projectDir: '/work/app' }], sub, 'sub')).inject();
    expect(overviews(sub)).toEqual([]);
  });

  it('caps the topics and falls back to every memory\'s topics when none is from this project', () => {
    const tags = new Map(Array.from({ length: 12 }, (_, i) => [`t${String(i).padStart(2, '0')}`, 12 - i] as [string, number]));
    const text = renderOverview(12, 0, tags);
    expect(text).toContain('(0 from this project)');
    expect(text).toContain('t07 (5)');
    expect(text).not.toContain('t08');
  });
});
