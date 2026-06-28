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
  green: '#4EC87E',
  blue: '#72A4E9',
  cyan: '#5BC0BE',
  gray50: '#F5F5F5',
  gray100: '#E0E0E0',
  gray500: '#888888',
  gray600: '#6B6B6B',
  gray700: '#5A5A5A',
  greenLight: '#7AD99B',
  red: '#E85454',
  redLight: '#F08585',
  amber400: '#E8A838',
  gold400: '#FBD700',
  tangerine400: '#FF5401',
  orange300: '#FFCB6B',
} as const;

const light = {
  green: '#0E7A38',
  blue: '#2563EB',
  cyan: '#00838F',
  gray900: '#1A1A1A',
  gray700: '#454545',
  gray600: '#5F5F5F',
  gray500: '#737373',
  red: '#B91C1C',
  amber800: '#92660A',
  gold700: '#8C7600',
  tangerine700: '#B33A00',
  orange700: '#9A4A00',
} as const;

export interface ColorPalette {
  // Brand
  primary: string;
  accent: string;
  planMode: string;
  fusionPlanMode: string;
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
  primary: dark.green,
  accent: dark.tangerine400,
  planMode: '#00FFFF',
  fusionPlanMode: '#ffff66',
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
  borderFocus: dark.gold400,

  // State
  success: dark.green,
  warning: dark.amber400,
  error: dark.red,

  diffAdded: dark.green,
  diffRemoved: dark.red,
  diffAddedStrong: dark.greenLight,
  diffRemovedStrong: dark.redLight,
  diffGutter: dark.gray600,
  diffMeta: dark.gray500,

  roleUser: dark.orange300,
  roleAssistant: dark.gray100,
  roleThinking: dark.gray500,
  roleTool: dark.amber400,

  status: dark.gray500,
};

export const lightColors: ColorPalette = {
  primary: light.green,
  accent: light.tangerine700,
  planMode: '#00838F',
  fusionPlanMode: '#ffff66',
  text: light.gray900,
  textStrong: light.gray900,
  textDim: light.gray700,
  textMuted: light.gray600,

  // Markdown
  mdLink: '#007A8A',
  mdCodeBlock: '#1565C0',
  mdCodeBlockBorder: '#9E9E9E',
  mdQuote: '#616161',

  // Surface
  border: light.gray500,
  borderFocus: light.gold700,

  // State
  success: light.green,
  warning: light.amber800,
  error: light.red,
  diffAdded: light.green,
  diffRemoved: light.red,
  diffAddedStrong: light.green,
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
