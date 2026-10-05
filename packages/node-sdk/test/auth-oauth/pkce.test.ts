import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { base64UrlEncode, generatePKCE, randomUrlSafe } from '../../src/auth-oauth/pkce';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

describe('generatePKCE', () => {
  it('produces a base64url verifier of RFC 7636 length', () => {
    const { verifier } = generatePKCE();
    expect(verifier).toMatch(BASE64URL_PATTERN);
    expect(verifier).toHaveLength(43);
  });

  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = generatePKCE();
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it('generates fresh pairs on every call', () => {
    const first = generatePKCE();
    const second = generatePKCE();
    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe('randomUrlSafe', () => {
  it('returns distinct base64url tokens', () => {
    const a = randomUrlSafe();
    const b = randomUrlSafe();
    expect(a).toMatch(BASE64URL_PATTERN);
    expect(b).toMatch(BASE64URL_PATTERN);
    expect(a).not.toBe(b);
  });

  it('honours the requested byte length', () => {
    expect(randomUrlSafe(16)).toHaveLength(22);
  });
});
