import { describe, expect, it, vi } from 'vitest';
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
    expect(a).toMatchObject({ status: 'accepted', queueDepth: 1 });
    expect(b).toMatchObject({ status: 'accepted', queueDepth: 2 });
    expect(bus.activeCount('child-a')).toBe(2);
    expect(bus.poll('child-a').map((m) => m.text)).toEqual(['first', 'second']);
    expect(bus.activeCount('child-a')).toBe(0);
  });

  it('reports the stable id of an accepted message to its sender', () => {
    const bus = new SubagentMessageBus();
    const accepted = msg(bus, 'child-a', 'queue', 'hello', { inFlightLimit: 10 });
    const delivered = bus.poll('child-a')[0]!;
    // The id the sender was handed is the id the child receives: that is what
    // makes retries reconcilable (a duplicate can be tied to this copy).
    expect(accepted.messageId).toBe(delivered.id);
    expect(accepted.messageId).toEqual(expect.any(String));
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
    expect(msg(bus, 'child-a', 'queue', 'x', { inFlightLimit: 1 })).toMatchObject({
      status: 'accepted',
      queueDepth: 1,
    });
    expect(msg(bus, 'child-a', 'queue', 'y', { inFlightLimit: 1 }).status).toBe('saturated');
  });

  it('lets four undelivered messages coexist under the default limit', () => {
    const bus = new SubagentMessageBus();
    for (let index = 0; index < 4; index += 1) {
      expect(msg(bus, 'child-a', 'queue', `m${index}`).status).toBe('accepted');
    }
    // A single undelivered message must not jam the channel for a whole run.
    expect(msg(bus, 'child-a', 'queue', 'm4').status).toBe('saturated');
  });

  it('rejects oversized messages as saturated', () => {
    const bus = new SubagentMessageBus();
    expect(msg(bus, 'child-a', 'queue', 'x'.repeat(11), { byteLimit: 10 }).status).toBe(
      'saturated',
    );
  });

  it('never delivers a message whose deadline is already past', () => {
    const bus = new SubagentMessageBus();
    // There is deliberately no send-time `deadline_elapsed` status: callers
    // stamp the deadline when they build the message, so the only thing a past
    // deadline can mean is "undeliverable", which poll/reclaim enforces.
    const late = msg(bus, 'child-a', 'queue', 'late', { deadline: NOW - 1 });
    expect(late.status).toBe('accepted');
    expect(bus.holdsMessage(late.messageId!)).toBe(false);
    expect(bus.activeCount('child-a')).toBe(0);
    expect(bus.poll('child-a')).toEqual([]);
  });

  it('reports whether an accepted message is still queued', () => {
    const bus = new SubagentMessageBus();
    const accepted = msg(bus, 'child-a', 'queue', 'first', { inFlightLimit: 10 });
    // In flight: a retried send is a duplicate of this copy.
    expect(bus.holdsMessage(accepted.messageId!)).toBe(true);
    expect(bus.poll('child-a')).toHaveLength(1);
    // Consumed: the copy is gone, so the retry has to go through.
    expect(bus.holdsMessage(accepted.messageId!)).toBe(false);
    expect(bus.holdsMessage('never-issued')).toBe(false);
  });

  it('reports an expired message as no longer in flight', () => {
    vi.useFakeTimers();
    try {
      const bus = new SubagentMessageBus();
      const accepted = msg(bus, 'child-a', 'queue', 'x', { deadline: NOW + 1000 });
      expect(bus.holdsMessage(accepted.messageId!)).toBe(true);
      vi.setSystemTime(NOW + 1001);
      // The check is an ordinary bus access: an undeliverable copy cannot keep
      // a retry deduped against a message that will never arrive.
      expect(bus.holdsMessage(accepted.messageId!)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives queued mail a deadline that outlasts a real child turn', () => {
    // A child turn routinely runs for minutes (long tool calls, several steps).
    // A deadline shorter than that silently eats messages the parent was told
    // were accepted.
    const message = buildSubagentMessage('main', 'child-a', 'queue', 'x');
    expect(message.deadline - Date.now()).toBeGreaterThanOrEqual(120_000);
  });

  it('stops counting queued mail once its deadline passes', () => {
    vi.useFakeTimers();
    try {
      const bus = new SubagentMessageBus();
      expect(msg(bus, 'child-a', 'queue', 'x', { deadline: NOW + 1000 }).status).toBe('accepted');
      expect(bus.activeCount('child-a')).toBe(1);
      // No poll in between: the count alone has to stop offering dead mail, or
      // the host spends a delivery turn on a message that can never arrive.
      vi.setSystemTime(NOW + 1001);
      expect(bus.activeCount('child-a')).toBe(0);
      expect(bus.poll('child-a')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls nothing for an unknown agent or one whose mail has expired', () => {
    const bus = new SubagentMessageBus();
    expect(bus.poll('nobody')).toEqual([]);
    // Expired mail is what bounds a mailbox now that runs no longer purge it:
    // it is neither counted nor delivered.
    msg(bus, 'child-a', 'queue', 'x', { deadline: NOW - 1000 });
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

  it('drops the mailbox entry once poll empties the queue', () => {
    const bus = new SubagentMessageBus();
    msg(bus, 'child-a', 'queue', 'only', { inFlightLimit: 10 });
    expect(bus.mailboxCount).toBe(1);
    expect(bus.poll('child-a')).toHaveLength(1);
    // Terminal cleanup: an emptied mailbox must not pin a Map slot.
    expect(bus.mailboxCount).toBe(0);
    expect(bus.activeCount('child-a')).toBe(0);
  });

  it('drops the mailbox entry when poll finds only expired mail', () => {
    vi.useFakeTimers();
    try {
      const bus = new SubagentMessageBus();
      // Accepted with a deadline that has already passed by poll time —
      // send() itself rejects already-expired mail, so age it after enqueue.
      msg(bus, 'child-a', 'queue', 'stale', { deadline: NOW + 1000 });
      expect(bus.mailboxCount).toBe(1);
      vi.setSystemTime(NOW + 1001);
      expect(bus.poll('child-a')).toEqual([]);
      expect(bus.mailboxCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps accepted mail until the next ordinary access reclaims it past the deadline', () => {
    vi.useFakeTimers();
    try {
      const bus = new SubagentMessageBus();
      // Mail for a child that has already finished: nothing polls this mailbox
      // again, which is exactly the state the child's terminal used to purge —
      // and the case where purging destroyed accepted mail.
      msg(bus, 'child-a', 'queue', 'undelivered', { deadline: NOW + 1000 });
      expect(bus.mailboxCount).toBe(1);
      expect(bus.activeCount('child-a')).toBe(1);

      vi.setSystemTime(NOW + 1001);
      // An ordinary access FOR ANOTHER AGENT reclaims the dead mailbox: a
      // finished child must not leave one Map entry behind per run.
      expect(bus.activeCount('child-b')).toBe(0);
      expect(bus.mailboxCount).toBe(0);
      expect(bus.poll('child-a')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let expired mail hold an in-flight slot', () => {
    vi.useFakeTimers();
    try {
      const bus = new SubagentMessageBus();
      const first = msg(bus, 'child-a', 'queue', 'first', {
        inFlightLimit: 1,
        deadline: NOW + 1000,
      });
      expect(first.status).toBe('accepted');

      vi.setSystemTime(NOW + 1001);
      // Undeliverable mail must not jam the channel the parent still needs.
      const second = msg(bus, 'child-a', 'queue', 'second', {
        inFlightLimit: 1,
        deadline: NOW + 2000,
      });
      expect(second.status).toBe('accepted');
      expect(bus.poll('child-a').map((m) => m.text)).toEqual(['second']);
    } finally {
      vi.useRealTimers();
    }
  });
});
