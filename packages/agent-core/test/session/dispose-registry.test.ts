/**
 * SessionDisposables — the close-out checklist behind Session.close().
 *
 * Contracts under test: LIFO release order (last registered, first released),
 * failure isolation with every failure reported in one AggregateError,
 * idempotent disposal, and a single unambiguous owner per registered name.
 */

import { describe, expect, it } from 'vitest';

import { SessionDisposables } from '../../src/session/dispose-registry';

describe('SessionDisposables', () => {
  it('releases in reverse registration order and lists names in registration order', async () => {
    const registry = new SessionDisposables();
    const released: string[] = [];
    registry.add('a', () => {
      released.push('a');
    });
    registry.add('b', () => {
      released.push('b');
    });
    registry.add('c', () => {
      released.push('c');
    });

    expect(registry.names()).toEqual(['a', 'b', 'c']);
    await expect(registry.disposeAll()).resolves.toBeNull();
    expect(released).toEqual(['c', 'b', 'a']);
  });

  it('keeps releasing after a step throws and returns an AggregateError of every failure', async () => {
    const registry = new SessionDisposables();
    const released: string[] = [];
    const firstError = new Error('first');
    const lastError = new Error('last');
    registry.add('first', () => {
      throw firstError;
    });
    registry.add('middle', () => {
      released.push('middle');
    });
    registry.add('last', () => {
      throw lastError;
    });

    const error = await registry.disposeAll();

    // LIFO runs last → middle → first: the middle step ran between the two
    // throwers, so one failure cannot swallow the rest of the checklist.
    expect(released).toEqual(['middle']);
    expect(error).toBeInstanceOf(AggregateError);
    const errors = (error as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(lastError);
    expect(errors[1]).toBe(firstError);
  });

  it('is idempotent: a second disposeAll() runs nothing', async () => {
    const registry = new SessionDisposables();
    let runs = 0;
    registry.add('only', () => {
      runs += 1;
    });

    await registry.disposeAll();
    await expect(registry.disposeAll()).resolves.toBeNull();
    expect(runs).toBe(1);
  });

  it('rejects duplicate names and registration after disposal', async () => {
    const registry = new SessionDisposables();
    registry.add('kept', () => {});
    expect(() => {
      registry.add('kept', () => {});
    }).toThrow(/already registered/);
    // Rejected, not overwritten: the first registration keeps the slot.
    expect(registry.names()).toEqual(['kept']);

    await registry.disposeAll();
    // A step registered after disposal could never run — that is exactly the
    // silent omission this registry exists to prevent, so it is refused.
    expect(() => {
      registry.add('late', () => {});
    }).toThrow(/after disposeAll/);
  });
});
