/**
 * WCAG AA contrast self-check for the color palette.
 *
 * Every token in `darkColors` is checked against a dark background (#000000,
 * the worst-case terminal dark bg) and every token in `lightColors` against
 * #FFFFFF. Text tokens must meet 4.5:1; chrome tokens (borders, gutters,
 * meta) must meet 3:1 per WCAG AA.
 *
 * If this test goes red, a color drifted out of compliance — adjust the
 * palette value (typically: lighten dark grays, darken light grays) until
 * it passes. Do not loosen the thresholds.
 */

import { describe, it, expect } from 'vitest';

import { darkColors, lightColors, type ColorPalette } from '#/tui/theme/colors';

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Tokens used for body text, labels, and inline content. Must meet 4.5:1
// (WCAG AA normal text).
const TEXT_TOKENS: readonly (keyof ColorPalette)[] = [
  'primary',
  'accent',
  'text',
  'textStrong',
  'textDim',
  'textMuted',
  'mdLink',
  'mdCodeBlock',
  'mdQuote',
  'success',
  'warning',
  'error',
  'diffAdded',
  'diffRemoved',
  'roleUser',
  'roleAssistant',
  'roleThinking',
  'roleTool',
  'status',
];

// Tokens used for borders, gutters, and decorative meta. Must meet 3:1
// (WCAG AA large text / UI components).
const CHROME_TOKENS: readonly (keyof ColorPalette)[] = [
  'border',
  'borderFocus',
  'mdCodeBlockBorder',
  'planMode',
  'fusionPlanMode',
  'diffAddedStrong',
  'diffRemovedStrong',
  'diffGutter',
  'diffMeta',
];

const TEXT_THRESHOLD = 4.5;
const CHROME_THRESHOLD = 3.0;

describe('WCAG AA contrast — dark palette on #000000', () => {
  const bg = '#000000';
  for (const token of TEXT_TOKENS) {
    const hex = darkColors[token];
    it(`dark.${token} (${hex}) meets 4.5:1 on ${bg}`, () => {
      const ratio = contrastRatio(hex, bg);
      expect(ratio, `${token} ${hex} on ${bg}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_THRESHOLD);
    });
  }
  for (const token of CHROME_TOKENS) {
    const hex = darkColors[token];
    it(`dark.${token} (${hex}) meets 3:1 on ${bg}`, () => {
      const ratio = contrastRatio(hex, bg);
      expect(ratio, `${token} ${hex} on ${bg}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(CHROME_THRESHOLD);
    });
  }
});

describe('WCAG AA contrast — light palette on #FFFFFF', () => {
  const bg = '#FFFFFF';
  for (const token of TEXT_TOKENS) {
    const hex = lightColors[token];
    it(`light.${token} (${hex}) meets 4.5:1 on ${bg}`, () => {
      const ratio = contrastRatio(hex, bg);
      expect(ratio, `${token} ${hex} on ${bg}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_THRESHOLD);
    });
  }
  for (const token of CHROME_TOKENS) {
    const hex = lightColors[token];
    it(`light.${token} (${hex}) meets 3:1 on ${bg}`, () => {
      const ratio = contrastRatio(hex, bg);
      expect(ratio, `${token} ${hex} on ${bg}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(CHROME_THRESHOLD);
    });
  }
});
