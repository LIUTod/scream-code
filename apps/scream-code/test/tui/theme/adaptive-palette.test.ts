import { describe, expect, it } from 'vitest';

import { createScreamTUIThemeBundle } from '#/tui/theme/bundle';
import { CODE_SURFACE_FALLBACK } from '#/tui/theme/code-surface';
import { darkColors, getColorPalette, lightColors } from '#/tui/theme/colors';

describe('adaptive code surface', () => {
  it('uses the tuned fallback surface when the ground is unknown', () => {
    // The shipped constants are what the fallback exists to replace: #f7f9fb is
    // 0.4 L* from an off-white ground and #16191f inverts on #1e1e1e.
    expect(getColorPalette('dark').mdCodeBlockBg).toBe(CODE_SURFACE_FALLBACK.dark);
    expect(getColorPalette('light').mdCodeBlockBg).toBe(CODE_SURFACE_FALLBACK.light);
    // Every other role is untouched.
    expect(getColorPalette('dark').text).toBe(darkColors.text);
    expect(getColorPalette('light').text).toBe(lightColors.text);
  });

  it('derives the surface from the ground instead of the constant', () => {
    const onBlack = getColorPalette('dark', '#000000').mdCodeBlockBg;
    const onVsCode = getColorPalette('dark', '#1e1e1e').mdCodeBlockBg;

    expect(onBlack).not.toBe(darkColors.mdCodeBlockBg);
    expect(onVsCode).not.toBe(onBlack);
  });

  it('is memoised: the same ground returns the same object (palettes get copied per bundle)', () => {
    const first = getColorPalette('dark', '#1e1e1e');
    const second = getColorPalette('dark', '#1e1e1e');
    expect(second).toBe(first);
  });

  it('carries the ground into the theme bundle', () => {
    const withGround = createScreamTUIThemeBundle('auto', 'dark', '#1e1e1e');
    const withoutGround = createScreamTUIThemeBundle('auto', 'dark');

    expect(withGround.backgroundHex).toBe('#1e1e1e');
    expect(withoutGround.backgroundHex).toBeUndefined();
    expect(withGround.colors.mdCodeBlockBg).not.toBe(withoutGround.colors.mdCodeBlockBg);
  });
});
