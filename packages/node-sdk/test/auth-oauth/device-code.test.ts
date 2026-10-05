import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pollOAuthDeviceCodeFlow } from '../../src/auth-oauth/device-code';

describe('pollOAuthDeviceCodeFlow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the completed value after pending polls', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'complete', value: 'token' });
    const promise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      poll,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(1100);
    await expect(promise).resolves.toBe('token');
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('waits one interval before the first poll when requested', async () => {
    const poll = vi.fn().mockResolvedValueOnce({ status: 'complete', value: 'x' });
    const promise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      waitBeforeFirstPoll: true,
      poll,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    await expect(promise).resolves.toBe('x');
  });

  it('grows the interval on slow_down, preferring the server value', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'slow_down', intervalSeconds: 7 })
      .mockResolvedValueOnce({ status: 'complete', value: 'x' });
    const promise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      poll,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(1); // still sleeping out the 7s interval
    await vi.advanceTimersByTimeAsync(4100);
    await expect(promise).resolves.toBe('x');
  });

  it('rejects when the server reports a hard failure', async () => {
    const poll = vi.fn().mockResolvedValueOnce({ status: 'failed', message: 'denied' });
    await expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 1,
        poll,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('denied');
  });

  it('rejects with the cancel message when the signal aborts', async () => {
    const controller = new AbortController();
    const poll = vi.fn().mockResolvedValue({ status: 'pending' });
    const promise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      poll,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await expect(promise).rejects.toThrow('Login cancelled');
  });

  it('times out when the deadline elapses without completion', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'pending' });
    const promise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 1,
      expiresInSeconds: 2,
      poll,
      signal: new AbortController().signal,
    });
    const assertion = expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });
});
