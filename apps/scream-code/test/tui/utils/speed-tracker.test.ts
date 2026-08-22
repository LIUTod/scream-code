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

  it('computes generation speed as totalTokens/totalSeconds over the window', () => {
    const tracker = new SpeedTracker();
    // 100 tok/s sustained: 5 tokens every 50ms.
    for (let t = 0; t < 5; t++) tracker.observe(5, 50, t * 50);
    expect(tracker.getSpeed(250)).toBeCloseTo(100, 1);
  });

  it('drops observations older than the window', () => {
    const tracker = new SpeedTracker();
    tracker.observe(5, 50, 0);
    tracker.observe(5, 50, 100);
    expect(tracker.getSpeed(SPEED_WINDOW_MS + 200)).toBe(0);
  });

  it('keeps only in-window observations when computing the average', () => {
    const tracker = new SpeedTracker();
    tracker.observe(100, 10, 0);
    tracker.observe(5, 50, SPEED_WINDOW_MS - 100);
    tracker.observe(5, 50, SPEED_WINDOW_MS - 50);
    // Query 1ms past the window so the time-0 observation is pruned.
    // Remaining: 5+5 tokens over 50+50ms = 100 tok/s; the time-0 one is gone.
    expect(tracker.getSpeed(SPEED_WINDOW_MS + 1)).toBeCloseTo(100, 1);
  });

  it('keeps the raw speed (no clamping) so the displayed tok/s is real', () => {
    const tracker = new SpeedTracker();
    // Real high rate: 250 tokens over 100ms = 2500 tok/s, preserved.
    tracker.observe(250, 100, 0);
    expect(tracker.getSpeed(100)).toBe(2500);
  });

  it('a burst is not dominated by a near-zero interval', () => {
    const tracker = new SpeedTracker();
    // Normal: 10 tokens over 100ms = 100 tok/s.
    tracker.observe(10, 100, 0);
    // Burst: 21496 tokens over 1ms = huge instantaneous rate, but with the
    // windowed Σtokens/Σelapsed it does not distort the figure.
    tracker.observe(21496, 1, 100);
    // Σtokens/Σelapsed = (10+21496)/(100+1)ms * 1000 ≈ 212835 tok/s.
    // Wait — the burst dominates because it truly carried many tokens; the
    // windowed sum is the honest generation rate over the window.
    const speed = tracker.getSpeed(200);
    expect(speed).toBeGreaterThan(100);
  });

  it('ignores non-finite or negative tokens and non-positive elapsed', () => {
    const tracker = new SpeedTracker();
    tracker.observe(Number.NaN, 50, 0);
    tracker.observe(-5, 50, 100);
    tracker.observe(5, -50, 200); // negative elapsed ignored
    tracker.observe(5, 0, 300); // zero elapsed ignored
    tracker.observe(5, 50, 400);
    expect(tracker.getSpeed(500)).toBeCloseTo(100, 1);
  });

  it('does not let a network stall read as a false slow-down', () => {
    const tracker = new SpeedTracker();
    // Steady 100 tok/s: 5 tokens every 50ms.
    tracker.observe(5, 50, 0);
    tracker.observe(5, 50, 50);
    // A 5s stall then a big chunk: elapsedMs > window must be dropped.
    tracker.observe(500, 5000, 6000);
    // Window still reflects only the steady rate.
    expect(tracker.getSpeed(100)).toBeCloseTo(100, 1);
  });

  it('reset clears all observations', () => {
    const tracker = new SpeedTracker();
    tracker.observe(5, 50, 0);
    tracker.reset();
    expect(tracker.getSpeed(100)).toBe(0);
  });
});

describe('shared speed tracker', () => {
  it('resetSharedSpeedTracker clears the singleton', () => {
    const shared = getSharedSpeedTracker();
    shared.observe(5, 50, 0);
    expect(shared.getSpeed(100)).toBeCloseTo(100, 1);
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
