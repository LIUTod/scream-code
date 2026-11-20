import { OSC11_RESPONSE } from "#/tui/constant/terminal";

import type { ResolvedTheme } from "./colors";

/** The terminal's default background, as reported by OSC 11. */
export interface Osc11Background {
  readonly theme: ResolvedTheme;
  /** `#rrggbb`. Surfaces are derived from this instead of a hardcoded hex. */
  readonly hex: string;
}

/**
 * Parse an `ESC ] 11 ; rgb:RR/GG/BB BEL` reply.
 *
 * Returns the colour as well as the mode: the mode picks a palette, but the
 * exact background is what tells us how far a panel has to move away from it.
 * A fixed `#16191f` reads as "lighter" on a pure-black terminal and "darker"
 * on VS Code's `#1e1e1e`, i.e. the same hex can invert its meaning.
 */
export function parseOsc11Background(data: string): Osc11Background | null {
  const match = OSC11_RESPONSE.exec(data);
  if (match === null) return null;
  const [, r, g, b] = match;
  if (r === undefined || g === undefined || b === undefined) return null;
  return {
    theme: themeFromHexChannels(r, g, b),
    hex: hexFromHexChannels(r, g, b),
  };
}

export function themeFromHexChannels(rHex: string, gHex: string, bHex: string): ResolvedTheme {
  const r = normalizeChannel(rHex);
  const g = normalizeChannel(gHex);
  const b = normalizeChannel(bHex);
  // Relative luminance, sRGB-linearised. Threshold 0.5 splits dark/light
  // backgrounds reliably for both pure-black (#000) and pure-white (#fff).
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.5 ? "light" : "dark";
}

/** `#rrggbb` from OSC 11's 1-4 digit channels. */
export function hexFromHexChannels(rHex: string, gHex: string, bHex: string): string {
  return `#${channelToByte(rHex)}${channelToByte(gHex)}${channelToByte(bHex)}`;
}

function channelToByte(hex: string): string {
  return Math.round(normalizeChannel(hex) * 255)
    .toString(16)
    .padStart(2, "0");
}

function normalizeChannel(hex: string): number {
  // OSC 11 channels can be 1-4 hex digits. Scale into [0,1] regardless.
  const max = (1 << (hex.length * 4)) - 1;
  const value = parseInt(hex, 16);
  return Number.isFinite(value) ? value / max : 0;
}
