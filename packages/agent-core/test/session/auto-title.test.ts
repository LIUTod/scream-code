import { describe, expect, it, vi } from 'vitest';

import { EventSubscriptionBus } from '#/agent/events';
import type { ContextMessage } from '#/agent/context/types';
import {
  SessionAutoTitle,
  TITLE_ATTEMPTS_KEY,
  TITLE_SOURCE_KEY,
  buildTitleExcerpt,
  normalizeTitle,
  parseTitleAnswer,
  wantsModelTitle,
} from '#/session/auto-title';
import type { Session, SessionMeta } from '#/session';

function user(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } } as ContextMessage;
}
function reminder(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'injection' } } as never;
}
function assistant(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] } as ContextMessage;
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    createdAt: '',
    updatedAt: '',
    title: '你好',
    isCustomTitle: false,
    agents: {},
    custom: {},
    ...overrides,
  };
}

describe('parseTitleAnswer', () => {
  it('reads the title out of the tags', () => {
    expect(parseTitleAnswer('<title>修复登录页白屏</title>')).toBe('修复登录页白屏');
  });

  it('treats <title/> and an empty title as nothing to name yet', () => {
    expect(parseTitleAnswer('<title/>')).toBeNull();
    expect(parseTitleAnswer('<title>  </title>')).toBeNull();
  });

  it('rejects an answer that ignored the format', () => {
    expect(parseTitleAnswer('Sure! Here is a title: Fix login')).toBeUndefined();
  });
});

describe('normalizeTitle', () => {
  it('drops quotes, trailing punctuation and extra spaces', () => {
    expect(normalizeTitle('  "Fix   retry queue."  ')).toBe('Fix retry queue');
    expect(normalizeTitle('「优化会话标题」。')).toBe('优化会话标题');
  });

  it('caps the length', () => {
    expect(Array.from(normalizeTitle('长'.repeat(100)))).toHaveLength(60);
  });
});

describe('buildTitleExcerpt', () => {
  it('is undefined before any request', () => {
    expect(buildTitleExcerpt([reminder('system note')])).toBeUndefined();
  });

  it('counts an untagged message from older history as the person\'s, and leaves skill bodies out', () => {
    const legacy = { role: 'user', content: [{ type: 'text', text: '旧会话的第一句' }], toolCalls: [] } as ContextMessage;
    const skill = {
      role: 'user',
      content: [{ type: 'text', text: 'rendered skill body' }],
      toolCalls: [],
      origin: { kind: 'skill_activation', trigger: 'user-slash' },
    } as never;
    const excerpt = buildTitleExcerpt([legacy, skill, assistant('ok')])!;
    expect(excerpt).toContain('旧会话的第一句');
    expect(excerpt).not.toContain('rendered skill body');
  });

  it('keeps the opening request, the two latest requests and the latest reply, without injected text', () => {
    const excerpt = buildTitleExcerpt([
      user('你好'),
      assistant('你好！有什么可以帮你？'),
      reminder('<system-reminder>secret plumbing</system-reminder>'),
      user('第二句'),
      user('第三句'),
      user('会话标题改成模型生成'),
      assistant('好的，我先看标题是在哪里写的。'),
    ])!;
    expect(excerpt).toContain('<opening_request>\n你好\n</opening_request>');
    expect(excerpt).toContain('第三句');
    expect(excerpt).toContain('会话标题改成模型生成');
    expect(excerpt).not.toContain('第二句');
    expect(excerpt).not.toContain('secret plumbing');
    expect(excerpt).toContain('<latest_reply>\n好的，我先看标题是在哪里写的。\n</latest_reply>');
  });
});

describe('wantsModelTitle', () => {
  it('skips a title the person set, one the model already wrote, and job runs', () => {
    expect(wantsModelTitle(meta())).toBe(true);
    expect(wantsModelTitle(meta({ isCustomTitle: true }))).toBe(false);
    expect(wantsModelTitle(meta({ custom: { [TITLE_SOURCE_KEY]: 'model' } }))).toBe(false);
    expect(wantsModelTitle(meta({ custom: { source: 'job' } }))).toBe(false);
  });
});

