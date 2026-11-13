import {
  APIConnectionError,
  APIProviderRateLimitError,
  APIStatusError,
  APIStreamFormatError,
  APITimeoutError,
  emptyUsage,
  isRetryableGenerateError,
} from '@scream-code/ltod';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, ScreamError } from '#/errors';
import type { LoopEvent, LoopEventDispatcher, LoopStepRetryingEvent } from '#/loop/events';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import {
  chatWithRetry,
  DEFAULT_MAX_KEY_ROTATIONS,
  QUOTA_RETRY_ATTEMPTS,
  STREAM_FORMAT_RETRY_ATTEMPTS,
} from '#/loop/retry';

function okResponse(): LLMChatResponse {
  return { toolCalls: [], usage: emptyUsage() };
}

function makeInput(
  llm: LLM,
  signal: AbortSignal,
): Parameters<typeof chatWithRetry>[0] {
  return {
    llm,
    params: { messages: [], tools: [], signal },
    dispatchEvent: async () => {},
    turnId: 't',
    currentStep: 1,
    stepUuid: 'u',
  };
}

describe('chatWithRetry: terminated stream drops', () => {
  it('retries an APIConnectionError("terminated") and succeeds on a later attempt', async () => {
    // A mid-stream `terminated` is classified as a retryable APIConnectionError,
    // so an intermittent connection drop should be recovered transparently.
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };

    const response = await chatWithRetry(makeInput(llm, new AbortController().signal));

    expect(calls).toBe(2);
    expect(response).toEqual(okResponse());
  });

  it('does NOT retry when the signal is aborted (user ESC), surfacing a clean AbortError', async () => {
    // Even though `terminated` is retryable, a user-aborted request must never
    // be retried: the abort signal is checked before any retry, so it surfaces
    // as an AbortError rather than a provider error.
    let calls = 0;
    const ac = new AbortController();
    ac.abort();

    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIConnectionError('terminated');
      },
    };

    await expect(chatWithRetry(makeInput(llm, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
  });
});

describe('chatWithRetry: quota-style 429s', () => {
  // A 1ms Retry-After keeps these tests fast; the delay value itself is
  // covered by rate-limit-utils unit tests.
  const quotaError = () =>
    new APIProviderRateLimitError('Allocated quota exceeded', null, 'QUOTA_EXHAUSTED', 1);

  it('retries a quota-429 instead of failing on the first attempt', async () => {
    // Providers phrase transient per-minute quota windows as "quota exceeded";
    // the first 429 must not kill the turn.
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw quotaError();
        return okResponse();
      },
    };

    const response = await chatWithRetry(makeInput(llm, new AbortController().signal));

    expect(calls).toBe(2);
    expect(response).toEqual(okResponse());
  });

  it('gives up after a bounded number of quota attempts instead of a 30min hang', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw quotaError();
      },
    };

    await expect(chatWithRetry(makeInput(llm, new AbortController().signal))).rejects.toMatchObject({
      name: 'APIProviderRateLimitError',
    });
    expect(calls).toBe(QUOTA_RETRY_ATTEMPTS);
  });
});

describe('chatWithRetry: malformed provider streams', () => {
  function splicedStreamError(): APIStreamFormatError {
    return new APIStreamFormatError(
      'Received a tool call argument delta for unknown index 7. Provider: X, model: Y',
    );
  }

  it('retries a spliced stream and succeeds when the retry arrives intact', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw splicedStreamError();
        return okResponse();
      },
    };

    const response = await chatWithRetry(makeInput(llm, new AbortController().signal));
    expect(response.toolCalls).toEqual([]);
    expect(calls).toBe(2);
  });

  it('gives up after a bounded number of stream-format attempts instead of burning the step budget', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw splicedStreamError();
      },
    };

    await expect(chatWithRetry(makeInput(llm, new AbortController().signal))).rejects.toMatchObject({
      name: 'APIStreamFormatError',
    });
    expect(calls).toBe(STREAM_FORMAT_RETRY_ATTEMPTS);
  });
});

describe('chatWithRetry: status-code coverage', () => {
  it.each([408, 501, 520, 524])(
    'retries transient HTTP %i and succeeds on a later attempt',
    async (statusCode) => {
      let calls = 0;
      const llm: LLM = {
        systemPrompt: '',
        modelName: 'mock',
        isRetryableError: (e) => isRetryableGenerateError(e),
        async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
          calls += 1;
          if (calls === 1) throw new APIStatusError(statusCode, 'upstream hiccup');
          return okResponse();
        },
      };

      const response = await chatWithRetry(makeInput(llm, new AbortController().signal));

      expect(calls).toBe(2);
      expect(response).toEqual(okResponse());
    },
  );

  it.each([400, 401, 402, 403, 404, 409, 422])(
    'does NOT retry deterministic HTTP %i',
    async (statusCode) => {
      let calls = 0;
      const llm: LLM = {
        systemPrompt: '',
        modelName: 'mock',
        isRetryableError: (e) => isRetryableGenerateError(e),
        async chat(): Promise<LLMChatResponse> {
          calls += 1;
          throw new APIStatusError(statusCode, 'request is wrong');
        },
      };

      await expect(chatWithRetry(makeInput(llm, new AbortController().signal))).rejects.toMatchObject({
        name: 'APIStatusError',
      });
      expect(calls).toBe(1);
    },
  );
});

