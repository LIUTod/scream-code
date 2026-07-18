import { describe, it, expect } from 'vitest';

import {
  FADE_BUCKETS,
  FADE_MS,
  buildFadeTable,
  fadeColor,
  isReducedMotion,
} from '#/tui/utils/streaming-fade';

describe('buildFadeTable', () => {
  it('produces FADE_BUCKETS entries', () => {
    const table = buildFadeTable('#ccfb23', '#E0E0E0');
    expect(table).toHaveLength(FADE_BUCKETS);
  });

  it('starts at accent and ends at ink', () => {
    const table = buildFadeTable('#ccfb23', '#E0E0E0');
    expect(table[0]!.toLowerCase()).toBe('#ccfb23');
    expect(table[FADE_BUCKETS - 1]!.toLowerCase()).toBe('#e0e0e0');
  });

  it('interpolates monotonically', () => {
    const table = buildFadeTable('#000000', '#FFFFFF');
    // Each step should be lighter than the previous.
    for (let i = 1; i < FADE_BUCKETS; i++) {
      const prev = parseInt(table[i - 1]!.slice(1), 16);
      const curr = parseInt(table[i]!.slice(1), 16);
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it('handles identical endpoints', () => {
    const table = buildFadeTable('#888888', '#888888');
    for (const c of table) expect(c).toBe('#888888');
  });
});

describe('fadeColor', () => {
  const table = buildFadeTable('#ccfb23', '#E0E0E0');

  it('returns accent at age 0', () => {
    expect(fadeColor(0, table, false).toLowerCase()).toBe('#ccfb23');
  });

  it('returns ink at age >= FADE_MS', () => {
    expect(fadeColor(FADE_MS, table, false).toLowerCase()).toBe('#e0e0e0');
    expect(fadeColor(FADE_MS + 5000, table, false).toLowerCase()).toBe('#e0e0e0');
  });

  it('returns a mid-tone for intermediate age', () => {
    const halfAge = FADE_MS / 2;
    const mid = fadeColor(halfAge, table, false);
    // Should be somewhere between accent and ink — not equal to either.
    expect(mid.toLowerCase()).not.toBe('#ccfb23');
    expect(mid.toLowerCase()).not.toBe('#e0e0e0');
  });

  it('returns ink immediately when reduced motion is requested', () => {
    expect(fadeColor(0, table, true).toLowerCase()).toBe('#e0e0e0');
    expect(fadeColor(50, table, true).toLowerCase()).toBe('#e0e0e0');
  });

  it('does not throw on negative age', () => {
    expect(fadeColor(-100, table, false).toLowerCase()).toBe('#ccfb23');
  });
});

describe('isReducedMotion', () => {
  const saved = process.env['SCREAM_REDUCED_MOTION'];

  it('returns false when unset', () => {
    delete process.env['SCREAM_REDUCED_MOTION'];
    expect(isReducedMotion()).toBe(false);
  });

  it('returns false for "0" / "false" / "no"', () => {
    process.env['SCREAM_REDUCED_MOTION'] = '0';
    expect(isReducedMotion()).toBe(false);
    process.env['SCREAM_REDUCED_MOTION'] = 'false';
    expect(isReducedMotion()).toBe(false);
    process.env['SCREAM_REDUCED_MOTION'] = 'no';
    expect(isReducedMotion()).toBe(false);
  });

  it('returns true for "1" / "true" / "yes" (case insensitive)', () => {
    process.env['SCREAM_REDUCED_MOTION'] = '1';
    expect(isReducedMotion()).toBe(true);
    process.env['SCREAM_REDUCED_MOTION'] = 'TRUE';
    expect(isReducedMotion()).toBe(true);
    process.env['SCREAM_REDUCED_MOTION'] = 'Yes';
    expect(isReducedMotion()).toBe(true);
  });

  // Restore so we don't leak env state to other tests.
  if (saved === undefined) {
    delete process.env['SCREAM_REDUCED_MOTION'];
  } else {
    process.env['SCREAM_REDUCED_MOTION'] = saved;
  }
});