describe('SessionAutoTitle', () => {
  function setup(answers: string[]) {
    const eventBus = new EventSubscriptionBus();
    const history: ContextMessage[] = [user('你好'), assistant('你好！')];
    const generate = vi.fn(async () => ({
      message: { role: 'assistant', content: [{ type: 'text', text: answers.shift() ?? '<title/>' }], toolCalls: [] },
      usage: null,
    }));
    const provider: { withThinking: ReturnType<typeof vi.fn<(level: string) => unknown>> } = {
      withThinking: vi.fn((_level: string) => provider),
    };
    const agent = {
      eventBus,
      context: { history },
      config: { hasModel: true, provider, model: 'main-model', thinkingLevel: 'high' },
      generate,
      usage: { record: vi.fn() },
      deobfuscateInboundText: (text: string) => text,
    };
    const emitEvent = vi.fn(async () => {});
    const session = {
      metadata: meta(),
      agents: new Map([['main', agent]]),
      writeMetadata: vi.fn(async () => {}),
      rpc: { emitEvent },
      log: { warn: vi.fn() },
    };
    const titler = new SessionAutoTitle(session as unknown as Session);
    const endTurn = async () => {
      eventBus.dispatch({ type: 'turn.ended', turnId: 1, reason: 'completed' } as never);
      await vi.waitFor(() => {
        expect(generate).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { titler, session, history, generate, provider, emitEvent, endTurn };
  }

  it('waits past a greeting, then names the task once and stops asking', async () => {
    const t = setup(['<title/>', '<title>会话标题改由模型生成</title>']);
    t.titler.watch();

    await t.endTurn();
    expect(t.session.metadata.title).toBe('你好');
    expect(t.provider.withThinking).toHaveBeenCalledWith('off');

    t.history.push(user('会话标题应该基于模型生成'), assistant('好的'));
    await t.endTurn();
    expect(t.session.metadata.title).toBe('会话标题改由模型生成');
    expect(t.session.metadata.custom[TITLE_SOURCE_KEY]).toBe('model');
    expect(t.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.meta.updated', title: '会话标题改由模型生成' }));

    t.generate.mockClear();
    t.session.agents.get('main')!.eventBus.dispatch({ type: 'turn.ended', turnId: 3, reason: 'completed' } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.generate).not.toHaveBeenCalled();
  });

  it('never overwrites a title the person set while the model was answering', async () => {
    const t = setup(['<title>Model title</title>']);
    t.titler.watch();
    t.generate.mockImplementationOnce(async () => {
      t.session.metadata = { ...t.session.metadata, title: 'Mine', isCustomTitle: true };
      return { message: { role: 'assistant', content: [{ type: 'text', text: '<title>Model title</title>' }], toolCalls: [] }, usage: null } as never;
    });
    await t.endTurn();
    expect(t.session.metadata.title).toBe('Mine');
    expect(t.session.writeMetadata).toHaveBeenCalledTimes(1); // the attempt count only
  });

  it('writes nothing once the session closed while the model was answering, and cancels the request', async () => {
    const t = setup([]);
    t.titler.watch();
    let signal: AbortSignal | undefined;
    t.generate.mockImplementationOnce(async (...args: unknown[]) => {
      signal = (args[5] as { signal: AbortSignal }).signal;
      t.titler.dispose(); // the session closes (or is deleted) mid-request
      return { message: { role: 'assistant', content: [{ type: 'text', text: '<title>Late</title>' }], toolCalls: [] }, usage: null } as never;
    });
    await t.endTurn();
    expect(signal?.aborted).toBe(true);
    // Only the attempt count, written before the request; the late title never.
    expect(t.session.writeMetadata).toHaveBeenCalledTimes(1);
    expect(t.session.metadata.title).toBe('你好');
    // …and it stays off for good.
    t.titler.watch();
    t.generate.mockClear();
    t.session.agents.get('main')!.eventBus.dispatch({ type: 'turn.ended', turnId: 2, reason: 'completed' } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.generate).not.toHaveBeenCalled();
  });

  it('retries once at the session thinking level when the endpoint refuses thinking off', async () => {
    const t = setup(['<title>Retry worked</title>']);
    t.titler.watch();
    t.generate.mockImplementationOnce(async () => {
      throw new Error('400 thinking cannot be disabled');
    });
    await t.endTurn();
    await vi.waitFor(() => {
      expect(t.session.metadata.title).toBe('Retry worked');
    });
    expect(t.provider.withThinking.mock.calls.map(([level]) => level)).toEqual(['off', 'high']);
  });

  it('ignores cancelled and failed turns', async () => {
    const t = setup(['<title>X</title>']);
    t.titler.watch();
    t.session.agents.get('main')!.eventBus.dispatch({ type: 'turn.ended', turnId: 1, reason: 'cancelled' } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.generate).not.toHaveBeenCalled();
  });

  it('remembers spent attempts in the session, so reopening it does not start over', async () => {
    const t = setup([]);
    t.session.metadata = meta({ custom: { [TITLE_ATTEMPTS_KEY]: 4 } }); // spent in an earlier open
    t.titler.watch();
    t.session.agents.get('main')!.eventBus.dispatch({ type: 'turn.ended', turnId: 1, reason: 'completed' } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.generate).not.toHaveBeenCalled();

    const fresh = setup([]);
    fresh.session.metadata = meta({ custom: { [TITLE_ATTEMPTS_KEY]: 3 } });
    fresh.titler.watch();
    await fresh.endTurn();
    expect(fresh.session.metadata.custom[TITLE_ATTEMPTS_KEY]).toBe(4);
    expect(fresh.session.writeMetadata).toHaveBeenCalled();
    fresh.generate.mockClear();
    fresh.session.agents.get('main')!.eventBus.dispatch({ type: 'turn.ended', turnId: 2, reason: 'completed' } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fresh.generate).not.toHaveBeenCalled();
  });

  it('gives up after four turns with nothing to name', async () => {
    const t = setup([]);
    t.titler.watch();
    for (let i = 0; i < 6; i++) {
      t.session.agents.get('main')!.eventBus.dispatch({ type: 'turn.ended', turnId: i, reason: 'completed' } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(t.generate).toHaveBeenCalledTimes(4);
    expect(t.session.metadata.title).toBe('你好');
  });
});

describe('SDK metadata writes keep the title bookkeeping', () => {
  it('does not let a stale custom bag wipe the model-title mark or the attempt count', async () => {
    const { SessionAPIImpl } = await import('#/session/rpc');
    const session = {
      metadata: meta({ title: '会话标题改由模型生成', custom: { [TITLE_SOURCE_KEY]: 'model', [TITLE_ATTEMPTS_KEY]: 2 } }),
      writeMetadata: vi.fn(async () => {}),
    };
    const api = new SessionAPIImpl(session as unknown as Session);
    // What the SDK sends: the custom bag it read when the session opened.
    await api.updateSessionMetadata({ metadata: { custom: { note: 'from sdk' } } } as never);
    expect(session.metadata.custom).toEqual({ note: 'from sdk', [TITLE_SOURCE_KEY]: 'model', [TITLE_ATTEMPTS_KEY]: 2 });
    expect(wantsModelTitle(session.metadata)).toBe(false);
  });
});
