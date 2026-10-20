import { describe, expect, it } from 'vitest';

import { lerpHex } from '#/tui/utils/gradient';

describe('lerpHex', () => {
  it('returns the `from` colour at t=0', () => {
    expect(lerpHex('#000000', '#ffffff', 0)).toBe('#000000');
  });

  it('returns the `to` colour at t=1', () => {
    expect(lerpHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('clamps t below 0 and above 1', () => {
    expect(lerpHex('#000000', '#ffffff', -1)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 2)).toBe('#ffffff');
  });

  it('interpolates the midpoint at t=0.5', () => {
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('preserves per-channel rounding on brand colours', () => {
    // Halfway between theme green and amber — both channels move independently.
    expect(lerpHex('#79eb00', '#e8a838', 0.5)).toBe('#b1ca1c');
  });
});
