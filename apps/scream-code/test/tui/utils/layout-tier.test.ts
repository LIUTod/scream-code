import { describe, it, expect } from 'vitest';

import { widthTier } from '#/tui/utils/layout-tier';

describe('widthTier', () => {
  it('returns "full" for widths >= 100', () => {
    expect(widthTier(100)).toBe('full');
    expect(widthTier(120)).toBe('full');
    expect(widthTier(200)).toBe('full');
  });

  it('returns "medium" for widths 80–99', () => {
    expect(widthTier(80)).toBe('medium');
    expect(widthTier(99)).toBe('medium');
    expect(widthTier(90)).toBe('medium');
  });

  it('returns "narrow" for widths 58–79', () => {
    expect(widthTier(58)).toBe('narrow');
    expect(widthTier(79)).toBe('narrow');
    expect(widthTier(70)).toBe('narrow');
  });

  it('returns "tiny" for widths < 58', () => {
    expect(widthTier(57)).toBe('tiny');
    expect(widthTier(40)).toBe('tiny');
    expect(widthTier(20)).toBe('tiny');
    expect(widthTier(1)).toBe('tiny');
    expect(widthTier(0)).toBe('tiny');
  });

  it('tier boundaries are stable at the exact thresholds', () => {
    // Boundary checks: each tier's lower bound is inclusive, upper bound
    // belongs to the next tier.
    expect(widthTier(57)).toBe('tiny');
    expect(widthTier(58)).toBe('narrow');
    expect(widthTier(79)).toBe('narrow');
    expect(widthTier(80)).toBe('medium');
    expect(widthTier(99)).toBe('medium');
    expect(widthTier(100)).toBe('full');
  });
});
