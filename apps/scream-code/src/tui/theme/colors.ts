/**
 * Color palette definitions for dark and light themes.
 *
 * Two layers:
 *  - private `dark` / `light` raw palettes — unsemantic constants reused
 *    across multiple semantic tokens to avoid hex literal duplication.
 *  - exported `darkColors` / `lightColors` — the semantic `ColorPalette`
 *    consumed by every UI component via chalk.hex(...).
 *
 * Light palette values are tuned for ≥ 4.5:1 contrast against #FFFFFF
 * for text tokens and ≥ 3:1 for chrome (border / large text), matching
 * WCAG AA.
 */

const dark = {
  yellowGreen: '#79eb00',
  pink400: '#FF6B9D',
  cyan400: '#56D4DD',
  amber400: '#E8A838',
  amber500: '#FFA726',
  gray50: '#F5F5F5',
  gray100: '#E0E0E0',
  gray500: '#888888',
  gray600: '#767676',
  gray700: '#5A5A5A',
  yellowGreenLight: '#E0F5A0',
  red: '#E85454',
  redLight: '#F08585',
  gold400: '#FFD166',
} as const;

const light = {
  yellowGreen700: '#4B7A06',
  pink700: '#C2185B',
  cyan800: '#006978',
  gray900: '#1A1A1A',
  gray700: '#454545',
  gray600: '#5F5F5F',
  gray500: '#737373',
  red: '#B91C1C',
  amber800: '#92660A',
  amber700: '#9A6B00',
  orange700: '#9A4A00',
} as const;

export interface ColorPalette {
  // Brand
  primary: string;
  accent: string;
  planMode: string;
  fusionPlanMode: string;
  wolfpackMode: string;
  // Text
  text: string;
  textStrong: string;
  textDim: string;
  textMuted: string;

  // Markdown
  mdLink: string;
  mdCodeBlock: string;
  mdCodeBlockBorder: string;
  mdQuote: string;

  border: string;
  borderFocus: string;

  // State
  success: string;
  warning: string;
  error: string;

  // Diff
  diffAdded: string;
  diffRemoved: string;
  diffAddedStrong: string;
  diffRemovedStrong: string;
  diffGutter: string;
  diffMeta: string;

  // Roles
  roleUser: string;
  roleAssistant: string;
  roleThinking: string;
  roleTool: string;

  // Status
  status: string;
}

export const darkColors: ColorPalette = {
  primary: dark.yellowGreen,
  accent: dark.pink400,
  planMode: dark.cyan400,
  fusionPlanMode: dark.amber500,
  wolfpackMode: '#C084FC',
  text: dark.gray100,
  textStrong: dark.gray50,
  textDim: dark.gray500,
  textMuted: dark.gray600,

  // Markdown
  mdLink: '#56B6C2',
  mdCodeBlock: '#9CDCFE',
  mdCodeBlockBorder: '#5C6370',
  mdQuote: '#7F848E',

  // Surface
  border: dark.gray700,
  borderFocus: dark.yellowGreenLight,

  // State
  success: dark.yellowGreen,
  warning: dark.amber400,
  error: dark.red,

  diffAdded: dark.yellowGreen,
  diffRemoved: dark.red,
  diffAddedStrong: dark.yellowGreenLight,
  diffRemovedStrong: dark.redLight,
  diffGutter: dark.gray600,
  diffMeta: dark.gray500,

  roleUser: dark.gold400,
  roleAssistant: dark.gray100,
  roleThinking: dark.gray500,
  roleTool: dark.amber400,

  status: dark.gray500,
};

export const lightColors: ColorPalette = {
  primary: light.yellowGreen700,
  accent: light.pink700,
  planMode: light.cyan800,
  fusionPlanMode: light.amber700,
  wolfpackMode: '#7C3AED',
  text: light.gray900,
  textStrong: light.gray900,
  textDim: light.gray700,
  textMuted: light.gray600,

  // Markdown
  mdLink: '#007A8A',
  mdCodeBlock: '#1565C0',
  mdCodeBlockBorder: '#848484',
  mdQuote: '#616161',

  // Surface
  border: light.gray500,
  borderFocus: light.yellowGreen700,

  // State
  success: light.yellowGreen700,
  warning: light.amber800,
  error: light.red,
  diffAdded: light.yellowGreen700,
  diffRemoved: light.red,
  diffAddedStrong: light.yellowGreen700,
  diffRemovedStrong: light.red,
  diffGutter: light.gray500,
  diffMeta: light.gray600,

  roleUser: light.orange700,
  roleAssistant: light.gray900,
  roleThinking: light.gray700,
  roleTool: light.amber800,

  status: light.gray700,
};

export type ResolvedTheme = 'dark' | 'light';

export function getColorPalette(theme: ResolvedTheme): ColorPalette {
  return theme === 'dark' ? darkColors : lightColors;
}

/**
 * True when a hex background is light enough to need dark text on top
 * (relative luminance above 0.5). Shared by badge/tag renderers so a
 * fluorescent-green block never gets unreadable white text.
 */
export function isLightBgHex(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

/** Foreground colour with readable contrast on the given hex background. */
export function contrastTextHex(bgHex: string): string {
  return isLightBgHex(bgHex) ? '#000000' : '#FFFFFF';
}
