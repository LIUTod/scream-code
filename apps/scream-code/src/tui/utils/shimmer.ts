/**
 * Shimmer — animated gradient sweep across text.
 *
 * Drives a smooth cosine "glow" band that scrolls left-to-right across a
 * string at a fixed 30 cells/second, producing a three-tier ANSI colour
 * ramp (low / mid / high) that simulates a continuous light sweep without
 * per-character allocations each frame.
 *
 * Pure math + ANSI — zero pi-tui dependency.
 */

import type { ColorPalette } from '#/tui/theme/colors';

// ── Animation velocity ──────────────────────────────────────────────────
const SHIMMER_SPEED_CELLS_PER_S = 30;

// ── Sweep tunables ──────────────────────────────────────────────────────
const PADDING = 10;
const BAND_HALF_WIDTH = 6;

// ── Tier thresholds ─────────────────────────────────────────────────────
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

// ── Raw ANSI ────────────────────────────────────────────────────────────
const FG_RESET = '\u001B[39m';
const BOLD_OPEN = '\u001B[1m';
const BOLD_CLOSE = '\u001B[22m';

type Tier = 'low' | 'mid' | 'high';

interface TierSeq {
  open: string;
  close: string;
}

interface ShimmerPalette {
  low: string;
  mid: string;
  high: string;
}

// ── Hex → ANSI truecolor ────────────────────────────────────────────────

function hexToAnsi(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return `\u001B[38;2;${r};${g};${b}m`;
}

// ── Palette compilation ─────────────────────────────────────────────────
// Resolve once per (low,mid,high) triplet into ready-to-concat ANSI
// open/close pairs so no hex→ANSI conversion happens per frame.

function compilePalette(palette: ShimmerPalette): { low: TierSeq; mid: TierSeq; high: TierSeq } {
  const lowOpen = hexToAnsi(palette.low);
  const midOpen = hexToAnsi(palette.mid);
  const highOpen = `${BOLD_OPEN}${hexToAnsi(palette.high)}`;
  return {
    low: { open: lowOpen, close: FG_RESET },
    mid: { open: midOpen, close: FG_RESET },
    high: { open: highOpen, close: `${BOLD_CLOSE}${FG_RESET}` },
  };
}

// ── Intensity function ──────────────────────────────────────────────────

/**
 * Smooth cosine bump sweeping left → right with edge padding.
 * Returns 0–1 intensity for a character at `index` in a string of `length`,
 * given the current `time` in milliseconds.
 */
function classicIntensity(time: number, index: number, length: number): number {
  const period = length + PADDING * 2;
  const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
  const dist = Math.abs(index + PADDING - pos);
  if (dist >= BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * dist) / BAND_HALF_WIDTH));
}

function tierFor(intensity: number): Tier {
  if (intensity >= TIER_HIGH) return 'high';
  if (intensity >= TIER_MID) return 'mid';
  return 'low';
}

// ── Public API ──────────────────────────────────────────────────────────

const shimmerDefaultCache = new WeakMap<ColorPalette, ShimmerPalette>();

function defaultPalette(colors: ColorPalette): ShimmerPalette {
  // Always rebuild — Object.assign(theme.colors, ...) in applyTheme mutates
  // the same object in place, so a stale cache would return outdated values.
  const p: ShimmerPalette = {
    low: colors.textDim,
    mid: colors.textMuted,
    high: colors.primary,
  };
  shimmerDefaultCache.set(colors, p);
  return p;
}

/**
 * Apply a shimmer sweep across `text` using the default three-tier palette
 * derived from `colors` (textDim → textMuted → primary).
 *
 * Call every frame (e.g. from a 30 fps setInterval) — reads `Date.now()`
 * internally to position the glow band.
 */
export function shimmerText(text: string, colors: ColorPalette): string {
  return shimmerTextWithPalette(text, defaultPalette(colors));
}

/**
 * Shimmer `text` with an explicit ShimmerPalette so callers can tune the
 * crest colour independently of the theme default (e.g. accent instead of
 * primary, or a muted hint palette).
 */
export function shimmerTextWithPalette(text: string, palette: ShimmerPalette): string {
  const chars = Array.from(text);
  const total = chars.length;
  if (total === 0) return '';

  const compiled = compilePalette(palette);
  const time = Date.now();

  let out = '';
  let runTier: Tier | null = null;
  let runBuf = '';

  for (let i = 0; i < chars.length; i++) {
    const tier = tierFor(classicIntensity(time, i, total));
    if (tier !== runTier) {
      if (runTier !== null) {
        const seq = compiled[runTier];
        out += `${seq.open}${runBuf}${seq.close}`;
        runBuf = '';
      }
      runTier = tier;
    }
    runBuf += chars[i];
  }
  if (runTier !== null && runBuf.length > 0) {
    const seq = compiled[runTier];
    out += `${seq.open}${runBuf}${seq.close}`;
  }
  return out;
}

/**
 * Build a custom shimmer palette from a single crest colour — useful for
 * matching a specific accent. The dim/muted tiers are taken from the base
 * palette; only the high tier is replaced.
 */
export function accentPalette(colors: ColorPalette, crestHex: string): ShimmerPalette {
  return {
    low: colors.textDim,
    mid: colors.textMuted,
    high: crestHex,
  };
}
