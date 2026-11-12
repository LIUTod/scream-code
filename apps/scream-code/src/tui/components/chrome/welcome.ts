/**
 * Welcome panel shown at the top of the TUI.
 *
 * Responsive layout (borderless):
 * - Wide terminal (≥55 cols): mascot face with rays of light spreading out,
 *   then the SCREAM ASCII art (per-char colouring: █ white, stroke breathing,
 *   others dim) + centred info line.
 * - Narrow terminal: compact logo face with the same light rays + info line.
 *
 * Mascot, rays and logo strokes share the theme's breathing primary colour.
 */

import type { Component, TUI } from '@liutod-scream/pi-tui';
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import { BREATHE_CYCLE_MS, BREATHE_INTERVAL_MS, getBreathingFrame, resetBreathingClock } from '#/tui/utils/breathing-clock';

// 24 hues × 5 interpolated steps = 120 palette entries. The breathing frame
// walks the wheel in IMPACT_HUE_STEP jumps (see renderMascotRow) so every
// colour change lands on a light impact instead of drifting continuously.
const HUE_STOPS = 24;
const SUB_STEPS = 5;

const MIN_PANEL_WIDTH = 50;

// SCREAM art is 51 columns wide (longest line); keep a small margin.
const FULL_LOGO_MIN_WIDTH = 55;

// ── SCREAM ASCII art (wordmark only) ───────────────────────────────
const LOGO = [
  '███████╗ ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗',
  '██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗████╗ ████║',
  '███████╗██║     ██████╔╝█████╗  ███████║██╔████╔██║',
  '╚════██║██║     ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║',
  '███████║╚██████╗██║  ██║███████╗██║  ██║██║ ╚═╝ ██║',
  '╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝',
];

const SHADOW_CHARS = new Set(['╚', '═', '╝', '║', '╔', '╗', '╠', '╣', '╦', '╩', '╬']);

// ── Compact logo face (narrow terminal fallback) ────────────────────
const LOGO_FRAMES: [string, string][] = [
  ['██▄▄▄██', '▐█▄▀▄█▌'],
  ['██▄▄▄██', '▐▄▄▀▄▄▌'],
  ['██▄▄▄██', '▐▄▀▄▄▄▌'],
  ['██▄▄▄██', '▐▄▄▄▀▄▌'],
  ['██▄▄▄██', '▐█▄▀▄█▌'],
];

