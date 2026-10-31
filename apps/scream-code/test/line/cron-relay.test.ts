import { describe, expect, it, vi } from 'vitest';
import type { Event } from '@scream-code/scream-code-sdk';

import { CronRelay } from '#/line/cron-relay';

const start = { type: 'turn.started', turnId: 1, agentId: 'main' } as unknown as Event;
const delta = (text: string): Event =>
  ({ type: 'assistant.delta', turnId: 1, agentId: 'main', delta: text }) as unknown as Event;
const end = {
  type: 'turn.ended',
  turnId: 1,
  agentId: 'main',
  reason: 'completed',
  stepBudgetExhausted: false,
} as unknown as Event;

function relay(sent: string[], options: { busy?: () => boolean } = {}) {
  const send = vi.fn(async (text: string) => {
    sent.push(text);
    return 'sent' as const;
  });
  return new CronRelay({ send, isBusy: options.busy ?? (() => false) });
}

describe('CronRelay', () => {
  it('announces the fire, then delivers the turn text', async () => {
    const sent: string[] = [];
    const r = relay(sent);

    r.onFire('⏰ 定时任务已触发：检查 CI');
    r.onEvent(start);
    r.onEvent(delta('构建通过'));
    r.onEvent(end);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });

    expect(sent).toEqual(['⏰ 定时任务已触发：检查 CI', '构建通过']);
  });

  it('stays silent when a user turn owns the chat at fire time', () => {
    const sent: string[] = [];
    const r = relay(sent, { busy: () => true });

    r.onFire('⏰ 定时任务已触发：检查 CI');
    expect(sent).toHaveLength(0);
  });

  it('drops the collection when the user takes over mid-turn', async () => {
    const sent: string[] = [];
    let busy = false;
    const r = relay(sent, { busy: () => busy });

    r.onFire('⏰ 定时任务已触发：检查 CI');
    r.onEvent(start);
    r.onEvent(delta('部分文本'));
    busy = true;
    r.onEvent(end);
    await Promise.resolve();

    // Only the notice: the user's own reply is the answer for this window.
    expect(sent).toEqual(['⏰ 定时任务已触发：检查 CI']);
  });

  it('sends nothing extra when the turn produced no text', async () => {
    const sent: string[] = [];
    const r = relay(sent);

    r.onFire('⏰ 定时任务已触发：检查 CI');
    r.onEvent(start);
    r.onEvent(end);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent).toEqual(['⏰ 定时任务已触发：检查 CI']);
  });

  it('ignores a second fire while one forward is still collecting', async () => {
    const sent: string[] = [];
    const r = relay(sent);

    r.onFire('⏰ 第一次');
    r.onFire('⏰ 第二次');
    r.onEvent(start);
    r.onEvent(delta('ok'));
    r.onEvent(end);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });

    expect(sent).toEqual(['⏰ 第一次', 'ok']);
  });
});

describe('CronRelay — fire ordering and guards', () => {
  it('replays the turn.started that the core emits before cron.fired', async () => {
    // `steer()` launches the turn synchronously, so `turn.started` precedes
    // `cron.fired`; without replaying it nothing would ever be delivered.
    const sent: string[] = [];
    const relay = new CronRelay({
      send: async (text) => {
        sent.push(text);
        return 'sent';
      },
      isBusy: () => false,
    });

    relay.onFire('⏰ 定时任务已触发：检查 CI', start);
    relay.onEvent(delta('结论：通过'));
    relay.onEvent(end);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]).toBe('结论：通过');
  });

  it('frees the slot when a fired turn never ends', async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const relay = new CronRelay({
        send: async (text) => {
          sent.push(text);
          return 'sent';
        },
        isBusy: () => false,
        collectTimeoutMs: 1_000,
      });

      relay.onFire('⏰ 第一次', start);
      vi.advanceTimersByTime(1_500);

      // The stuck collection was dropped, so a later fire is accepted again.
      relay.onFire('⏰ 第二次', start);
      expect(sent).toEqual(['⏰ 第一次', '⏰ 第二次']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports whether a fired turn is still being collected', () => {
    const relay = new CronRelay({ send: async () => 'sent', isBusy: () => false });
    expect(relay.isCollecting()).toBe(false);
    relay.onFire('⏰ 定时任务已触发', start);
    expect(relay.isCollecting()).toBe(true);
    relay.dispose();
    expect(relay.isCollecting()).toBe(false);
  });

  it('drops everything on dispose', async () => {
    const sent: string[] = [];
    const relay = new CronRelay({
      send: async (text) => {
        sent.push(text);
        return 'sent';
      },
      isBusy: () => false,
    });

    relay.onFire('⏰ 定时任务已触发', start);
    relay.dispose();
    relay.onEvent(delta('不会再发'));
    relay.onEvent(end);
    await Promise.resolve();
    expect(sent).toEqual(['⏰ 定时任务已触发']);
  });
});

describe('CronRelay — empty result', () => {
  it('tells the chat when the task finished with no output', async () => {
    const sent: string[] = [];
    const relay = new CronRelay({
      send: async (text) => {
        sent.push(text);
        return 'sent';
      },
      isBusy: () => false,
    });

    relay.onFire('⏰ 定时任务已触发：检查 CI', start, '⚠️ 定时任务执行结束但没有输出：检查 CI');
    relay.onEvent(end);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]).toBe('⚠️ 定时任务执行结束但没有输出：检查 CI');
  });
});

describe('CronRelay — quiet tasks', () => {
  it('skips the notice for a silent task but still delivers the result', async () => {
    const sent: string[] = [];
    const relay = new CronRelay({
      send: async (text) => {
        sent.push(text);
        return 'sent';
      },
      isBusy: () => false,
    });

    relay.onFire(null, start);
    relay.onEvent(delta('结果'));
    relay.onEvent(end);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent).toEqual(['结果']);
  });
});
