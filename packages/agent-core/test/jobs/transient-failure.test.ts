import { describe, expect, it } from 'vitest';

import { isTransientFailure } from '../../src/errors';

describe('isTransientFailure', () => {
  it('waits out timeouts, a network that is down, overload and broken streams', () => {
    for (const code of ['provider.timeout', 'provider.connection_error', 'provider.rate_limit', 'provider.stream_error'] as const) {
      expect(isTransientFailure({ code })).toBe(true);
    }
  });

  it('treats a provider outage (5xx) as transient and a bad request (4xx) as not', () => {
    expect(isTransientFailure({ code: 'provider.api_error', details: { statusCode: 503 } })).toBe(true);
    expect(isTransientFailure({ code: 'provider.api_error', details: { statusCode: 400 } })).toBe(false);
    expect(isTransientFailure({ code: 'provider.api_error' })).toBe(false);
  });

  it('never retries what needs a person: a rejected key, or no error at all', () => {
    expect(isTransientFailure({ code: 'provider.auth_error' })).toBe(false);
    expect(isTransientFailure(undefined)).toBe(false);
  });
});
