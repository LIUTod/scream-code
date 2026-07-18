/**
 * Welcome panel shown at the top of the TUI.
 *
 * Responsive layout:
 * - Wide terminal (≥87 cols): full SCREAM CODE ASCII art with per-char
 *   colouring (█ white, stroke breathing, others dim) + centred info line.
 * - Narrow terminal: compact logo face + centred info line.
 *
 * The outer border uses the theme's breathing primary colour.
 */

import type { Component, TUI } from '@liutod-scream/pi-tui';
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import { BREATHE_CYCLE_MS, BREATHE_INTERVAL_MS, getBreathingFrame, resetBreathingClock } from '#/tui/utils/breathing-clock';

// 24 hues × 5 interpolated steps = 120 frames × 40 ms ≈ 4.8 s cycle.
const HUE_STOPS = 24;
const SUB_STEPS = 5;

const MIN_BOX_WIDTH = 50;

// Full SCREAM CODE art needs 85 columns of inner width (longest line).
// With 2 border chars that means 87 terminal columns minimum.
const FULL_LOGO_MIN_WIDTH = 87;

// ── Full SCREAM CODE ASCII art (matches loading splash) ────────────
const LOGO = [
  '███████╗ ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗  ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗████╗ ████║ ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '███████╗██║     ██████╔╝█████╗  ███████║██╔████╔██║ ██║     ██║   ██║██║  ██║█████╗  ',
  '╚════██║██║     ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║ ██║     ██║   ██║██║  ██║██╔══╝  ',
  '███████║╚██████╗██║  ██║███████╗██║  ██║██║ ╚═╝ ██║ ╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
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

function padSpaces(n: number): string {
  return ' '.repeat(Math.max(0, n));
}

function centerText(text: string, width: number): string {
  const visLen = visibleWidth(text);
  if (visLen >= width) return truncateToWidth(text, width, '…');
  const leftPad = Math.floor((width - visLen) / 2);
  const rightPad = width - visLen - leftPad;
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
}

/**
 * Colour a single logo line matching the loading splash scheme:
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

// ── Component ───────────────────────────────────────────────────────

export class WelcomeComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private ui: TUI;
  private breatheTimer: ReturnType<typeof setInterval> | null = null;
  private breatheTimeout: ReturnType<typeof setTimeout> | null = null;
  private breathePalette: string[];
  borderTitle: string | null = null;

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
    const breatheColor = this.breatheTimer !== null
      ? (this.breathePalette[breatheFrame] ?? this.colors.primary)
      : this.colors.primary;
    const boxColor = chalk.hex(breatheColor);
    const dim = chalk.hex(this.colors.textDim);
    const white = chalk.hex('#FFFFFF');

    const boxWidth = Math.max(MIN_BOX_WIDTH, width);
    const innerWidth = boxWidth - 2;
    const useFullLogo = boxWidth >= FULL_LOGO_MIN_WIDTH;

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

    // Top border with centred title.
    const borderTitle = this.borderTitle ?? '';
    const contentWidth = boxWidth - 2;
    let topBorder: string;
    if (borderTitle) {
      const titleVis = visibleWidth(borderTitle);
      const titleText = `─ ${borderTitle} ─`;
      const titleBlockVis = titleVis + 4;
      const leftDash = Math.max(0, Math.floor((contentWidth - titleBlockVis) / 2));
      const rightDash = Math.max(0, contentWidth - leftDash - titleBlockVis);
      topBorder = boxColor('╭' + '─'.repeat(leftDash) + titleText + '─'.repeat(rightDash) + '╮');
    } else {
      topBorder = boxColor('╭' + '─'.repeat(contentWidth) + '╮');
    }

    const lines: string[] = [''];
    lines.push(topBorder);

    const separator = dim(' · ');
    const helpValue = dim(t('welcome.help_hint'));

    if (useFullLogo) {
      // ── Full SCREAM CODE art layout ──────────────────────────────
      lines.push(boxColor('│') + padSpaces(innerWidth) + boxColor('│'));

      for (const line of LOGO) {
        const rendered = renderLogoLine(line, boxColor, dim, white);
        lines.push(boxColor('│') + this.#fitToWidth(centerText(rendered, innerWidth), innerWidth) + boxColor('│'));
      }

      lines.push(boxColor('│') + padSpaces(innerWidth) + boxColor('│'));

      const infoLine = centerText(versionValue + separator + modelValue + separator + likeValue + separator + helpValue, innerWidth);
      lines.push(boxColor('│') + this.#fitToWidth(infoLine, innerWidth) + boxColor('│'));

      lines.push(boxColor('│') + padSpaces(innerWidth) + boxColor('│'));
    } else {
      // ── Compact logo face layout (narrow terminal) ──────────────
      const frameIdx = this.breatheTimer !== null ? Math.floor(breatheFrame / 24) % LOGO_FRAMES.length : 0;
      const frame = LOGO_FRAMES[frameIdx]!;

      lines.push(boxColor('│') + padSpaces(innerWidth) + boxColor('│'));
      lines.push(boxColor('│') + centerText(boxColor(frame[0]), innerWidth) + boxColor('│'));
      lines.push(boxColor('│') + centerText(boxColor(frame[1]), innerWidth) + boxColor('│'));
      lines.push(boxColor('│') + padSpaces(innerWidth) + boxColor('│'));

      const infoLine = centerText(versionValue + separator + modelValue + separator + likeValue + separator + helpValue, innerWidth);
      lines.push(boxColor('│') + this.#fitToWidth(infoLine, innerWidth) + boxColor('│'));

      lines.push(boxColor('│') + padSpaces(innerWidth) + boxColor('│'));
    }

    lines.push(boxColor('╰' + '─'.repeat(innerWidth) + '╯'));
    lines.push('');

    return lines;
  }

  #fitToWidth(str: string, width: number): string {
    const visLen = visibleWidth(str);
    if (visLen > width) {
      return truncateToWidth(str, width, '…');
    }
    return str + padSpaces(width - visLen);
  }
}
