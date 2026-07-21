import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIOrphanedToolCallError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isOrphanedToolCallError,
  isProviderRateLimitError,
  isRetryableGenerateError,
  normalizeAPIStatusError,
} from '#/errors';
import { describe, expect, it } from 'vitest';

describe('ChatProviderError', () => {
  it('is an instance of Error', () => {
    const err = new ChatProviderError('base error');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.message).toBe('base error');
    expect(err.name).toBe('ChatProviderError');
  });
});

describe('APIConnectionError', () => {
  it('extends ChatProviderError', () => {
    const err = new APIConnectionError('connection refused');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIConnectionError');
    expect(err.message).toBe('connection refused');
  });
});

describe('APITimeoutError', () => {
  it('extends ChatProviderError', () => {
    const err = new APITimeoutError('request timed out after 30s');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APITimeoutError');
    expect(err.message).toBe('request timed out after 30s');
  });
});

describe('APIStatusError', () => {
  it('extends ChatProviderError and stores status code', () => {
    const err = new APIStatusError(429, 'rate limited', 'req-abc');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIStatusError');
    expect(err.message).toBe('rate limited');
    expect(err.statusCode).toBe(429);
    expect(err.requestId).toBe('req-abc');
  });

  it('accepts null requestId', () => {
    const err = new APIStatusError(500, 'server error', null);
    expect(err.statusCode).toBe(500);
    expect(err.requestId).toBeNull();
  });

  it('defaults requestId to null when omitted', () => {
    const err = new APIStatusError(502, 'bad gateway');
    expect(err.statusCode).toBe(502);
    expect(err.requestId).toBeNull();
  });
});

describe('APIEmptyResponseError', () => {
  it('extends ChatProviderError', () => {
    const err = new APIEmptyResponseError('empty response');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIEmptyResponseError');
    expect(err.message).toBe('empty response');
  });
});

describe('APIContextOverflowError', () => {
  it('extends APIStatusError and preserves HTTP details', () => {
    const err = new APIContextOverflowError(400, 'Context length exceeded', 'req-context');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIContextOverflowError');
    expect(err.statusCode).toBe(400);
    expect(err.requestId).toBe('req-context');
  });
});

describe('APIProviderRateLimitError', () => {
  it('extends APIStatusError with status 429', () => {
    const err = new APIProviderRateLimitError('too many requests', 'req-429');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIProviderRateLimitError');
    expect(err.statusCode).toBe(429);
    expect(err.requestId).toBe('req-429');
  });

  it('defaults requestId to null when omitted', () => {
    const err = new APIProviderRateLimitError('rate limited');
    expect(err.requestId).toBeNull();
  });

  it('defaults reason to UNKNOWN when not provided', () => {
    const err = new APIProviderRateLimitError('rate limited');
    expect(err.reason).toBe('UNKNOWN');
  });

  it('carries the reason passed in', () => {
    const err = new APIProviderRateLimitError('quota will reset', null, 'QUOTA_EXHAUSTED');
    expect(err.reason).toBe('QUOTA_EXHAUSTED');
  });
});

