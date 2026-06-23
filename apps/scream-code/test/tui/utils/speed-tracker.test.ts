import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN_ESTIMATE,
  easeSpeedRatio,
  estimateTokens,
  getSharedSpeedTracker,
  lerpHex,
  resetSharedSpeedTracker,
  SPEED_MAX,
  SPEED_WINDOW_MS,
  SpeedTracker,
} from '#/tui/utils/speed-tracker';

describe('SpeedTracker', () => {
  it('returns 0 when no observations have been recorded', () => {
    const tracker = new SpeedTracker();
    expect(tracker.getSpeed(1000)).toBe(0);
  });

  it('averages observations within the rolling window', () => {
    const tracker = new SpeedTracker();
    tracker.observe(100, 0);
    tracker.observe(200, 100);
    expect(tracker.getSpeed(200)).toBeCloseTo(150, 1);
  });

  it('drops observations older than the window', () => {
    const tracker = new SpeedTracker();
    tracker.observe(100, 0);
    tracker.observe(200, 100);
    expect(tracker.getSpeed(SPEED_WINDOW_MS + 200)).toBe(0);
  });

  it('keeps only in-window observations when computing the average', () => {
    const tracker = new SpeedTracker();
    tracker.observe(1000, 0);
    tracker.observe(50, SPEED_WINDOW_MS - 100);
    tracker.observe(50, SPEED_WINDOW_MS - 50);
    // Query 1ms past the window so the time-0 observation is pruned
    expect(tracker.getSpeed(SPEED_WINDOW_MS + 1)).toBeCloseTo(50, 1);
  });

  it('clamps rates to SPEED_MAX so a single burst cannot poison the average', () => {
    const tracker = new SpeedTracker();
    tracker.observe(10_000, 0);
    expect(tracker.getSpeed(100)).toBe(SPEED_MAX);
  });

  it('ignores non-finite or negative rates', () => {
    const tracker = new SpeedTracker();
    tracker.observe(Number.NaN, 0);
    tracker.observe(-5, 0);
    tracker.observe(100, 100);
    expect(tracker.getSpeed(200)).toBe(100);
  });

  it('reset clears all observations', () => {
    const tracker = new SpeedTracker();
    tracker.observe(100, 0);
    tracker.reset();
    expect(tracker.getSpeed(100)).toBe(0);
  });
});

describe('shared speed tracker', () => {
  it('resetSharedSpeedTracker clears the singleton', () => {
    const shared = getSharedSpeedTracker();
    shared.observe(100, 0);
    expect(shared.getSpeed(100)).toBe(100);
    resetSharedSpeedTracker();
    expect(shared.getSpeed(100)).toBe(0);
  });
});

describe('lerpHex', () => {
  it('returns the `from` color at t=0', () => {
    expect(lerpHex('#000000', '#ffffff', 0)).toBe('#000000');
  });

  it('returns the `to` color at t=1', () => {
    expect(lerpHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('clamps t below 0 and above 1', () => {
    expect(lerpHex('#000000', '#ffffff', -1)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 2)).toBe('#ffffff');
  });

  it('interpolates the midpoint at t=0.5', () => {
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('estimateTokens', () => {
  it('estimates tokens from character count via CHARS_PER_TOKEN_ESTIMATE', () => {
    const chars = Math.round(CHARS_PER_TOKEN_ESTIMATE * 10);
    expect(estimateTokens('x'.repeat(chars))).toBe(10);
  });

  it('returns at least 1 token for any non-empty delta', () => {
    expect(estimateTokens('a')).toBe(1);
  });

  it('returns 1 for an empty delta (max(1, 0) = 1)', () => {
    expect(estimateTokens('')).toBe(1);
  });
});

describe('easeSpeedRatio', () => {
  it('returns 0 at ratio 0', () => {
    expect(easeSpeedRatio(0)).toBe(0);
  });

  it('returns 1 at ratio 1', () => {
    expect(easeSpeedRatio(1)).toBe(1);
  });

  it('clamps below 0 and above 1', () => {
    expect(easeSpeedRatio(-1)).toBe(0);
    expect(easeSpeedRatio(2)).toBe(1);
  });

  it('returns 0.5 at ratio 0.5 (smoothstep symmetry)', () => {
    expect(easeSpeedRatio(0.5)).toBeCloseTo(0.5, 5);
  });

  it('stays low at small ratios — gentler than sqrt at the start', () => {
    // sqrt(0.1) ≈ 0.316 — smoothstep should be well below that.
    expect(easeSpeedRatio(0.1)).toBeLessThan(0.05);
    expect(easeSpeedRatio(0.1)).toBeLessThan(Math.sqrt(0.1));
  });

  it('reaches high values only near ratio 1', () => {
    expect(easeSpeedRatio(0.75)).toBeGreaterThan(0.8);
  });
});
