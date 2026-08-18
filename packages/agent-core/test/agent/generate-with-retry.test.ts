import { APIConnectionError, APIProviderRateLimitError } from '@scream-code/ltod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testAgent } from './harness/agent';

describe('Agent.generateWithRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('honors the provider Retry-After instead of the bare backoff', async () => {
    const ctx = testAgent();
    ctx.configure();
    vi.useFakeTimers();

    const generate = vi
      .fn()
      .mockImplementationOnce(() => {
        // 429 with a Retry-After of 2s (well above the 500ms default backoff).
        throw new APIProviderRateLimitError('rate limited', null, 'RATE_LIMIT_EXCEEDED', 2000);
      })
      .mockResolvedValueOnce({ message: { role: 'assistant', content: [], toolCalls: [] } });
    Object.defineProperty(ctx.agent, 'generate', { get: () => generate, configurable: true });

    const promise = ctx.agent.generateWithRetry(
      ctx.agent.config.provider,
      'system',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
    );

    // First attempt already threw; the retry must wait out Retry-After (2s),
    // not the 500ms bare backoff.
    await vi.advanceTimersByTimeAsync(1500);
    expect(generate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600);
    await expect(promise).resolves.toBeDefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('succeeds on a retryable error with the default backoff', async () => {
    const ctx = testAgent();
    ctx.configure();
    vi.useFakeTimers();

    const generate = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new APIConnectionError('temporary connection failure');
      })
      .mockResolvedValueOnce({ message: { role: 'assistant', content: [], toolCalls: [] } });
    Object.defineProperty(ctx.agent, 'generate', { get: () => generate, configurable: true });

    const promise = ctx.agent.generateWithRetry(
      ctx.agent.config.provider,
      'system',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
    );

    await vi.advanceTimersByTimeAsync(500); // default 500ms first backoff
    await vi.advanceTimersByTimeAsync(20); // flush the chained retry
    await expect(promise).resolves.toBeDefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
