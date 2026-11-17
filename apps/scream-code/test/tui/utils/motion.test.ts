import { afterEach, describe, expect, it } from 'vitest';

import {
  applyMotionEnv,
  motionEnabled,
  parseSpinnerInterval,
  reducedMotionRequested,
  resetMotion,
  spinnerPeriodMs,
} from '#/tui/utils/motion';

afterEach(resetMotion);

describe('motion settings', () => {
  it('defaults to animated spinners at 80 ms', () => {
    expect(motionEnabled()).toBe(true);
    expect(spinnerPeriodMs()).toBe(80);
  });

  it('SCREAM_MOTION=off (and 0/false/none) stops every spinner', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'none']) {
      resetMotion();
      applyMotionEnv({ SCREAM_MOTION: value });
      expect(motionEnabled()).toBe(false);
      expect(spinnerPeriodMs()).toBeUndefined();
    }
  });

  it('any other SCREAM_MOTION value keeps motion on', () => {
    applyMotionEnv({ SCREAM_MOTION: 'on' });
    expect(motionEnabled()).toBe(true);
    applyMotionEnv({ SCREAM_MOTION: '' });
    expect(motionEnabled()).toBe(true);
  });

  it('SCREAM_SPINNER_INTERVAL_MS sets the cadence; 0 means static', () => {
    applyMotionEnv({ SCREAM_SPINNER_INTERVAL_MS: '120' });
    expect(spinnerPeriodMs()).toBe(120);
    applyMotionEnv({ SCREAM_SPINNER_INTERVAL_MS: '0' });
    expect(spinnerPeriodMs()).toBeUndefined();
    expect(motionEnabled()).toBe(true);
  });

  it('ignores invalid intervals instead of failing', () => {
    for (const bad of ['49', '-5', '1.5', 'fast', '', '8 0']) {
      resetMotion();
      applyMotionEnv({ SCREAM_SPINNER_INTERVAL_MS: bad });
      expect(spinnerPeriodMs()).toBe(80);
    }
    expect(parseSpinnerInterval('50')).toBe(50);
    expect(parseSpinnerInterval(undefined)).toBeUndefined();
  });

  it('SCREAM_REDUCED_MOTION is the same switch under its older name', () => {
    for (const value of ['1', 'true', 'yes', 'YES', 'on']) {
      resetMotion();
      applyMotionEnv({ SCREAM_REDUCED_MOTION: value });
      expect(motionEnabled(), value).toBe(false);
      expect(spinnerPeriodMs(), value).toBeUndefined();
    }
    for (const value of ['0', 'false', 'no', '']) {
      resetMotion();
      applyMotionEnv({ SCREAM_REDUCED_MOTION: value });
      expect(motionEnabled(), value).toBe(true);
      expect(spinnerPeriodMs(), value).toBe(80);
    }
  });

  it('either switch alone is enough, and neither undoes the other', () => {
    applyMotionEnv({ SCREAM_MOTION: 'off', SCREAM_REDUCED_MOTION: '0' });
    expect(motionEnabled()).toBe(false);
    resetMotion();
    applyMotionEnv({ SCREAM_MOTION: 'on', SCREAM_REDUCED_MOTION: '1' });
    expect(motionEnabled()).toBe(false);
    resetMotion();
    applyMotionEnv({ SCREAM_MOTION: 'on', SCREAM_REDUCED_MOTION: '0' });
    expect(motionEnabled()).toBe(true);
  });

  it('an interval never revives spinners while motion is off', () => {
    applyMotionEnv({ SCREAM_REDUCED_MOTION: '1', SCREAM_SPINNER_INTERVAL_MS: '120' });
    expect(spinnerPeriodMs()).toBeUndefined();
  });

  it('reducedMotionRequested keeps the original meaning of the variable', () => {
    expect(reducedMotionRequested(undefined)).toBe(false);
    expect(reducedMotionRequested('')).toBe(false);
    expect(reducedMotionRequested('0')).toBe(false);
    expect(reducedMotionRequested('False')).toBe(false);
    expect(reducedMotionRequested('NO')).toBe(false);
    expect(reducedMotionRequested('1')).toBe(true);
    expect(reducedMotionRequested('true')).toBe(true);
    expect(reducedMotionRequested('yes')).toBe(true);
  });

  it('resetMotion clears the reduced-motion flag too', () => {
    applyMotionEnv({ SCREAM_REDUCED_MOTION: '1' });
    resetMotion();
    expect(motionEnabled()).toBe(true);
  });
});
