import {
  APIConnectionError,
  APIProviderRateLimitError,
  APIStatusError,
  emptyUsage,
  isRetryableGenerateError,
} from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

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
