import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); });

import type { ServerEvent } from '../../../src/bot/shared/contracts';
import { SseHub, eventId, parseLastEventId } from '../../../src/bot/server/sse';

function publish(hub: SseHub, botId: string): ServerEvent {
  return hub.publish({ botId, threadId: `th_${botId}`, type: 'run.updated', data: {} });
}

describe('epoch/global SSE cursors', () => {
  it('accepts only a safe epoch/sequence cursor', () => {
    expect(parseLastEventId('epoch_1:12')).toEqual({ epoch: 'epoch_1', seq: 12 });
    for (const raw of [undefined, '', '7', 'x:-1', 'x:1.2', 'x:01', 'x:1e2', 'x:9007199254740992', 'a:b:1']) {
      expect(parseLastEventId(raw)).toBeUndefined();
    }
  });
});

describe('SseHub', () => {
  it('orders all bots on one process sequence and replays both bots', async () => {
    const hub = new SseHub({ epoch: 'process' });
    expect(publish(hub, 'a').seq).toBe(1);
    publish(hub, 'b');
    publish(hub, 'a');
    publish(hub, 'b');
    const seen: ServerEvent[] = [];
    const subscription = hub.subscribe({ lastEventId: 'process:1' }, (event) => seen.push(event));
    await subscription.ready;
    expect(seen.map((event) => `${event.botId}:${String(event.seq)}`)).toEqual(['b:2', 'a:3', 'b:4']);
    publish(hub, 'a');
    expect(seen.at(-1)?.seq).toBe(5);
    expect(hub.currentSeq()).toBe(5);
    subscription.unsubscribe();
    expect(hub.subscriberCount).toBe(0);
  });

  it('filters bots without changing the cursor namespace', () => {
    const hub = new SseHub({ epoch: 'process' });
    publish(hub, 'a');
    publish(hub, 'b');
    publish(hub, 'a');
    const seen: ServerEvent[] = [];
    hub.subscribe({ botId: 'a', lastEventId: 'process:0' }, (event) => seen.push(event));
    publish(hub, 'b');
    publish(hub, 'a');
    expect(seen.map((event) => event.seq)).toEqual([1, 3, 5]);
  });

  it.each([
    ['process:0', 'buffer_gap'],
    ['old-process:3', 'epoch_mismatch'],
    ['process:9', 'future_cursor'],
    ['3', 'invalid_cursor'],
    ['', 'invalid_cursor'],
  ])('requests explicit resync for %s', (cursor, reason) => {
    const hub = new SseHub({ bufferSize: 2, epoch: 'process' });
    for (let index = 0; index < 4; index += 1) publish(hub, 'a');
    const seen: ServerEvent[] = [];
    hub.subscribe({ lastEventId: cursor }, (event) => seen.push(event));
    expect(seen).toEqual([{ epoch: 'process', seq: 4, type: 'resync', data: { epoch: 'process', seq: 4, reason } }]);
    publish(hub, 'b');
    expect(seen.at(-1)?.seq).toBe(5);
    expect(hub.replay(0).map((event) => event.seq)).toEqual([4, 5]);
  });

  it('replays the oldest covered boundary without a false gap', () => {
    const hub = new SseHub({ bufferSize: 2, epoch: 'process' });
    for (let index = 0; index < 4; index += 1) publish(hub, 'a');
    const seen: ServerEvent[] = [];
    hub.subscribe({ lastEventId: 'process:2' }, (event) => seen.push(event));
    expect(seen.map((event) => event.seq)).toEqual([3, 4]);
  });

  it('does not replay a cursor from a previous process', () => {
    const previous = new SseHub({ epoch: 'previous' });
    const cursor = eventId(publish(previous, 'a'));
    const restarted = new SseHub({ epoch: 'restarted' });
    const seen: ServerEvent[] = [];
    restarted.subscribe({ lastEventId: cursor }, (event) => seen.push(event));
    expect(seen[0]?.data).toEqual({ reason: 'epoch_mismatch', epoch: 'restarted', seq: 0 });
  });

  it('registers before replay and preserves every event interleaved with an async snapshot', async () => {
    const hub = new SseHub({ epoch: 'process', bufferSize: 2 });
    publish(hub, 'a');
    publish(hub, 'b');
    const snapshot = Promise.withResolvers<void>();
    const seen: string[] = [];
    const subscription = hub.subscribe({
      lastEventId: 'process:0',
      snapshot: (watermark) => {
        seen.push(`snapshot:${String(watermark.seq)}`);
        publish(hub, 'b');
        return snapshot.promise;
      },
    }, (event) => {
      seen.push(`event:${String(event.seq)}`);
      if (event.seq === 1) publish(hub, 'a');
    });
    expect(subscription.watermark).toEqual({ epoch: 'process', seq: 2 });
    expect(seen).toEqual(['event:1', 'event:2', 'snapshot:2']);
    publish(hub, 'a');
    snapshot.resolve();
    await subscription.ready;
    expect(seen).toEqual(['event:1', 'event:2', 'snapshot:2', 'event:3', 'event:4', 'event:5']);
    publish(hub, 'b');
    expect(seen.at(-1)).toBe('event:6');
  });

  it('cleans up during snapshots and on snapshot failure', async () => {
    const hub = new SseHub();
    const pending = Promise.withResolvers<void>();
    const seen: ServerEvent[] = [];
    const subscription = hub.subscribe({ snapshot: () => pending.promise }, (event) => seen.push(event));
    publish(hub, 'a');
    subscription.unsubscribe();
    pending.resolve();
    await subscription.ready;
    expect(seen).toEqual([]);
    expect(hub.subscriberCount).toBe(0);
    const failed = hub.subscribe({ snapshot: () => Promise.reject(new Error('snapshot failed')) }, () => {});
    await expect(failed.ready).rejects.toThrow('snapshot failed');
    expect(hub.subscriberCount).toBe(0);
  });

  it('isolates throwing subscribers and closes outstanding subscriptions', async () => {
    const hub = new SseHub();
    const seen: number[] = [];
    hub.subscribe({}, () => { throw new Error('broken sink'); });
    hub.subscribe({}, (event) => seen.push(event.seq));
    expect(() => publish(hub, 'a')).not.toThrow();
    expect(seen).toEqual([1]);
    expect(hub.subscriberCount).toBe(1);
    hub.close();
    expect(hub.subscriberCount).toBe(0);
    expect(() => publish(hub, 'a')).toThrow('closed');
  });

  it('keeps live fanout ordered under reentrant publishing and subscription', () => {
    const hub = new SseHub({ epoch: 'process' });
    const seen: number[] = [];
    const joined: number[] = [];
    hub.subscribe({}, (event) => {
      if (event.seq !== 1) return;
      hub.subscribe({ lastEventId: 'process:0' }, (item) => joined.push(item.seq));
      publish(hub, 'b');
    });
    hub.subscribe({}, (event) => seen.push(event.seq));
    publish(hub, 'a');
    expect(seen).toEqual([1, 2]);
    expect(joined).toEqual([1, 2]);
  });

  it('bounds a slow snapshot queue, signals the gap and aborts its writer', async () => {
    const hub = new SseHub({ epoch: 'bounded', pendingLimit: 2 });
    const pending = Promise.withResolvers<void>();
    const seen: ServerEvent[] = [];
    let signal: AbortSignal | undefined;
    const subscription = hub.subscribe({ snapshot: (_watermark, abort) => { signal = abort; return pending.promise; } }, (event) => seen.push(event));
    const rejected = expect(subscription.ready).rejects.toThrow('pending_overflow');
    publish(hub, 'a');
    publish(hub, 'b');
    expect(seen).toEqual([]);
    publish(hub, 'a');
    await rejected;
    expect(seen).toEqual([{ epoch: 'bounded', seq: 3, type: 'resync', data: { reason: 'pending_overflow', epoch: 'bounded', seq: 3 } }]);
    expect(signal?.aborted).toBe(true);
    expect(hub.subscriberCount).toBe(0);
    pending.resolve();
    await Promise.resolve();
    publish(hub, 'a');
    expect(seen).toHaveLength(1);
    hub.close();
  });

  it('times out stalled snapshots even with no events and releases the timer', async () => {
    vi.useFakeTimers();
    const hub = new SseHub({ snapshotTimeoutMs: 25 });
    const seen: ServerEvent[] = [];
    const subscription = hub.subscribe({ snapshot: () => new Promise<void>(() => {}) }, (event) => seen.push(event));
    const rejected = expect(subscription.ready).rejects.toThrow('snapshot_timeout');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(seen[0]?.data).toMatchObject({ reason: 'snapshot_timeout' });
    expect(hub.subscriberCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an unresolved snapshot immediately, without accumulating retries', async () => {
    vi.useFakeTimers();
    const hub = new SseHub({ pendingLimit: 1 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      const subscription = hub.subscribe({ snapshot: (_watermark, abort) => { signal = abort; return pending.promise; } }, () => {});
      publish(hub, 'a');
      subscription.unsubscribe();
      await subscription.ready;
      expect(signal?.aborted).toBe(true);
      expect(hub.subscriberCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      pending.reject(new Error('writer cancelled later'));
      await Promise.resolve();
    }
    const pending = hub.subscribe({ snapshot: () => new Promise<void>(() => {}) }, () => {});
    hub.close();
    await pending.ready;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('formats bot-independent event IDs', () => {
    const hub = new SseHub({ epoch: 'process' });
    expect(eventId(publish(hub, 'a'))).toBe('process:1');
    expect(eventId(publish(hub, 'b'))).toBe('process:2');
  });
});
