import { describe, expect, it } from 'vitest';

import { shouldGuardCompaction } from '#/tui/commands/config';

interface GuardState {
  contextTokens: number;
  maxContextTokens: number;
}

function makeState(overrides: Partial<GuardState> = {}): GuardState {
  return {
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  };
}

describe('shouldGuardCompaction (Storm Breaker /compact guard)', () => {
  it('returns null when maxContextTokens is unknown (<= 0)', () => {
    expect(shouldGuardCompaction(makeState({ maxContextTokens: 0 }))).toBeNull();
    expect(shouldGuardCompaction(makeState({ maxContextTokens: -1 }))).toBeNull();
  });

  it('returns null when contextTokens is zero (no session content yet)', () => {
    expect(shouldGuardCompaction(makeState({ contextTokens: 0 }))).toBeNull();
  });

  it('returns guard info when context is below 5% of the window', () => {
    const state = makeState({ contextTokens: 5_000, maxContextTokens: 200_000 }); // 2.5%
    const guard = shouldGuardCompaction(state);
    expect(guard).not.toBeNull();
    expect(guard!.currentTokens).toBe(5_000);
    expect(guard!.maxContextTokens).toBe(200_000);
    expect(guard!.ratio).toBeCloseTo(0.025, 5);
  });

  it('returns null at exactly 5% (boundary — compression is legitimate)', () => {
    const state = makeState({ contextTokens: 10_000, maxContextTokens: 200_000 }); // 5%
    expect(shouldGuardCompaction(state)).toBeNull();
  });

  it('returns null when context is at 20%', () => {
    const state = makeState({ contextTokens: 40_000, maxContextTokens: 200_000 }); // 20%
    expect(shouldGuardCompaction(state)).toBeNull();
  });

  it('returns null when context is well above 20%', () => {
    const state = makeState({ contextTokens: 150_000, maxContextTokens: 200_000 }); // 75%
    expect(shouldGuardCompaction(state)).toBeNull();
  });

  it('guards when context is tiny relative to a small window', () => {
    const state = makeState({ contextTokens: 100, maxContextTokens: 8_000 }); // 1.25%
    const guard = shouldGuardCompaction(state);
    expect(guard).not.toBeNull();
    expect(guard!.ratio).toBeCloseTo(0.0125, 5);
  });
});
