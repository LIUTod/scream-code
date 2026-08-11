import {
  calculateRateLimitBackoffMs,
  isUsageLimitError,
  parseRateLimitReason,
} from '#/rate-limit-utils';
import { describe, expect, it } from 'vitest';

describe('parseRateLimitReason', () => {
  it('classifies explicit quota-will-reset as QUOTA_EXHAUSTED', () => {
    expect(parseRateLimitReason('You have exhausted your capacity. Your quota will reset after 24h')).toBe(
      'QUOTA_EXHAUSTED',
    );
    expect(parseRateLimitReason('quota will reset at 2026-01-01')).toBe('QUOTA_EXHAUSTED');
  });

  it('classifies overloaded / 529 / 503 as MODEL_CAPACITY_EXHAUSTED', () => {
    expect(parseRateLimitReason('The model is overloaded')).toBe('MODEL_CAPACITY_EXHAUSTED');
    expect(parseRateLimitReason('Server returned 529')).toBe('MODEL_CAPACITY_EXHAUSTED');
    expect(parseRateLimitReason('503 Service Unavailable')).toBe('MODEL_CAPACITY_EXHAUSTED');
    expect(parseRateLimitReason('resource exhausted')).toBe('MODEL_CAPACITY_EXHAUSTED');
  });

  it('classifies per-minute rate limit as RATE_LIMIT_EXCEEDED', () => {
    expect(parseRateLimitReason('Rate limit per minute exceeded')).toBe('RATE_LIMIT_EXCEEDED');
    expect(parseRateLimitReason('too many requests')).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('classifies generic quota / exhausted / usage limit as QUOTA_EXHAUSTED', () => {
    expect(parseRateLimitReason('quota exceeded')).toBe('QUOTA_EXHAUSTED');
    expect(parseRateLimitReason('usage limit reached')).toBe('QUOTA_EXHAUSTED');
    expect(parseRateLimitReason('insufficient balance')).toBe('QUOTA_EXHAUSTED');
  });

  it('classifies 500 / internal error as SERVER_ERROR', () => {
    expect(parseRateLimitReason('internal server error')).toBe('SERVER_ERROR');
    expect(parseRateLimitReason('500 internal error')).toBe('SERVER_ERROR');
  });

  it('returns UNKNOWN for unrecognized messages', () => {
    expect(parseRateLimitReason('something weird happened')).toBe('UNKNOWN');
  });
});

describe('calculateRateLimitBackoffMs', () => {
  it('returns 30min for QUOTA_EXHAUSTED', () => {
    expect(calculateRateLimitBackoffMs('QUOTA_EXHAUSTED')).toBe(30 * 60 * 1000);
  });

  it('returns 30s for RATE_LIMIT_EXCEEDED', () => {
    expect(calculateRateLimitBackoffMs('RATE_LIMIT_EXCEEDED')).toBe(30 * 1000);
  });

  it('returns 20s for SERVER_ERROR', () => {
    expect(calculateRateLimitBackoffMs('SERVER_ERROR')).toBe(20 * 1000);
  });

  it('returns 45-75s jittered backoff for MODEL_CAPACITY_EXHAUSTED', () => {
    for (let i = 0; i < 20; i += 1) {
      const ms = calculateRateLimitBackoffMs('MODEL_CAPACITY_EXHAUSTED');
      expect(ms).toBeGreaterThanOrEqual(45 * 1000);
      expect(ms).toBeLessThan(75 * 1000);
    }
  });

  it('falls back to a short 20s backoff for UNKNOWN (avoids multi-hour hang)', () => {
    // UNKNOWN is a classified 429 with no recognized reason; it is not
    // evidence of quota exhaustion, so a 30min backoff (30min x ~9 retries)
    // would hang a turn for hours. Match SERVER_ERROR's 20s instead.
    expect(calculateRateLimitBackoffMs('UNKNOWN')).toBe(20 * 1000);
  });
});

describe('isUsageLimitError', () => {
  it('detects persistent usage-limit messages that need credential switch', () => {
    expect(isUsageLimitError('usage limit reached')).toBe(true);
    expect(isUsageLimitError('quota exceeded')).toBe(true);
    expect(isUsageLimitError('exhausted your capacity')).toBe(true);
    expect(isUsageLimitError('quota will reset')).toBe(true);
    expect(isUsageLimitError('insufficient balance')).toBe(true);
  });

  it('returns false for transient rate-limit messages', () => {
    expect(isUsageLimitError('rate limit per minute')).toBe(false);
    expect(isUsageLimitError('overloaded')).toBe(false);
  });
});
