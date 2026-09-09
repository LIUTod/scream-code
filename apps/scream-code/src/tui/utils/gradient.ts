/**
 * Brand gradient used by animated status elements (footer status spinner,
 * sidebar agent slots). Keep active-status motion inside the product's
 * cool/acid palette: red and pink read as error states in the terminal, so
 * animated hues never cross those colors while agents work normally.
 */

export const BRAND_COLORS = ['#79eb00', '#56D4DD', '#4ADE80', '#FACC15'];
export const GRADIENT_CYCLE_MS = 4000;

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Interpolated brand color at phase t ∈ [0,1) across the 4s cycle. */
export function lerpGradient(t: number): string {
  const count = BRAND_COLORS.length;
  const segment = Math.min(t * count, count - 1);
  const idx = Math.floor(segment);
  const localT = segment - idx;
  const nextIdx = (idx + 1) % count;
  const [r0, g0, b0] = hexToRgb(BRAND_COLORS[idx]!);
  const [r1, g1, b1] = hexToRgb(BRAND_COLORS[nextIdx]!);
  const r = Math.round(r0 + (r1 - r0) * localT);
  const g = Math.round(g0 + (g1 - g0) * localT);
  const b = Math.round(b0 + (b1 - b0) * localT);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
