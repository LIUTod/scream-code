/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box with the logo, session, model, and version.
 *
 * The two-line ASCII logo cycles through a full 24-colour hue wheel
 * (like addressable RGB LEDs) — starting and ending at the theme's
 * primary green, smoothly sweeping through the full spectrum.
 */

import type { Component, TUI } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

// 24 hues × 5 interpolated steps = 120 frames × 40 ms ≈ 4.8 s cycle.
const HUE_STOPS = 24;
const SUB_STEPS = 5;
const BREATHE_STEPS = HUE_STOPS * SUB_STEPS; // 120
const BREATHE_INTERVAL_MS = 40;

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

// ── Palette builder ─────────────────────────────────────────────────

/**
 * Build a full-hue-wheel palette anchored at the primary-green hue.
 * At frame 0 (and BREATHE_STEPS) the colour is pure primary; in between
 * it sweeps through all 24 hue stops with smooth sub-step interpolation.
 */
function buildBreathingPalette(primaryHex: string, hueStops: number, subSteps: number): string[] {
  const [r, g, b] = hexToRgb(primaryHex);
  const [baseHue, sat, lit] = rgbToHsl(r, g, b);
  const steps = hueStops * subSteps;

  const palette: string[] = [];
  for (let i = 0; i < steps; i++) {
    // Map frame index to a hue angle, anchored at the primary hue so frame 0 = primary green.
    const hueAngle = (baseHue + (i / steps) * 360) % 360;
    const [rr, gg, bb] = hslToRgb(hueAngle, sat, lit);
    palette.push(rgbToHex(rr, gg, bb));
  }
  return palette;
}

// ── Component ───────────────────────────────────────────────────────

export class WelcomeComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private ui: TUI;
  private breatheFrame = 0;
  private breatheTimer: ReturnType<typeof setInterval> | null = null;
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
    }
    // Reset to frame 0 (primary green) so the logo doesn't freeze on a
    // random hue from the middle of the wheel.
    if (this.breatheFrame !== 0) {
      this.breatheFrame = 0;
      this.ui.requestRender();
    }
  }

  private startBreathing(): void {
    this.breatheTimer = setInterval(() => {
      this.breatheFrame = (this.breatheFrame + 1) % BREATHE_STEPS;
      this.ui.requestRender();
    }, BREATHE_INTERVAL_MS);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const breatheColor = this.breathePalette[this.breatheFrame] ?? this.colors.primary;
    const logoColor = (s: string): string => chalk.hex(breatheColor)(s);
    const primary = (s: string): string => chalk.hex(this.colors.primary)(s);
    const dim = chalk.hex(this.colors.textDim);
    const labelStyle = chalk.bold.hex(this.colors.textDim);
    const innerWidth = Math.max(10, width - 4);
    const pad = '  ';
    const isLoggedOut = !this.state.model;

    // ── Logo ──
    const logo = [logoColor('██▄▄▄██'), logoColor('▐█▄▀▄█▌')];

    // ── Info ──
    const activeModel = this.state.availableModels[this.state.model];
    const modelValue = isLoggedOut
      ? chalk.hex(this.colors.warning)('未设置，运行 /config')
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);

    let versionValue: string;
    if (this.state.hasNewVersion && this.state.latestVersion !== null) {
      versionValue =
        chalk.hex(this.colors.warning)(this.state.version) +
        '  ' +
        chalk.hex(this.colors.textDim)('有新版本（' + this.state.latestVersion + '）');
    } else {
      versionValue = this.state.version;
    }

    const hintText = isLoggedOut
      ? '运行 /config 开始配置'
      : '发送 / 进入快捷菜单，/exit 保存并退出';

    const contentLines: string[] = [
      '',
      ...logo,
      '',
      labelStyle('版本：') + ' ' + versionValue,
      labelStyle('模型：') + ' ' + modelValue,
      labelStyle('目录：') + ' ' + this.state.workDir,
      '',
      dim(hintText),
      '',
    ];

    // ── Top border with centered title ──
    const borderTitle = this.borderTitle ?? '';
    const contentWidth = width - 2;
    let topBorder: string;
    if (borderTitle) {
      const centerPos = Math.floor(contentWidth / 2);
      const titleText = `─ ${borderTitle} ─`;
      const titleStart = centerPos - Math.floor(visibleWidth(titleText) / 2);
      const leftDash = Math.max(0, titleStart);
      const rightDash = Math.max(0, contentWidth - leftDash - visibleWidth(titleText));
      topBorder = primary('╭' + '─'.repeat(leftDash) + titleText + '─'.repeat(rightDash) + '╮');
    } else {
      topBorder = primary('╭' + '─'.repeat(contentWidth) + '╮');
    }

    const lines: string[] = [
      '',
      topBorder,
      primary('│') + ' '.repeat(width - 2) + primary('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const centerPad = Math.floor((width - 1 - vis) / 2);
      const rightPad = width - 2 - vis - centerPad;
      lines.push(primary('│') + ' '.repeat(centerPad) + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('│') + ' '.repeat(width - 2) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(width - 2) + '╯'));
    lines.push('');

    return lines;
  }
}
