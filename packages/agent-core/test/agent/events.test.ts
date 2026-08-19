import { describe, expect, it, vi } from 'vitest';

import { EventSubscriptionBus } from '#/agent/events';
import type { AgentEvent } from '#/rpc';

function makeEvent(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type, ...extra } as unknown as AgentEvent;
}

describe('EventSubscriptionBus', () => {
  it('delivers typed events to matching subscribers only', () => {
    const bus = new EventSubscriptionBus();
    const onTurn = vi.fn();
    const onTool = vi.fn();
    bus.subscribe('turn.started', onTurn);
    bus.subscribe('tool.call.started', onTool);

    bus.dispatch(makeEvent('turn.started'));
    bus.dispatch(makeEvent('tool.call.started'));

    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTool).toHaveBeenCalledTimes(1);
  });

  it('delivers every event to a wildcard subscriber', () => {
    const bus = new EventSubscriptionBus();
    const onAny = vi.fn();
    bus.subscribe('*', onAny);

    bus.dispatch(makeEvent('turn.started'));
    bus.dispatch(makeEvent('tool.call.started'));

    expect(onAny).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes a handler when the returned function is called', () => {
    const bus = new EventSubscriptionBus();
    const onTurn = vi.fn();
    const unsub = bus.subscribe('turn.started', onTurn);

    bus.dispatch(makeEvent('turn.started'));
    unsub();
    bus.dispatch(makeEvent('turn.started'));

    expect(onTurn).toHaveBeenCalledTimes(1);
  });

  it('clears all subscribers on clear()', () => {
    const bus = new EventSubscriptionBus();
    const onTurn = vi.fn();
    const onAny = vi.fn();
    bus.subscribe('turn.started', onTurn);
    bus.subscribe('*', onAny);

    bus.clear();
    bus.dispatch(makeEvent('turn.started'));

    expect(onTurn).not.toHaveBeenCalled();
    expect(onAny).not.toHaveBeenCalled();
  });

  it('isolates a throwing subscriber from the rest of the loop', () => {
    const bus = new EventSubscriptionBus();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    bus.subscribe('turn.started', bad);
    bus.subscribe('turn.started', good);

    expect(() => bus.dispatch(makeEvent('turn.started'))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('re-subscribing after unsubscribe works', () => {
    const bus = new EventSubscriptionBus();
    const handler = vi.fn();
    const unsub = bus.subscribe('turn.started', handler);
    unsub();
    bus.subscribe('turn.started', handler);

    bus.dispatch(makeEvent('turn.started'));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
