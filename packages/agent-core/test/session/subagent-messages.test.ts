import { describe, expect, it } from 'vitest';
import {
  SubagentMessageBus,
  buildSubagentMessage,
  type SubagentMessageOperation,
} from '../../src/session/subagent-messages';

const NOW = Date.now();

function deadlineFromNow(ms: number): number {
  return NOW + ms;
}

function msg(
  bus: SubagentMessageBus,
  to: string,
  operation: SubagentMessageOperation = 'queue',
  text = 'hello',
  overrides?: { inFlightLimit?: number; byteLimit?: number; deadline?: number },
) {
  return bus.send(
    buildSubagentMessage('parent', to, operation, text, {
      deadline: deadlineFromNow(10_000),
      ...overrides,
    }),
  );
}

describe('SubagentMessageBus', () => {
  it('accepts and delivers a queued message in FIFO order', () => {
    const bus = new SubagentMessageBus();
    const a = msg(bus, 'child-a', 'queue', 'first', { inFlightLimit: 10 });
    const b = msg(bus, 'child-a', 'queue', 'second', { inFlightLimit: 10 });
    expect(a).toEqual({ status: 'accepted', queueDepth: 1 });
    expect(b).toEqual({ status: 'accepted', queueDepth: 2 });
    expect(bus.activeCount('child-a')).toBe(2);
    expect(bus.poll('child-a').map((m) => m.text)).toEqual(['first', 'second']);
    expect(bus.activeCount('child-a')).toBe(0);
  });

  it('delivers steer messages before queue messages regardless of arrival order', () => {
    const bus = new SubagentMessageBus();
    msg(bus, 'child-a', 'queue', 'first', { inFlightLimit: 10 });
    msg(bus, 'child-a', 'steer', 'urgent', { inFlightLimit: 10 });
    msg(bus, 'child-a', 'queue', 'second', { inFlightLimit: 10 });
    expect(bus.poll('child-a').map((m) => m.text)).toEqual(['urgent', 'first', 'second']);
  });

  it('saturates when the in-flight limit is reached', () => {
    const bus = new SubagentMessageBus();
    expect(msg(bus, 'child-a', 'queue', 'x', { inFlightLimit: 1 })).toEqual({
      status: 'accepted',
      queueDepth: 1,
    });
    expect(msg(bus, 'child-a', 'queue', 'y', { inFlightLimit: 1 }).status).toBe('saturated');
  });

  it('rejects oversized messages as saturated', () => {
    const bus = new SubagentMessageBus();
    expect(msg(bus, 'child-a', 'queue', 'x'.repeat(11), { byteLimit: 10 }).status).toBe(
      'saturated',
    );
  });

  it('rejects expired messages as deadline_elapsed without enqueueing', () => {
    const bus = new SubagentMessageBus();
    expect(msg(bus, 'child-a', 'queue', 'late', { deadline: NOW - 1 }).status).toBe(
      'deadline_elapsed',
    );
    expect(bus.activeCount('child-a')).toBe(0);
  });

  it('polls nothing for an unknown or cleared agent', () => {
    const bus = new SubagentMessageBus();
    expect(bus.poll('nobody')).toEqual([]);
    msg(bus, 'child-a', 'queue', 'x');
    bus.clear('child-a');
    expect(bus.activeCount('child-a')).toBe(0);
    expect(bus.poll('child-a')).toEqual([]);
  });

  it('generates unique message ids across targets', () => {
    const bus = new SubagentMessageBus();
    msg(bus, 'child-a', 'queue', 'x');
    msg(bus, 'child-b', 'queue', 'y');
    const a = bus.poll('child-a')[0]!;
    const b = bus.poll('child-b')[0]!;
    expect(a.id).not.toBe(b.id);
  });

  it('measures byte limit in UTF-8 bytes, not UTF-16 code units', () => {
    const bus = new SubagentMessageBus();
    // "你" is 3 UTF-8 bytes but 1 UTF-16 code unit; a limit of 6 bytes should
    // accept two of them and reject three.
    const ok = bus.send(
      buildSubagentMessage('parent', 'child-a', 'queue', '你你', {
        byteLimit: 6,
        deadline: deadlineFromNow(10_000),
      }),
    );
    expect(ok.status).toBe('accepted');
    const rejected = bus.send(
      buildSubagentMessage('parent', 'child-a', 'queue', '你你你', {
        byteLimit: 6,
        deadline: deadlineFromNow(10_000),
      }),
    );
    expect(rejected.status).toBe('saturated');
    bus.clear('child-a');
  });

  it('drops expired messages at poll time instead of delivering them', () => {
    const bus = new SubagentMessageBus();
    // Accept with a deadline that is already in the past by poll time.
    bus.send(
      buildSubagentMessage('parent', 'child-a', 'queue', 'stale', {
        deadline: NOW - 1,
      }),
    );
    expect(bus.poll('child-a')).toEqual([]);
    expect(bus.activeCount('child-a')).toBe(0);
  });

  it('preserves FIFO order within an operation class', () => {
    const bus = new SubagentMessageBus();
    for (let i = 0; i < 15; i++) {
      msg(bus, 'child-a', 'queue', `m${i}`, { inFlightLimit: 20 });
    }
    expect(bus.poll('child-a').map((m) => m.text)).toEqual(
      Array.from({ length: 15 }, (_, i) => `m${i}`),
    );
  });
});
