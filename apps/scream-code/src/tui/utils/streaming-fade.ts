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
 * Set `SCREAM_REDUCED_MOTION=1` to disable the fade entirely for users who
 * prefer reduced motion (vestibular sensitivity, etc.).
 */

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
  const bucket = Math.min(FADE_BUCKETS - 1, Math.floor(t * FADE_BUCKETS));
  return table[bucket]!;
}

/**
 * Whether the user has requested reduced motion via the
 * `SCREAM_REDUCED_MOTION` env var. Accepts `1`, `true`, `yes` (case
 * insensitive); `0` / `false` / unset → false.
 */
export function isReducedMotion(): boolean {
  const v = process.env['SCREAM_REDUCED_MOTION'];
  if (v === undefined || v === '') return false;
  const lower = v.toLowerCase();
  return lower !== '0' && lower !== 'false' && lower !== 'no' && lower !== '';
}
