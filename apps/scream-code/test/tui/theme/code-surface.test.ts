import { describe, expect, it } from 'vitest';

import {
  CODE_SURFACE_FALLBACK,
  codeSurfaceFor,
  contrastRatioFor,
  relativeLstar,
} from '#/tui/theme/code-surface';

/** Real terminal backgrounds the panel has to survive. */
const GROUNDS: readonly { hex: string; theme: 'light' | 'dark'; label: string }[] = [
  { hex: '#ffffff', theme: 'light', label: 'pure white' },
  { hex: '#fafafa', theme: 'light', label: 'off-white (VS Code light)' },
  { hex: '#fdf6e3', theme: 'light', label: 'solarized light' },
  { hex: '#000000', theme: 'dark', label: 'pure black' },
  { hex: '#1e1e1e', theme: 'dark', label: 'VS Code dark' },
  { hex: '#282a36', theme: 'dark', label: 'dracula' },
  { hex: '#002b36', theme: 'dark', label: 'solarized dark' },
  { hex: '#808080', theme: 'dark', label: 'mid grey' },
];

describe('codeSurfaceFor', () => {
  it('keeps at least 5 L* between the panel and every common ground', () => {
    for (const ground of GROUNDS) {
      const surface = codeSurfaceFor(ground.hex, ground.theme);
      const surfaceLstar = relativeLstar(surface);
      // A malformed surface must fail, not silently compare against 0.
      expect(surfaceLstar, `${ground.label}: ${surface}`).toBeDefined();
      const delta = Math.abs((surfaceLstar ?? 0) - (relativeLstar(ground.hex) ?? 0));
      expect(delta, `${ground.label}: ${ground.hex} -> ${surface}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('moves in the direction that reads as a panel: darker on light, lighter on dark', () => {
    for (const ground of GROUNDS) {
      const surface = codeSurfaceFor(ground.hex, ground.theme);
      const groundLstar = relativeLstar(ground.hex) ?? 0;
      const surfaceLstar = relativeLstar(surface);
      expect(surfaceLstar, ground.label).toBeDefined();
      expect(surfaceLstar ?? 0, ground.label).not.toBe(groundLstar);
    }
  });

  it('is stable: the same ground and theme always give the same surface', () => {
    expect(codeSurfaceFor('#1e1e1e', 'dark')).toBe(codeSurfaceFor('#1e1e1e', 'dark'));
  });

  it('falls back on a ground it cannot parse', () => {
    expect(codeSurfaceFor('not-a-colour', 'light')).toBe(CODE_SURFACE_FALLBACK.light);
    expect(codeSurfaceFor('', 'dark')).toBe(CODE_SURFACE_FALLBACK.dark);
  });

  it('the fallbacks themselves are visible on their nominal grounds', () => {
    const lightDelta = Math.abs(
      (relativeLstar(CODE_SURFACE_FALLBACK.light) ?? 0) - (relativeLstar('#ffffff') ?? 0),
    );
    const darkDelta = Math.abs(
      (relativeLstar(CODE_SURFACE_FALLBACK.dark) ?? 0) - (relativeLstar('#000000') ?? 0),
    );
    expect(lightDelta).toBeGreaterThanOrEqual(4);
    expect(darkDelta).toBeGreaterThanOrEqual(4);
  });
});

describe('relativeLstar', () => {
  it('anchors the scale at black and white', () => {
    expect(relativeLstar('#000000')).toBeCloseTo(0, 1);
    expect(relativeLstar('#ffffff')).toBeCloseTo(100, 1);
  });

  it('returns undefined for junk', () => {
    expect(relativeLstar('#12345')).toBeUndefined();
    expect(relativeLstar('rgb(1,2,3)')).toBeUndefined();
  });
});

describe('codeSurfaceFor keeps the code ink legible', () => {
  // The two ends of the ink range on a code panel: body text and comments.
  // Stepping *up* on a dark ground moves the surface toward them.
  const DARK_INKS = { body: '#e6e6e6', muted: '#767676' } as const;
  const LIGHT_INKS = { body: '#1a1a1a', muted: '#5f5f5f' } as const;
  const inksFor = (theme: 'dark' | 'light') => (theme === 'dark' ? DARK_INKS : LIGHT_INKS);

  it('keeps body text at AA and comments at the floor on every ground', () => {
    for (const ground of GROUNDS) {
      const inks = inksFor(ground.theme);
      const surface = codeSurfaceFor(ground.hex, ground.theme, inks);
      const bodyContrast = contrastRatioFor(inks.body, surface) ?? 0;
      const mutedContrast = contrastRatioFor(inks.muted, surface) ?? 0;

      expect(bodyContrast, `${ground.label}: body on ${surface}`).toBeGreaterThanOrEqual(4.5);
      // Comments sit below AA on purpose (they already did on the shipped
      // panel); the floor only guarantees the derived panel is not worse.
      expect(mutedContrast, `${ground.label}: muted on ${surface}`).toBeGreaterThanOrEqual(3.5);
    }
  });

  it('the fallback panels keep the same floors', () => {
    for (const [theme, inks] of [
      ['dark', DARK_INKS],
      ['light', LIGHT_INKS],
    ] as const) {
      const surface = CODE_SURFACE_FALLBACK[theme];
      expect(contrastRatioFor(inks.body, surface) ?? 0, theme).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatioFor(inks.muted, surface) ?? 0, theme).toBeGreaterThanOrEqual(3.5);
    }
  });

  it('recesses instead of raising when raising would dim the comments', () => {
    // #1e1e1e: raising by 8 L* lands on #2f2f2f, where comments drop below the
    // floor; the recessed direction keeps them readable.
    const surface = codeSurfaceFor('#1e1e1e', 'dark', DARK_INKS);

    expect(relativeLstar(surface) ?? 0).toBeLessThan(relativeLstar('#1e1e1e') ?? 0);
  });

  it('never returns a surface that collides with the ground', () => {
    for (const ground of GROUNDS) {
      const surface = codeSurfaceFor(ground.hex, ground.theme, inksFor(ground.theme));
      expect(surface.toLowerCase(), ground.label).not.toBe(ground.hex.toLowerCase());
    }
  });
});
