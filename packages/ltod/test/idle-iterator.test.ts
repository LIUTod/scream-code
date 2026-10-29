import { APITimeoutError } from '#/errors';
import {
  StreamIdleTimeoutError,
  getStreamFirstItemTimeoutMs,
  getStreamIdleTimeoutMs,
  iterateWithIdleTimeout,
} from '#/idle-iterator';
import { describe, expect, it } from 'vitest';

async function* fromItems<T>(items: T[], delays: number[] = []): AsyncGenerator<T> {
  for (let i = 0; i < items.length; i++) {
    if (delays[i] !== undefined) await sleep(delays[i]!);
    yield items[i]!;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('getStreamIdleTimeoutMs', () => {
  it('returns the default when env var is unset', () => {
    delete process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'];
    expect(getStreamIdleTimeoutMs()).toBe(60_000);
  });

  it('reads the env var when set', () => {
    process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'] = '5000';
    expect(getStreamIdleTimeoutMs()).toBe(5000);
    delete process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'];
  });

  it('disables the watchdog when set to 0', () => {
    process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'] = '0';
    expect(getStreamIdleTimeoutMs()).toBeUndefined();
    delete process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'];
  });
});

describe('getStreamFirstItemTimeoutMs', () => {
  it('floors to at least idleTimeoutMs', () => {
    process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'] = '200000';
    expect(getStreamFirstItemTimeoutMs(getStreamIdleTimeoutMs())).toBe(200_000);
    delete process.env['SCREAM_STREAM_IDLE_TIMEOUT_MS'];
  });
});

describe('iterateWithIdleTimeout', () => {
  it('passes through items when they arrive in time', async () => {
    const items: number[] = [];
    for await (const item of iterateWithIdleTimeout(fromItems([1, 2, 3], [10, 10, 10]), {
      idleTimeoutMs: 1000,
      firstItemTimeoutMs: 1000,
      errorMessage: 'stalled',
    })) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
  });

  it('throws StreamIdleTimeoutError when the first item takes too long', async () => {
    const slow = fromItems([42], [500]);
    await expect(
      (async () => {
        for await (const _ of iterateWithIdleTimeout(slow, {
          idleTimeoutMs: 1000,
          firstItemTimeoutMs: 50,
          errorMessage: 'stalled',
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', phase: 'first-item' });
  });

  it('throws StreamIdleTimeoutError on idle gap after the first item', async () => {
    const slow = fromItems([1, 2], [10, 500]);
    await expect(
      (async () => {
        for await (const _ of iterateWithIdleTimeout(slow, {
          idleTimeoutMs: 50,
          firstItemTimeoutMs: 1000,
          errorMessage: 'idle stalled',
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', phase: 'idle' });
  });

  it('StreamIdleTimeoutError is an APITimeoutError so retry treats it as retryable', () => {
    const err = new StreamIdleTimeoutError('idle', 'stalled');
    expect(err).toBeInstanceOf(APITimeoutError);
  });

  it('does not enforce timeout when both are disabled', async () => {
    const slow = fromItems([1, 2], [200, 200]);
    const items: number[] = [];
    for await (const item of iterateWithIdleTimeout(slow, {
      idleTimeoutMs: 0,
      firstItemTimeoutMs: 0,
      errorMessage: 'stalled',
    })) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
  });

  it('isProgressItem=false keeps the first-item deadline active', async () => {
    // keepalive items arrive fast but should NOT flip out of awaitingFirstItem
    const keepaliveThenStall = fromItems(
      [{ type: 'keepalive' }, { type: 'progress' }],
      [10, 500],
    );
    await expect(
      (async () => {
        for await (const _ of iterateWithIdleTimeout(keepaliveThenStall, {
          idleTimeoutMs: 50,
          firstItemTimeoutMs: 50,
          errorMessage: 'first stalled',
          isProgressItem: (item) => (item as { type: string }).type === 'progress',
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ phase: 'first-item' });
  });

  it('aborts when the abort signal fires', async () => {
    const controller = new AbortController();
    const slow = fromItems([1, 2, 3], [1000, 1000, 1000]);
    const iter = iterateWithIdleTimeout(slow, {
      idleTimeoutMs: 10_000,
      firstItemTimeoutMs: 10_000,
      errorMessage: 'stalled',
      abortSignal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(
      (async () => {
        for await (const _ of iter) {
          // drain
        }
      })(),
    ).rejects.toBeDefined();
  });
});