describe('chatWithRetry: context overflow', () => {
  it('does NOT retry a ScreamError-wrapped CONTEXT_OVERFLOW (fail fast for compaction)', async () => {
    // Non-ltod provider adapters wrap the overflow as ScreamError. Retrying
    // burns the whole budget on a request only compaction can fix, so the
    // wrapped shape must fail fast exactly like the ltod error class does —
    // the turn-level handler then sees it on attempt 1 and compacts.
    let calls = 0;
    let retryingEvents = 0;
    const dispatchEvent: LoopEventDispatcher = async (event) => {
      if (event.type === 'step.retrying') retryingEvents += 1;
    };
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: () => true, // even a "retryable" verdict must lose to overflow
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new ScreamError(
          ErrorCodes.CONTEXT_OVERFLOW,
          'prompt is too long: 1000 tokens > 500 maximum',
        );
      },
    };

    await expect(
      chatWithRetry({ ...makeInput(llm, new AbortController().signal), dispatchEvent }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONTEXT_OVERFLOW });

    expect(calls).toBe(1);
    expect(retryingEvents).toBe(0);
  });
});

describe('chatWithRetry: step.retrying classification', () => {
  /**
   * Runs one failing attempt through `chatWithRetry` and returns the
   * `step.retrying` event it dispatched, so the payload's classification can
   * be asserted without re-deriving it from the error name.
   */
  async function retryEventFor(error: unknown, retryable = true): Promise<LoopStepRetryingEvent> {
    const events: LoopEvent[] = [];
    let calls = 0;
    const dispatchEvent: LoopEventDispatcher = async (event) => {
      events.push(event);
    };
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: () => retryable,
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw error;
        return okResponse();
      },
    };

    await chatWithRetry({ ...makeInput(llm, new AbortController().signal), dispatchEvent });

    const retrying = events.find((event) => event.type === 'step.retrying');
    if (retrying?.type !== 'step.retrying') throw new Error('expected a step.retrying event');
    return retrying;
  }

  it('classifies a timeout as provider.timeout', async () => {
    const event = await retryEventFor(new APITimeoutError('request timed out'));
    expect(event.errorCode).toBe(ErrorCodes.PROVIDER_TIMEOUT);
  });

  it('classifies a connection drop as provider.connection_error', async () => {
    const event = await retryEventFor(new APIConnectionError('terminated'));
    expect(event.errorCode).toBe(ErrorCodes.PROVIDER_CONNECTION_ERROR);
  });

  it('classifies a spliced tool-call stream as provider.stream_error', async () => {
    const event = await retryEventFor(
      new APIStreamFormatError('Received a tool call argument delta for unknown index 7'),
    );
    expect(event.errorCode).toBe(ErrorCodes.PROVIDER_STREAM_ERROR);
  });

  it('classifies a 429 as provider.rate_limit and keeps the status code', async () => {
    // A retried 429 would sleep out a real 20s rate-limit window. The
    // `step.retrying` event is dispatched before that sleep, so aborting from
    // the dispatcher cuts the wait while still observing the payload.
    const events: LoopEvent[] = [];
    const controller = new AbortController();
    let calls = 0;
    const dispatchEvent: LoopEventDispatcher = async (event) => {
      events.push(event);
      if (event.type === 'step.retrying') controller.abort();
    };
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: () => true,
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIProviderRateLimitError('slow down');
      },
    };

    await expect(
      chatWithRetry({ ...makeInput(llm, controller.signal), dispatchEvent }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(calls).toBe(1);
    const retrying = events.find((event) => event.type === 'step.retrying');
    if (retrying?.type !== 'step.retrying') throw new Error('expected a step.retrying event');
    expect(retrying.errorCode).toBe(ErrorCodes.PROVIDER_RATE_LIMIT);
    expect(retrying.statusCode).toBe(429);
  });

  it('classifies a transient status error as provider.api_error', async () => {
    const event = await retryEventFor(new APIStatusError(501, 'upstream broke'));
    expect(event.errorCode).toBe(ErrorCodes.PROVIDER_API_ERROR);
    expect(event.statusCode).toBe(501);
  });

  it('omits errorCode when the error carries no classification', async () => {
    // A custom retryability verdict can retry anything, including errors the
    // error protocol does not classify. Those must stay unlabelled rather than
    // being reported as `internal`, so consumers keep their own fallback.
    const event = await retryEventFor(new Error('mystery failure'));
    expect(event.errorCode).toBeUndefined();
  });
});

