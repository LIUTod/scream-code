import {
  APIConnectionError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  emptyUsage,
  isRetryableGenerateError,
} from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import { ErrorCodes, ScreamError } from '#/errors';
import type { LoopEvent, LoopEventDispatcher, LoopStepRetryingEvent } from '#/loop/events';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import { chatWithRetry, QUOTA_RETRY_ATTEMPTS } from '#/loop/retry';

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
