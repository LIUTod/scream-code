import type { MarkdownTheme } from '@liutod-scream/pi-tui';

import { getColorPalette, type ColorPalette, type ResolvedTheme } from './colors';
import { createMarkdownTheme } from './pi-tui-theme';
import { createThemeStyles, type ThemeStyles } from './styles';
import { resolveThemeSync, type Theme } from './index';

export interface ScreamTUIThemeBundle {
  resolvedTheme: ResolvedTheme;
  /** Terminal background the palette was derived from, when it was known. */
  backgroundHex?: string;
  colors: ColorPalette;
  styles: ThemeStyles;
  markdownTheme: MarkdownTheme;
}

export function createScreamTUIThemeBundle(
  theme: Theme,
  resolvedTheme?: ResolvedTheme,
  /** Terminal background (`#rrggbb`) when the terminal reported one. */
  backgroundHex?: string,
): ScreamTUIThemeBundle {
  const actualTheme = resolvedTheme ?? resolveThemeSync(theme);
  const colors = { ...getColorPalette(actualTheme, backgroundHex) };
  return {
    resolvedTheme: actualTheme,
    ...(backgroundHex === undefined ? {} : { backgroundHex }),
    colors,
    styles: createThemeStyles(colors),
    markdownTheme: createMarkdownTheme(colors),
  };
}