describe('chatWithRetry: API-key rotation on quota-429s', () => {
  const quotaError = () =>
    new APIProviderRateLimitError('Allocated quota exceeded', null, 'QUOTA_EXHAUSTED', 1);

  function makeRotatingInput(
    llm: LLM,
    signal: AbortSignal,
    events: LoopStepRetryingEvent[],
    maxRotations?: number,
  ): Parameters<typeof chatWithRetry>[0] {
    return {
      llm,
      params: { messages: [], tools: [], signal },
      dispatchEvent: (async (event: LoopEvent) => {
        if (event.type === 'step.retrying') events.push(event);
      }) as LoopEventDispatcher,
      turnId: 't',
      currentStep: 1,
      stepUuid: 'u',
      ...(maxRotations === undefined ? {} : { maxRotations }),
    };
  }

  it('retries immediately on a rotated key instead of paying the quota backoff', async () => {
    let calls = 0;
    const rotateAuth = vi.fn(() => true);
    const events: LoopStepRetryingEvent[] = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      rotateAuth,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw quotaError();
        return okResponse();
      },
    };

    const response = await chatWithRetry(
      makeRotatingInput(llm, new AbortController().signal, events),
    );

    expect(response).toEqual(okResponse());
    expect(calls).toBe(2);
    expect(rotateAuth).toHaveBeenCalledTimes(1);
    // A rotation is an immediate re-issue: the retry event carries no wait.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ failedAttempt: 1, nextAttempt: 1, delayMs: 0 });
  });

  it('caps rotations and still spends the full quota attempt budget afterwards', async () => {
    let calls = 0;
    const rotateAuth = vi.fn(() => true);
    const events: LoopStepRetryingEvent[] = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      rotateAuth,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw quotaError();
      },
    };

    await expect(
      chatWithRetry(makeRotatingInput(llm, new AbortController().signal, events)),
    ).rejects.toMatchObject({ name: 'APIProviderRateLimitError' });

    // Rotations are free of the attempt budget, so the request gets
    // `DEFAULT_MAX_KEY_ROTATIONS` immediate hops AND `QUOTA_RETRY_ATTEMPTS`
    // backoff attempts before surfacing the error.
    expect(rotateAuth).toHaveBeenCalledTimes(DEFAULT_MAX_KEY_ROTATIONS);
    expect(calls).toBe(DEFAULT_MAX_KEY_ROTATIONS + QUOTA_RETRY_ATTEMPTS);
  });

  it('keeps today quota behavior when no other key is usable', async () => {
    let calls = 0;
    const rotateAuth = vi.fn(() => false);
    const events: LoopStepRetryingEvent[] = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      rotateAuth,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw quotaError();
      },
    };

    await expect(
      chatWithRetry(makeRotatingInput(llm, new AbortController().signal, events)),
    ).rejects.toMatchObject({ name: 'APIProviderRateLimitError' });

    expect(calls).toBe(QUOTA_RETRY_ATTEMPTS);
    expect(rotateAuth).toHaveBeenCalledTimes(QUOTA_RETRY_ATTEMPTS);
  });

  it('honours an explicit rotation cap', async () => {
    let calls = 0;
    const rotateAuth = vi.fn(() => true);
    const events: LoopStepRetryingEvent[] = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      rotateAuth,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw quotaError();
      },
    };

    await expect(
      chatWithRetry(makeRotatingInput(llm, new AbortController().signal, events, 1)),
    ).rejects.toMatchObject({ name: 'APIProviderRateLimitError' });

    expect(rotateAuth).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1 + QUOTA_RETRY_ATTEMPTS);
  });

  it('does not rotate on non-quota rate limits', async () => {
    let calls = 0;
    const rotateAuth = vi.fn(() => true);
    const events: LoopStepRetryingEvent[] = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      rotateAuth,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) {
          throw new APIProviderRateLimitError('Too many requests', null, 'RATE_LIMIT_EXCEEDED', 1);
        }
        return okResponse();
      },
    };

    const response = await chatWithRetry(
      makeRotatingInput(llm, new AbortController().signal, events),
    );

    expect(response).toEqual(okResponse());
    expect(calls).toBe(2);
    expect(rotateAuth).not.toHaveBeenCalled();
  });
});
