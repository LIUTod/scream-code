import { describe, expect, it } from 'vitest';

import { detectCompactionAnomaly } from '#/tui/utils/compaction-anomaly';

interface Input {
  lastFinishedAt: number | undefined;
  autoCompactionCount: number;
  currentTokens: number;
  maxContextTokens: number;
  now: number;
}

function makeInput(overrides: Partial<Input> = {}): Input {
  return {
    lastFinishedAt: undefined,
    autoCompactionCount: 0,
    currentTokens: 10_000,
    maxContextTokens: 200_000,
    now: 1_000_000,
    ...overrides,
  };
}

describe('detectCompactionAnomaly (Storm Breaker compaction anomaly guard)', () => {
  it('returns null for routine first auto-compaction at modest usage', () => {
    const input = makeInput({
      autoCompactionCount: 0,
      currentTokens: 100_000,
      maxContextTokens: 200_000, // 50%
      lastFinishedAt: undefined,
    });
    expect(detectCompactionAnomaly(input)).toBeNull();
  });

  it('returns null when previous compaction was long ago', () => {
    const input = makeInput({
      lastFinishedAt: 500_000,
      now: 1_000_000, // 500s later
      autoCompactionCount: 3,
    });
    expect(detectCompactionAnomaly(input)).toBeNull();
  });

  it('detects rapid_refire when previous compaction ended < 30s ago', () => {
    const input = makeInput({
      lastFinishedAt: 1_000_000,
      now: 1_020_000, // 20s later
      autoCompactionCount: 2,
    });
    const result = detectCompactionAnomaly(input);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('rapid_refire');
    expect(result!.detail).toContain('20.0');
  });

  it('does not flag rapid_refire at exactly 30s boundary', () => {
    const input = makeInput({
      lastFinishedAt: 1_000_000,
      now: 1_030_000, // exactly 30s
      autoCompactionCount: 2,
    });
    expect(detectCompactionAnomaly(input)).toBeNull();
  });

  it('detects first_step_blowup when first auto-compaction fires above 70%', () => {
    const input = makeInput({
      autoCompactionCount: 0,
      currentTokens: 150_000,
      maxContextTokens: 200_000, // 75%
      lastFinishedAt: undefined,
    });
    const result = detectCompactionAnomaly(input);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('first_step_blowup');
    expect(result!.detail).toContain('75%');
  });

  it('does not flag first_step_blowup just below 70% threshold', () => {
    const input = makeInput({
      autoCompactionCount: 0,
      currentTokens: 139_000,
      maxContextTokens: 200_000, // 69.5%
      lastFinishedAt: undefined,
    });
    expect(detectCompactionAnomaly(input)).toBeNull();
  });

  it('flags first_step_blowup at exactly 70% boundary', () => {
    const input = makeInput({
      autoCompactionCount: 0,
      currentTokens: 140_000,
      maxContextTokens: 200_000, // exactly 70%
      lastFinishedAt: undefined,
    });
    const result = detectCompactionAnomaly(input);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('first_step_blowup');
  });

  it('does not flag first_step_blowup on the second compaction', () => {
    const input = makeInput({
      autoCompactionCount: 1,
      currentTokens: 180_000,
      maxContextTokens: 200_000, // 90%
      lastFinishedAt: undefined,
    });
    expect(detectCompactionAnomaly(input)).toBeNull();
  });

  it('returns null when maxContextTokens is unknown (avoid divide-by-zero)', () => {
    const input = makeInput({
      autoCompactionCount: 0,
      currentTokens: 999_999,
      maxContextTokens: 0,
      lastFinishedAt: undefined,
    });
    expect(detectCompactionAnomaly(input)).toBeNull();
  });

  it('prioritizes rapid_refire over first_step_blowup when both match', () => {
    const input = makeInput({
      lastFinishedAt: 1_000_000,
      now: 1_010_000, // 10s later
      autoCompactionCount: 0,
      currentTokens: 180_000,
      maxContextTokens: 200_000, // 90% — also qualifies for first_step_blowup
    });
    const result = detectCompactionAnomaly(input);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('rapid_refire');
  });
});
