/**
 * Code-block surface, derived from the terminal's own background.
 *
 * Why not a fixed hex per theme: we never paint the page — the terminal does.
 * `#f7f9fb` sits 0.4 L* away from an off-white ground and `#16191f` sits 2.6 L*
 * *below* VS Code's `#1e1e1e`, so one constant is invisible on one ground and
 * inverted on another.
 *
 * The panel moves away from the measured ground by a fixed perceptual amount,
 * but the direction is chosen against the *ink* as well: stepping up on a dark
 * ground walks the surface toward the light-on-dark text, and a comment colour
 * that reads at 5:1 on `#16191f` drops under 4:1 on the moved surface. So a
 * candidate is rejected unless it keeps the dimmest ink legible; the opposite
 * direction (recessed) is tried next, and only then the fallback.
 */

import type { ResolvedTheme } from './colors';

/**
 * How far the surface moves in CIE L*.
 *
 * Adjacent large surfaces need ~1-2 L* to be told apart at all; type rendered
 * on them needs more. 6 (light) / 8 (dark) clears that threshold without
 * looking like a highlighted block.
 */
const SURFACE_DELTA_LIGHT = 6;
const SURFACE_DELTA_DARK = 8;

/** Floor/ceiling keep the result inside the sRGB cube for extreme grounds. */
const MIN_LSTAR = 6;
const MAX_LSTAR = 94;

/**
 * Contrast floors for the two inks the panel draws.
 *
 * Body text is WCAG AA. Comments sit lower on purpose: they are secondary text
 * that was already under AA on the shipped `#16191f` (3.88:1) before the surface
 * was derived, and no surface dark enough to clear 4.5 for a mid-grey comment
 * stays visible against a black ground. 3.5 is the floor that keeps the derived
 * panel from being *worse* than what it replaced.
 */
const MIN_BODY_CONTRAST = 4.5;
const MIN_MUTED_CONTRAST = 3.5;

/**
 * Used when the terminal never reported its background (no OSC 11 support,
 * SSH, `NO_COLOR`) or when no direction keeps the ink legible. Tuned against
 * the most common grounds: white for light, pure black for dark.
 */
export const CODE_SURFACE_FALLBACK: Readonly<Record<ResolvedTheme, string>> = {
  light: '#eef1f5',
  // Dark enough to keep the comment ink (#888888) at 4.6:1 — a lighter fallback
  // like #20262f lands at 4.29, just under AA, and is barely visible on a pure
  // black ground anyway.
  dark: '#1a1f26',
};

/** The inks the panel draws on top of the surface. */
export interface SurfaceInks {
  /** Body ink inside code (identifiers, strings). */
  readonly body: string;
  /** Dimmest ink the panel draws (comments). */
  readonly muted: string;
}

/**
 * The surface colour for code blocks on `backgroundHex`.
 *
 * A candidate is skipped when it would push either ink below its floor: the
 * raised direction on a dark ground walks the surface toward the light-on-dark
 * text, so the direction has to be judged against the ink, not only the ground.
 */
export function codeSurfaceFor(
  backgroundHex: string,
  theme: ResolvedTheme,
  inks?: SurfaceInks,
): string {
  const background = parseHex(backgroundHex);
  if (background === undefined) return CODE_SURFACE_FALLBACK[theme];
  const body = inks === undefined ? undefined : parseHex(inks.body);
  const muted = inks === undefined ? undefined : parseHex(inks.muted);

  const backgroundLstar = lstarOf(background);
  const delta = theme === 'light' ? SURFACE_DELTA_LIGHT : SURFACE_DELTA_DARK;
  // Raised on dark grounds and recessed on light ones reads as a panel; the
  // opposite direction is the fallback when the ink would lose contrast.
  const directions: readonly (0 | 1)[] = theme === 'light' ? [0, 1] : [1, 0];

  for (const direction of directions) {
    const raw = direction === 0 ? backgroundLstar - delta : backgroundLstar + delta;
    const target = Math.min(MAX_LSTAR, Math.max(MIN_LSTAR, raw));
    const candidate = shiftToward(background, target, direction);
    if (candidate === undefined) continue;

    // Clamping can eat the step on extreme grounds — an invisible panel is
    // worse than the fallback.
    if (Math.abs(lstarOf(candidate) - backgroundLstar) < 4) continue;
    if (body !== undefined && contrastRatio(candidate, body) < MIN_BODY_CONTRAST) continue;
    if (muted !== undefined && contrastRatio(candidate, muted) < MIN_MUTED_CONTRAST) continue;
    return toHex(candidate);
  }
  return CODE_SURFACE_FALLBACK[theme];
}

/** CIE L* of a `#rrggbb` colour (0 = black, 100 = white). Exported for tests. */
export function relativeLstar(hex: string): number | undefined {
  const rgb = parseHex(hex);
  return rgb === undefined ? undefined : lstarOf(rgb);
}

/** WCAG contrast ratio between two `#rrggbb` colours. Exported for tests. */
export function contrastRatioFor(foregroundHex: string, backgroundHex: string): number | undefined {
  const foreground = parseHex(foregroundHex);
  const background = parseHex(backgroundHex);
  if (foreground === undefined || background === undefined) return undefined;
  return contrastRatio(foreground, background);
}

type LinearRgb = readonly [number, number, number];

function parseHex(hex: string): LinearRgb | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return undefined;
  const value = match[1];
  if (value === undefined) return undefined;
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  return [toLinear(r), toLinear(g), toLinear(b)];
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function luminance(rgb: LinearRgb): number {
  const [r, g, b] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function lstarOf(rgb: LinearRgb): number {
  const y = luminance(rgb);
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
}

function contrastRatio(a: LinearRgb, b: LinearRgb): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Scale the colour toward black (`direction = 0`) or white (`direction = 1`)
 * until its L* hits `target`.
 *
 * Scaling in linear RGB keeps the channel ratios toward black (the hue does not
 * drift); toward white it desaturates slightly, which is what a raised panel on
 * a coloured ground should do anyway.
 */
function shiftToward(
  rgb: LinearRgb,
  target: number,
  direction: 0 | 1,
): LinearRgb | undefined {
  const mix = (amount: number): LinearRgb => {
    const [r, g, b] = rgb;
    const blend = (channel: number): number =>
      direction === 1 ? channel + (1 - channel) * amount : channel * (1 - amount);
    return [blend(r), blend(g), blend(b)];
  };

  // L* is monotonic in `amount` for both directions, so a bisection converges.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    const lstar = lstarOf(mix(mid));
    const tooFar = direction === 1 ? lstar > target : lstar < target;
    if (tooFar) high = mid;
    else low = mid;
  }
  return mix((low + high) / 2);
}

function toHex(rgb: LinearRgb): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, toSrgb(value))) * 255)
      .toString(16)
      .padStart(2, '0');
  const [r, g, b] = rgb;
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
