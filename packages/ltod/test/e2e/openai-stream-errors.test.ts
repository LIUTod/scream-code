import { APIStatusError, ChatProviderError, isRetryableGenerateError } from '#/errors';
import { createProvider } from '#/providers/index';
import { describe, expect, it } from 'vitest';

import { createFakeProviderHarness } from './fake-provider-harness';

describe.each([
  { type: 'openai', endpoint: '/v1/chat/completions' },
  { type: 'openai_responses', endpoint: '/v1/responses' },
] as const)('$type stream error status', ({ type, endpoint }) => {
  async function requestError(message: string, httpStatus = 200): Promise<unknown> {
    const harness = await createFakeProviderHarness();
    try {
      harness.route('POST', endpoint, async (_request, reply) => {
        const error = { message, type: 'server_error' };
        const headers = { 'x-request-id': 'req-stream-error' };
        if (httpStatus !== 200) {
          await reply.json(httpStatus, { error }, headers);
          return;
        }
        const partial = type === 'openai'
          ? { choices: [{ index: 0, delta: { content: 'Partial output' }, finish_reason: null }] }
          : { type: 'response.output_text.delta', delta: 'Partial output' };
        await reply.sseJson(200, [partial, { error }], headers);
      });
      const provider = createProvider({
        type,
        model: 'gpt-4.1',
        apiKey: 'test-key',
        baseUrl: `${harness.baseUrl}/v1`,
      });
      try {
        const stream = await provider.generate('', [], [
          { role: 'user', content: [{ type: 'text', text: 'Reply OK.' }], toolCalls: [] },
        ]);
        for await (const part of stream) void part;
      } catch (error) {
        return error;
      }
      throw new Error('Expected the upstream error to reject the request');
    } finally {
      await harness.close();
    }
  }

  it.each([
    { status: 400, retryable: false },
    { status: 401, retryable: false },
    { status: 403, retryable: false },
    { status: 408, retryable: true },
    { status: 429, retryable: true },
    { status: 500, retryable: true },
    { status: 503, retryable: true },
    { status: 599, retryable: true },
  ])('classifies an SSE $status as retryable=$retryable', async ({ status, retryable }) => {
    const error = await requestError(`Streaming response failed: [${status}] Upstream failure`);

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({ statusCode: status, requestId: 'req-stream-error' });
    expect(isRetryableGenerateError(error)).toBe(retryable);
  });

  it.each([
    { httpStatus: 401, embeddedStatus: 500, retryable: false },
    { httpStatus: 500, embeddedStatus: 401, retryable: true },
  ])('keeps HTTP $httpStatus authoritative over embedded $embeddedStatus', async ({ httpStatus, embeddedStatus, retryable }) => {
    const error = await requestError(
      `Streaming response failed: [${embeddedStatus}] Upstream failure`,
      httpStatus,
    );

    expect(error).toMatchObject({ statusCode: httpStatus });
    expect(isRetryableGenerateError(error)).toBe(retryable);
  });

  it.each([
    // No HTTP status is invented; retryability may still follow the
    // conservative message policy for clearly transient bracketed 5xx text.
    { message: 'Internal server error [500]', retryable: true },
    { message: 'Details: Streaming response failed: [500] Upstream failure', retryable: true },
    { message: 'Streaming response failed: [200] Unexpected success', retryable: false },
    { message: 'Streaming response failed: [5000] Invalid status', retryable: false },
    { message: 'Streaming response failed: [500', retryable: false },
    { message: 'Connection limit exceeded', retryable: false },
    { message: 'insufficient_quota: key budget exceeded', retryable: false },
  ])(
    'does not infer a status from unrelated or malformed messages: $message',
    async ({ message, retryable }) => {
      const error = await requestError(message);

      expect(error).toBeInstanceOf(ChatProviderError);
      expect(error).not.toBeInstanceOf(APIStatusError);
      expect(isRetryableGenerateError(error)).toBe(retryable);
    },
  );
});