describe('isRetryableGenerateError', () => {
  it('matches transient provider errors and empty generate responses', () => {
    expect(isRetryableGenerateError(new APIConnectionError('conn'))).toBe(true);
    expect(isRetryableGenerateError(new APITimeoutError('timeout'))).toBe(true);
    expect(isRetryableGenerateError(new APIEmptyResponseError('empty'))).toBe(true);
  });

  it.each([429, 500, 502, 503, 504])('treats HTTP %i as retryable', (statusCode) => {
    expect(isRetryableGenerateError(new APIStatusError(statusCode, 'retryable'))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('treats HTTP %i as non-retryable', (statusCode) => {
    expect(isRetryableGenerateError(new APIStatusError(statusCode, 'non-retryable'))).toBe(false);
  });

  it('does not retry context overflow or unknown errors', () => {
    expect(
      isRetryableGenerateError(new APIContextOverflowError(400, 'Context length exceeded')),
    ).toBe(false);
    expect(isRetryableGenerateError(new Error('boom'))).toBe(false);
    expect(isRetryableGenerateError('boom')).toBe(false);
  });

  it('retries rate-limit 429 unless quota is exhausted', () => {
    const transient = new APIProviderRateLimitError('rate limit per minute', null, 'RATE_LIMIT_EXCEEDED');
    const capacity = new APIProviderRateLimitError('overloaded', null, 'MODEL_CAPACITY_EXHAUSTED');
    const quota = new APIProviderRateLimitError('quota will reset', null, 'QUOTA_EXHAUSTED');

    expect(isRetryableGenerateError(transient)).toBe(true);
    expect(isRetryableGenerateError(capacity)).toBe(true);
    expect(isRetryableGenerateError(quota)).toBe(false);
  });
});

describe('error hierarchy instanceof checks', () => {
  it('all error types are instanceof ChatProviderError', () => {
    const errors = [
      new APIConnectionError('conn'),
      new APITimeoutError('timeout'),
      new APIStatusError(400, 'status', null),
      new APIContextOverflowError(400, 'context length exceeded'),
      new APIProviderRateLimitError('rate limited'),
      new APIEmptyResponseError('empty'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(ChatProviderError);
    }
  });

  it('specific types are distinguishable', () => {
    const connErr = new APIConnectionError('conn');
    const statusErr = new APIStatusError(400, 'status', null);

    expect(connErr).not.toBeInstanceOf(APIStatusError);
    expect(statusErr).not.toBeInstanceOf(APIConnectionError);
  });

  it('can catch with ChatProviderError and inspect subtype', () => {
    const err: ChatProviderError = new APIStatusError(404, 'not found', 'req-123');

    if (err instanceof APIStatusError) {
      expect(err.statusCode).toBe(404);
      expect(err.requestId).toBe('req-123');
    } else {
      expect.unreachable('Expected APIStatusError');
    }
  });
});

describe('normalizeAPIStatusError', () => {
  it.each([
    [400, 'Context length exceeded'],
    [400, 'Exceeded max tokens'],
    [413, 'Context length exceeded'],
    [422, 'Maximum context window exceeded'],
    [400, 'context_length_exceeded'],
    [422, 'Too many tokens in prompt'],
    [400, 'prompt is too long: 210000 tokens exceeds the maximum'],
    [400, 'input token count 131072 exceeds the maximum number of tokens allowed'],
    [400, 'Invalid request: Your request exceeded model token limit: 262144 (requested: 274613)'],
  ])('normalizes %i "%s" to APIContextOverflowError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message, 'req-context');
    expect(error).toBeInstanceOf(APIContextOverflowError);
    expect(error.statusCode).toBe(statusCode);
    expect(error.requestId).toBe('req-context');
  });

  it.each([
    [401, 'Context length exceeded'],
    [500, 'Context length exceeded'],
    [400, 'Bad request'],
    [422, 'Invalid tool schema'],
    [400, 'max_tokens must be less than or equal to 4096'],
    [422, 'max_output_tokens must not exceed 8192'],
    [400, 'max tokens must not exceed the configured output limit'],
  ])('keeps %i "%s" as APIStatusError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).not.toBeInstanceOf(APIContextOverflowError);
  });

  it('normalizes 429 to APIProviderRateLimitError', () => {
    const error = normalizeAPIStatusError(429, 'Too Many Requests', 'req-rate');
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.statusCode).toBe(429);
    expect(error.requestId).toBe('req-rate');
  });

  it('parses the reason from the 429 message', () => {
    const quota = normalizeAPIStatusError(429, 'Your quota will reset after 24h');
    const capacity = normalizeAPIStatusError(429, 'The model is overloaded');
    const rateLimit = normalizeAPIStatusError(429, 'rate limit per minute exceeded');
    expect((quota as APIProviderRateLimitError).reason).toBe('QUOTA_EXHAUSTED');
    expect((capacity as APIProviderRateLimitError).reason).toBe('MODEL_CAPACITY_EXHAUSTED');
    expect((rateLimit as APIProviderRateLimitError).reason).toBe('RATE_LIMIT_EXCEEDED');
  });
});

describe('isProviderRateLimitError', () => {
  it('matches APIProviderRateLimitError instances', () => {
    expect(isProviderRateLimitError(new APIProviderRateLimitError('rate limited'))).toBe(true);
  });

  it('matches APIStatusError with statusCode 429', () => {
    expect(isProviderRateLimitError(new APIStatusError(429, 'too many requests'))).toBe(true);
  });

  it('matches errors with rate limit message patterns', () => {
    expect(isProviderRateLimitError(new Error('rate-limited by provider'))).toBe(true);
    expect(isProviderRateLimitError(new Error('too many requests'))).toBe(true);
    expect(isProviderRateLimitError(new Error('reached max rpm'))).toBe(true);
  });

  it('does not match non-rate-limit errors', () => {
    expect(isProviderRateLimitError(new APIStatusError(500, 'server error'))).toBe(false);
    expect(isProviderRateLimitError(new APIConnectionError('connection refused'))).toBe(false);
    expect(isProviderRateLimitError(new Error('something else'))).toBe(false);
  });
});

describe('APIOrphanedToolCallError classification', () => {
  it('normalizeAPIStatusError maps 400 orphaned-history messages to the typed error', () => {
    const insufficient = normalizeAPIStatusError(
      400,
      'messages.6: insufficient tool messages following assistant tool_calls',
    );
    expect(insufficient).toBeInstanceOf(APIOrphanedToolCallError);
    expect(insufficient.statusCode).toBe(400);

    const followed = normalizeAPIStatusError(
      400,
      "messages.4: `tool_calls` must be followed by tool messages",
    );
    expect(followed).toBeInstanceOf(APIOrphanedToolCallError);
  });

  it('normalizeAPIStatusError leaves unrelated 400s as plain APIStatusError', () => {
    const malformed = normalizeAPIStatusError(400, 'invalid arguments for tool_calls: malformed JSON');
    expect(malformed).toBeInstanceOf(APIStatusError);
    expect(malformed).not.toBeInstanceOf(APIOrphanedToolCallError);
  });

  it('isOrphanedToolCallError matches the typed error by class', () => {
    expect(isOrphanedToolCallError(new APIOrphanedToolCallError(400, 'x'))).toBe(true);
  });

  it('isOrphanedToolCallError matches wrapped errors by message, in any fragment order', () => {
    expect(isOrphanedToolCallError(new Error('insufficient tool messages'))).toBe(true);
    expect(
      isOrphanedToolCallError(new Error('must be followed by tool messages (tool_calls)')),
    ).toBe(true);
    // ScreamError-style wrapping: prefix text around the provider message.
    expect(
      isOrphanedToolCallError(new Error('provider.api_error: insufficient tool messages (request id abc)')),
    ).toBe(true);
  });

  it('isOrphanedToolCallError rejects transient 400s that merely mention tool_calls', () => {
    expect(isOrphanedToolCallError(new Error('invalid arguments for tool_calls: malformed JSON'))).toBe(false);
    expect(isOrphanedToolCallError(new APIStatusError(400, 'bad request'))).toBe(false);
    expect(isOrphanedToolCallError(new Error('network unreachable'))).toBe(false);
  });
});
