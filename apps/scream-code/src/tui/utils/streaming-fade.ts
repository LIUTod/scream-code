/**
 * Streaming text fade — eases newly-arrived content from the accent color
 * toward the body text color over a short window, giving the "ink soaking
 * into paper" feel that makes streaming output feel less abrupt.
 *
 * sRGB linear interpolation (not CIELAB). CIELAB is perceptually smoother
 * but requires a color-space conversion dependency; sRGB linear is within
 * ~just-noticeable-difference for the 1.2s / 12-bucket fade and keeps this
 * dependency-free.
 *
 * Set `SCREAM_REDUCED_MOTION=1` (or `SCREAM_MOTION=off`) to disable the fade
 * entirely for users who prefer reduced motion (vestibular sensitivity, etc.).
 */

import { motionEnabled, reducedMotionRequested } from '#/tui/utils/motion';

export const FADE_BUCKETS = 12;
export const FADE_MS = 1200;

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function interpolateRgb(from: string, to: string, t: number): string {
  const [r1, g1, b1] = parseHex(from);
  const [r2, g2, b2] = parseHex(to);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/**
 * Pre-compute the 12-bucket ramp from `accent` (age=0, just arrived) to
 * `ink` (age ≥ FADE_MS, fully settled). Both endpoints are inclusive.
 */
export function buildFadeTable(accent: string, ink: string): string[] {
  const table: string[] = [];
  for (let i = 0; i < FADE_BUCKETS; i++) {
    const t = i / (FADE_BUCKETS - 1);
    table.push(interpolateRgb(accent, ink, t));
  }
  return table;
}

/**
 * Look up the fade color for content that arrived `ageMs` ago.
 *
 * Returns `table[FADE_BUCKETS - 1]` (the settled `ink` color) when
 * `ageMs >= FADE_MS` or when reduced motion is requested.
 */
export function fadeColor(ageMs: number, table: string[], reduced: boolean): string {
  const ink = table[FADE_BUCKETS - 1]!;
  if (reduced) return ink;
  if (ageMs >= FADE_MS) return ink;
  if (ageMs <= 0) return table[0]!;
  const t = ageMs / FADE_MS;
  // Use (FADE_BUCKETS - 1) so t=1 maps to the last bucket (ink) and every
  // prior bucket gets an equal share of the fade window. Multiplying by
  // FADE_BUCKETS made the last bucket cover [11/12, 1) — ink 100ms early.
  const bucket = Math.min(FADE_BUCKETS - 1, Math.floor(t * (FADE_BUCKETS - 1)));
  return table[bucket]!;
}

/**
 * Whether motion is reduced: the shared setting (`SCREAM_MOTION=off`, or
 * `SCREAM_REDUCED_MOTION` applied at startup — see utils/motion) or, read live,
 * the `SCREAM_REDUCED_MOTION` env var (`1`, `true`, `yes` any non-empty value
 * other than `0` / `false` / `no`; unset → false).
 */
export function isReducedMotion(): boolean {
  return !motionEnabled() || reducedMotionRequested(process.env['SCREAM_REDUCED_MOTION']);
}
