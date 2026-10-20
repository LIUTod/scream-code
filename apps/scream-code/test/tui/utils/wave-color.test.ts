import { describe, expect, it } from 'vitest';

import { lerpHex } from '#/tui/utils/gradient';
import {
  WAVE_AMBER_AT_MS,
  WAVE_GREEN_HOLD_MS,
  WAVE_RED_AT_MS,
  resolveWaveColor,
} from '#/tui/utils/wave-color';

/** Dark-theme palette values, so the assertions read like the real ramp. */
const STOPS = {
  green: '#79eb00',
  amber: '#E8A838',
  red: '#E85454',
};

/** Light-theme palette values — the ramp must work for both. */
const LIGHT_STOPS = {
  green: '#4B7A06',
  amber: '#92660A',
  red: '#B91C1C',
};

/** Hex case is cosmetic (chalk parses either), so compare case-insensitively. */
function expectColor(actual: string, expected: string): void {
  expect(actual.toLowerCase()).toBe(expected.toLowerCase());
}

describe('resolveWaveColor', () => {
  it('holds green through the quiet window', () => {
    expect(resolveWaveColor(0, STOPS)).toBe(STOPS.green);
    expect(resolveWaveColor(WAVE_GREEN_HOLD_MS - 1, STOPS)).toBe(STOPS.green);
    expect(resolveWaveColor(WAVE_GREEN_HOLD_MS, STOPS)).toBe(STOPS.green);
  });

  it('ramps green → amber between 10s and 15s', () => {
    const midway = resolveWaveColor(12_500, STOPS);
    expect(midway).not.toBe(STOPS.green);
    expect(midway).not.toBe(STOPS.amber);
    expect(midway).toBe(lerpHex(STOPS.green, STOPS.amber, 0.5));
  });

  it('is pure amber at 15s', () => {
    expectColor(resolveWaveColor(WAVE_AMBER_AT_MS, STOPS), STOPS.amber);
  });

  it('ramps amber → red between 15s and 25s', () => {
    const midway = resolveWaveColor(20_000, STOPS);
    expect(midway).not.toBe(STOPS.amber);
    expect(midway).not.toBe(STOPS.red);
    expect(midway).toBe(lerpHex(STOPS.amber, STOPS.red, 0.5));
  });

  it('is pure red at 25s and stays red afterwards', () => {
    expect(resolveWaveColor(WAVE_RED_AT_MS, STOPS)).toBe(STOPS.red);
    expect(resolveWaveColor(10 * 60_000, STOPS)).toBe(STOPS.red);
  });

  it('ramps within the light-theme palette as well', () => {
    expectColor(resolveWaveColor(WAVE_AMBER_AT_MS, LIGHT_STOPS), LIGHT_STOPS.amber);
    expect(resolveWaveColor(WAVE_RED_AT_MS, LIGHT_STOPS)).toBe(LIGHT_STOPS.red);
    expect(resolveWaveColor(0, LIGHT_STOPS)).toBe(LIGHT_STOPS.green);
  });

  it('falls back to green on a broken clock reading', () => {
    expect(resolveWaveColor(Number.NaN, STOPS)).toBe(STOPS.green);
    // A non-finite elapsed means the clock itself is unusable — claiming a
    // stall would be a guess, so the wave stays on the brand colour.
    expect(resolveWaveColor(Number.POSITIVE_INFINITY, STOPS)).toBe(STOPS.green);
    expect(resolveWaveColor(-1_000, STOPS)).toBe(STOPS.green);
  });
});
