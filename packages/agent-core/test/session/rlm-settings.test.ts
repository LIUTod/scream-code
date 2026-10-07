import { describe, expect, it } from 'vitest';

import {
  normalizeRlmMaxDepth,
  parseRlmMaxDepthArg,
} from '../../src/session/rlm-settings';

describe('normalizeRlmMaxDepth', () => {
  it('treats zero, negatives and non-finite values as unlimited', () => {
    expect(normalizeRlmMaxDepth(0)).toBe(Infinity);
    expect(normalizeRlmMaxDepth(-3)).toBe(Infinity);
    expect(normalizeRlmMaxDepth(Number.NaN)).toBe(Infinity);
    expect(normalizeRlmMaxDepth(Number.POSITIVE_INFINITY)).toBe(Infinity);
    expect(normalizeRlmMaxDepth(Number.NEGATIVE_INFINITY)).toBe(Infinity);
  });

  it('truncates positive fractional values to an integer', () => {
    expect(normalizeRlmMaxDepth(3.9)).toBe(3);
    expect(normalizeRlmMaxDepth(1)).toBe(1);
    // Below 1 the truncation lands on 0, which the recursion check treats as
    // "no deeper spawns" (the preserving behaviour of the pre-existing core
    // clamp). Command surfaces only accept integers, so this is internal-only.
    expect(normalizeRlmMaxDepth(0.5)).toBe(0);
  });
});

describe('parseRlmMaxDepthArg', () => {
  it('accepts non-negative integers (0 = unlimited) and trims whitespace', () => {
    expect(parseRlmMaxDepthArg('0')).toEqual({ ok: true, value: 0 });
    expect(parseRlmMaxDepthArg('3')).toEqual({ ok: true, value: 3 });
    expect(parseRlmMaxDepthArg('  42 ')).toEqual({ ok: true, value: 42 });
  });

  it('rejects empty, fractional, negative, NaN and non-numeric input', () => {
    for (const raw of ['', '   ', '1.5', '-1', 'NaN', 'abc', '1e3', '+2', '0x10']) {
      expect({ raw, result: parseRlmMaxDepthArg(raw).ok }).toEqual({ raw, result: false });
    }
  });

  it('carries a human-readable reason on rejection', () => {
    const negative = parseRlmMaxDepthArg('-1');
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.reason).toContain('-1');

    const empty = parseRlmMaxDepthArg('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain('non-negative integer');
  });

  it('rejects values beyond Number.MAX_SAFE_INTEGER', () => {
    const oversized = parseRlmMaxDepthArg('9007199254740993');
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.reason).toContain('too large');
  });
});