// ── HSL ↔ RGB helpers ──────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
  else if (max === gf) h = ((bf - rf) / d + 2) / 6;
  else h = ((rf - gf) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hf = ((h % 360) + 360) % 360 / 360;
  const sf = s / 100, lf = l / 100;
  if (sf === 0) { const v = Math.round(lf * 255); return [v, v, v]; }
  const q = lf < 0.5 ? lf * (1 + sf) : lf + sf - lf * sf;
  const p = 2 * lf - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q-p)*6*t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q-p)*(2/3-t)*6;
    return p;
  };
  return [Math.round(hue(hf+1/3)*255), Math.round(hue(hf)*255), Math.round(hue(hf-1/3)*255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number): string =>
    Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function buildBreathingPalette(primaryHex: string, hueStops: number, subSteps: number): string[] {
  const [r, g, b] = hexToRgb(primaryHex);
  const [baseHue] = rgbToHsl(r, g, b);
  const steps = hueStops * subSteps;

  const palette: string[] = [];
  for (let i = 0; i < steps; i++) {
    const hueAngle = (baseHue + (i / steps) * 360) % 360;
    const [rr, gg, bb] = hslToRgb(hueAngle, 90, 70);
    palette.push(rgbToHex(rr, gg, bb));
  }
  return palette;
}

function centerText(text: string, width: number): string {
  const visLen = visibleWidth(text);
  if (visLen >= width) return truncateToWidth(text, width, '…');
  const leftPad = Math.floor((width - visLen) / 2);
  const rightPad = width - visLen - leftPad;
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
}

/**
 * Colour a single logo line matching the welcome logo scheme:
 * - `█` blocks  → white (the "font")
 * - shadow chars → breathing primary colour (the "stroke")
 * - others       → dim grey
 */
function renderLogoLine(line: string, boxColor: (s: string) => string, dim: (s: string) => string, white: (s: string) => string): string {
  let out = '';
  for (const ch of line) {
    if (ch === ' ') { out += ' '; continue; }
    if (ch === '█') { out += white(ch); continue; }
    if (SHADOW_CHARS.has(ch)) { out += boxColor(ch); continue; }
    out += dim(ch);
  }
  return out;
}

/** Mix two #rrggbb colours (k=0 → from, k=1 → to). */
function mixHex(from: string, to: string, k: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  const t = Math.max(0, Math.min(1, k));
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

// Light rays: quick flashes that expand outward from the mascot, then vanish.
const RAY_LEN_MAX = 12;
const RAY_PULSE = 24;   // breathing frames per flash (≈0.4 s)
const RAY_PULSES = 4;   // flashes before the effect ends for good
// One colour step per impact (impacts alternate between the two rows,
// so they land every RAY_PULSE / 2 frames): 8 steps × 15 = full hue wheel.
const IMPACT_HUE_STEP = 15;

const easeOut = (x: number): number => 1 - (1 - Math.max(0, Math.min(1, x))) ** 3;

/**
 * One mascot row with symmetric light rays fanning outward.
 * While breathing (`breatheFrame` >= 0) the rays flash in a few quick pulses
 * that expand toward the edges and dissipate; when breathing has stopped
 * (`breatheFrame` < 0) or the pulses are over, the rays are gone entirely.
 */
function renderMascotRow(
  glyphs: string,
  contentWidth: number,
  breatheColor: string,
  dimColor: string,
  breatheFrame: number,
  pulseOffset = 0,
): string {
  const mascotX = Math.floor((contentWidth - glyphs.length) / 2);
  const leftAvail = Math.max(0, mascotX - 2);
  const rightAvail = Math.max(0, contentWidth - (mascotX + glyphs.length) - 2);
  const rayLen = Math.min(RAY_LEN_MAX, leftAvail, rightAvail);
  const cells = Array.from({ length: contentWidth }, () => ' ');

  for (let i = 0; i < glyphs.length; i++) {
    cells[mascotX + i] = chalk.hex(breatheColor)(glyphs[i]!);
  }

  // Each row gets a full run of pulses: the offset row finishes its last
  // flash instead of being cut mid-expansion when the shared window ends.
  if (rayLen > 0 && breatheFrame >= 0 && breatheFrame < RAY_PULSE * RAY_PULSES + pulseOffset) {
    const pulse = ((breatheFrame + pulseOffset) % RAY_PULSE) / RAY_PULSE;
    if (pulse <= 0.72) {
      const len = Math.max(1, Math.round(rayLen * easeOut(pulse / 0.72)));
      for (let i = 0; i < len; i++) {
        const head = i === len - 1;
        const distFromHead = len - 1 - i;
        const fade = len === 1 ? 0 : distFromHead / (len - 1);
        const glyph = head ? '█' : distFromHead <= 3 ? '▓' : distFromHead <= 7 ? '▒' : '░';
        const color = head
          ? breatheColor
          : mixHex(mixHex(breatheColor, dimColor, 0.1 + 0.9 * fade), dimColor, 0.25 * (pulse / 0.72));
        const painted = chalk.hex(color)(glyph);
        cells[mascotX - 2 - i] = painted;
        cells[mascotX + glyphs.length + 1 + i] = painted;
      }
    }
  }

  return cells.join('');
}

// ── Component ───────────────────────────────────────────────────────

export class WelcomeComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private ui: TUI;
  private breatheTimer: ReturnType<typeof setInterval> | null = null;
  private breatheTimeout: ReturnType<typeof setTimeout> | null = null;
  private breathePalette: string[];

  constructor(state: AppState, colors: ColorPalette, ui: TUI) {
    this.state = state;
    this.colors = colors;
    this.ui = ui;
    this.breathePalette = buildBreathingPalette(colors.primary, HUE_STOPS, SUB_STEPS);
    this.startBreathing();
  }

  stopBreathing(): void {
    if (this.breatheTimer !== null) {
      clearInterval(this.breatheTimer);
      this.breatheTimer = null;
      this.ui.requestRender();
    }
    if (this.breatheTimeout !== null) {
      clearTimeout(this.breatheTimeout);
      this.breatheTimeout = null;
    }
  }

  private startBreathing(): void {
    resetBreathingClock();
    this.breatheTimer = setInterval(() => {
      this.ui.requestRender();
    }, BREATHE_INTERVAL_MS);
    if (this.breatheTimeout === null) {
      this.breatheTimeout = setTimeout(() => {
        this.stopBreathing();
      }, BREATHE_CYCLE_MS);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const breatheFrame = this.breatheTimer !== null ? getBreathingFrame() : 0;
    // Colour steps once per impact: every light flash lands on a new hue
    // (same cadence as the ray pulses, so colour and impact stay in sync).
    const impactFrame = Math.min(breatheFrame, RAY_PULSE * RAY_PULSES - 1);
    const paletteIndex =
      (Math.floor(impactFrame / (RAY_PULSE / 2)) * IMPACT_HUE_STEP) % this.breathePalette.length;
    const breatheColor = this.breatheTimer !== null
      ? (this.breathePalette[paletteIndex] ?? this.colors.primary)
      : this.colors.primary;
    const boxColor = chalk.hex(breatheColor);
    const dim = chalk.hex(this.colors.textDim);
    const white = chalk.hex('#FFFFFF');

    const contentWidth = Math.max(MIN_PANEL_WIDTH, width);
    const useFullLogo = contentWidth >= FULL_LOGO_MIN_WIDTH;

    // Build info values.
    const isLoggedOut = !this.state.model;
    const activeModel = this.state.availableModels[this.state.model];
    const modelValue = isLoggedOut
      ? chalk.hex(this.colors.warning)(t('common.not_set'))
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);

    const like = this.state.like;
    const likeActive = Boolean(
      (like.nickname ?? '').trim() ||
        (like.tone ?? '').trim() ||
        (like.other ?? '').trim(),
    );
    const likeValue = likeActive
      ? chalk.hex(this.colors.success)(t('welcome.like_active'))
      : chalk.hex(this.colors.textDim)(t('welcome.like_inactive'));

    let versionValue: string;
    if (this.state.hasNewVersion && this.state.latestVersion !== null) {
      versionValue =
        chalk.hex(this.colors.warning)(this.state.version) +
        ' ' +
        dim('(' + this.state.latestVersion + ')');
    } else {
      versionValue = dim(this.state.version);
    }

    const lines: string[] = [''];

    const separator = dim(' · ');
    const helpValue = dim(t('welcome.help_hint'));

    if (useFullLogo) {
      // ── Mascot with spreading light rays, then the SCREAM art ─────
      const frameIdx = this.breatheTimer !== null ? Math.floor(breatheFrame / 24) % LOGO_FRAMES.length : 0;
      const frame = LOGO_FRAMES[frameIdx]!;
      const animFrame = this.breatheTimer !== null ? breatheFrame : -1;
      lines.push(renderMascotRow(frame[0], contentWidth, breatheColor, this.colors.textDim, animFrame));
      lines.push(renderMascotRow(frame[1], contentWidth, breatheColor, this.colors.textDim, animFrame, RAY_PULSE / 2));
      lines.push('');

      for (const line of LOGO) {
        const rendered = renderLogoLine(line, boxColor, dim, white);
        lines.push(centerText(rendered, contentWidth));
      }

      lines.push('');
      lines.push(centerText(versionValue + separator + modelValue + separator + likeValue + separator + helpValue, contentWidth));
      lines.push('');
    } else {
      // ── Compact logo face layout (narrow terminal) ──────────────
      const frameIdx = this.breatheTimer !== null ? Math.floor(breatheFrame / 24) % LOGO_FRAMES.length : 0;
      const frame = LOGO_FRAMES[frameIdx]!;
      const animFrame = this.breatheTimer !== null ? breatheFrame : -1;

      lines.push(renderMascotRow(frame[0], contentWidth, breatheColor, this.colors.textDim, animFrame));
      lines.push(renderMascotRow(frame[1], contentWidth, breatheColor, this.colors.textDim, animFrame, RAY_PULSE / 2));
      lines.push('');

      lines.push(centerText(versionValue + separator + modelValue + separator + likeValue + separator + helpValue, contentWidth));

      lines.push('');
    }

    return lines;
  }
}
