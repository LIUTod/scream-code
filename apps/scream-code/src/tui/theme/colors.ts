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
  gold: '#FFD700',
  coral: '#FF7043',
  skyBlue: '#9CDCFE',
  blue400: '#4C9AFF',
  violet: '#C084FC',
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
  gold: '#A16207',
  orange: '#C2410C',
  blue: '#1565C0',
  violet: '#7C3AED',
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
  /** RLM (persistent-python) mode badge — bright yellow. */
  rlmMode: string;
  /** line channel dot for the Lark channel (blue); WeChat reuses `success`. */
  lineLark: string;
  // Permission mode labels
  permissionManual: string;
  permissionYolo: string;
  permissionAuto: string;
  permissionAsk: string;
  permissionBot: string;
  // Text
  text: string;
  textStrong: string;
  textDim: string;
  textMuted: string;

  // Markdown
  mdLink: string;
  mdCodeBlock: string;
  mdCodeBlockBorder: string;
  /** Panel background behind fenced code blocks (dark/light aware surface). */
  mdCodeBlockBg: string;
  /** Quoted blocks — a side note, so it must stay lighter than `mdBold`. */
  mdQuote: string;
  /** Bold emphasis inside a reply. Deliberately the heaviest markdown token:
   *  the reader should never confuse an aside (`mdQuote`) with an emphasis. */
  mdBold: string;
  /** Markdown headings — the amber signature color that gives replies a structure. */
  mdHeading: string;

  border: string;
  borderFocus: string;

  // State
  success: string;
  warning: string;
  error: string;
  /** Status-bar wave ramp: mid stage (yellow) and peak stage (deep red). */
  waveMid: string;
  wavePeak: string;

  // Diff
  diffAdded: string;
  diffRemoved: string;
  diffAddedStrong: string;
  diffRemovedStrong: string;
  diffGutter: string;
  diffMeta: string;

  // Roles
  roleUser: string;
  roleUserBg: string;
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
  wolfpackMode: dark.violet,
  rlmMode: dark.gold,
  lineLark: dark.blue400,
  permissionManual: dark.yellowGreen,
  permissionYolo: dark.gold,
  permissionAuto: dark.coral,
  permissionAsk: dark.skyBlue,
  permissionBot: dark.violet,
  text: dark.gray100,
  textStrong: dark.gray50,
  textDim: dark.gray500,
  textMuted: dark.gray600,

  // Markdown
  mdLink: '#56B6C2',
  mdCodeBlock: dark.skyBlue,
  mdCodeBlockBorder: '#5C6370',
  mdCodeBlockBg: '#16191f',
  // Dark mode leads with pink for emphasis and violet for asides; the light
  // palette swaps the two (see lightColors) so each mode keeps the same
  // "emphasis is the heavier of the pair" reading.
  mdQuote: '#B48CD8',
  mdBold: '#FF6B9D',
  mdHeading: '#FFC35C',

  // Surface
  border: dark.gray700,
  borderFocus: dark.yellowGreenLight,

  // State
  success: dark.yellowGreen,
  warning: dark.amber400,
  error: dark.red,
  // Yellow arrives at 15s and deep red at 25s. The red is deliberately deeper
  // than `error` but still clears 3:1 on a dark terminal (#1e1e1e ≈ 3.35:1).
  waveMid: '#FFD400',
  wavePeak: '#D32F2F',

  diffAdded: dark.yellowGreen,
  diffRemoved: dark.red,
  diffAddedStrong: dark.yellowGreenLight,
  diffRemovedStrong: dark.redLight,
  diffGutter: dark.gray600,
  diffMeta: dark.gray500,

  roleUser: '#f7e308',
  roleUserBg: '#f7e308',
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
  wolfpackMode: light.violet,
  rlmMode: light.gold,
  lineLark: light.blue,
  permissionManual: light.yellowGreen700,
  permissionYolo: light.gold,
  permissionAuto: light.orange,
  permissionAsk: light.blue,
  permissionBot: light.violet,
  text: light.gray900,
  textStrong: light.gray900,
  textDim: light.gray700,
  textMuted: light.gray600,

  // Markdown
  mdLink: '#007A8A',
  mdCodeBlock: light.blue,
  mdCodeBlockBorder: '#848484',
  mdCodeBlockBg: '#f7f9fb',
  // The swap: on white, emphasis takes the deep violet (#6C2B8C, 8.9:1) and the
  // aside takes the deep pink (#C2185B, 5.9:1) — same pair as dark mode, roles
  // reversed, so the emphasis is the darker of the two here.
  mdQuote: '#C2185B',
  mdBold: '#6C2B8C',
  mdHeading: '#8F6400',

  // Surface
  border: light.gray500,
  borderFocus: light.yellowGreen700,

  // State
  success: light.yellowGreen700,
  warning: light.amber800,
  error: light.red,
  // Darkened for a white background: yellow needs ≥3:1 to stay legible
  // (#A88400 ≈ 3.52:1) and deep red is free to go dark (#8B0000 = 10:1).
  waveMid: '#A88400',
  wavePeak: '#8B0000',
  diffAdded: light.yellowGreen700,
  diffRemoved: light.red,
  diffAddedStrong: light.yellowGreen700,
  diffRemovedStrong: light.red,
  diffGutter: light.gray500,
  diffMeta: light.gray600,

  roleUser: '#bd5302',
  roleUserBg: '#bd5302',
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
