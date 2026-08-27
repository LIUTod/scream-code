import { describe, expect, it, vi } from 'vitest';

import { EventSubscriptionBus } from '#/agent/events';
import type { AgentEvent } from '#/rpc';

function makeEvent(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type, ...extra } as unknown as AgentEvent;
}

/** Let pending microtasks and macrotasks run so a rejection would surface. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Records every `unhandledRejection` raised while `run` executes. A listener is
 * attached for the whole window, which also keeps Node from aborting the
 * process if the isolation under test ever regresses.
 */
async function withRejectionRecorder(
  run: (rejections: unknown[]) => Promise<void> | void,
): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await run(rejections);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return rejections;
}

describe('EventSubscriptionBus async handler isolation', () => {
  it('does not throw and raises no unhandledRejection for a rejected typed handler', async () => {
    const bus = new EventSubscriptionBus();
    bus.subscribe('turn.started', async () => {
      throw new Error('async boom');
    });

    const rejections = await withRejectionRecorder(async () => {
      expect(() => bus.dispatch(makeEvent('turn.started'))).not.toThrow();
      await settle();
    });

    expect(rejections).toEqual([]);
  });

  it('does not throw and raises no unhandledRejection for a rejected wildcard handler', async () => {
    const bus = new EventSubscriptionBus();
    bus.subscribe('*', async () => {
      await Promise.resolve();
      throw new Error('async wildcard boom');
    });

    const rejections = await withRejectionRecorder(async () => {
      expect(() => bus.dispatch(makeEvent('tool.call.started'))).not.toThrow();
      await settle();
    });

    expect(rejections).toEqual([]);
  });

  it('keeps delivering to later handlers after an async rejection in the same type', async () => {
    const bus = new EventSubscriptionBus();
    const bad = vi.fn(async () => {
      throw new Error('async boom');
    });
    const good = vi.fn();
    bus.subscribe('turn.started', bad);
    bus.subscribe('turn.started', good);

    const rejections = await withRejectionRecorder(async () => {
      bus.dispatch(makeEvent('turn.started'));
      await settle();
    });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
  });

  it('still reaches the wildcard loop after a typed handler rejects', async () => {
    const bus = new EventSubscriptionBus();
    const onAny = vi.fn();
    bus.subscribe('turn.started', async () => {
      throw new Error('async boom');
    });
    bus.subscribe('*', onAny);

    const rejections = await withRejectionRecorder(async () => {
      bus.dispatch(makeEvent('turn.started'));
      await settle();
    });

    expect(onAny).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
  });

  it('runs an async handler to completion when it does not reject', async () => {
    const bus = new EventSubscriptionBus();
    let finished = false;
    bus.subscribe('turn.started', async () => {
      await Promise.resolve();
      finished = true;
    });

    bus.dispatch(makeEvent('turn.started'));
    await settle();

    expect(finished).toBe(true);
  });

  it('still isolates a synchronously throwing handler', async () => {
    const bus = new EventSubscriptionBus();
    const bad = vi.fn(() => {
      throw new Error('sync boom');
    });
    const good = vi.fn();
    bus.subscribe('turn.started', bad);
    bus.subscribe('turn.started', good);

    const rejections = await withRejectionRecorder(async () => {
      expect(() => bus.dispatch(makeEvent('turn.started'))).not.toThrow();
      await settle();
    });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
  });

  it('isolates a mix of sync throws and async rejections across both loops', async () => {
    const bus = new EventSubscriptionBus();
    const typedAfterBad = vi.fn();
    const wildcardAfterBad = vi.fn();
    bus.subscribe('turn.started', () => {
      throw new Error('sync boom');
    });
    bus.subscribe('turn.started', async () => {
      throw new Error('async boom');
    });
    bus.subscribe('turn.started', typedAfterBad);
    bus.subscribe('*', () => {
      throw new Error('sync wildcard boom');
    });
    bus.subscribe('*', async () => {
      throw new Error('async wildcard boom');
    });
    bus.subscribe('*', wildcardAfterBad);

    const rejections = await withRejectionRecorder(async () => {
      expect(() => bus.dispatch(makeEvent('turn.started'))).not.toThrow();
      await settle();
    });

    expect(typedAfterBad).toHaveBeenCalledTimes(1);
    expect(wildcardAfterBad).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
  });
});
