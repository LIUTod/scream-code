/**
 * Welcome panel shown at the top of the TUI.
 *
 * Layout: a single rounded box split into three areas by internal lines.
 *   - Left column: logo + model + version, vertically centered.
 *   - Right top: quick-start tips.
 *   - Right bottom: recent sessions.
 *
 * The logo, outer border, and section titles share the theme's breathing
 * primary colour; content stays muted.
 */

import type { Component, TUI } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, RecentSession } from '#/tui/types';

// 24 hues × 5 interpolated steps = 120 frames × 40 ms ≈ 4.8 s cycle.
const HUE_STOPS = 24;
const SUB_STEPS = 5;
const BREATHE_STEPS = HUE_STOPS * SUB_STEPS; // 120
const BREATHE_INTERVAL_MS = 40;

const WELCOME_TIPS: readonly string[] = [
  '/config  配置模型',
  '/sessions  恢复历史会话',
  '/  输入后打开快捷菜单',
];

const WELCOME_SESSION_SLOTS = 3;
const LEFT_COLUMN_WIDTH = 22;
const MIN_BOX_WIDTH = 50;

// ── Logo face animation frames ──────────────────────────────────────
const LOGO_FRAMES: [string, string][] = [
  ['██▄▄▄██', '▐█▄▀▄█▌'], // 回中
  ['██▄▄▄██', '▐▄▄▀▄▄▌'], // 眯眼
  ['██▄▄▄██', '▐▄▀▄▄▄▌'], // 细眯眼（左）
  ['██▄▄▄██', '▐▄▄▄▀▄▌'], // 细眯眼（右）
  ['██▄▄▄██', '▐█▄▀▄█▌'], // 睁开
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

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
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

// ── Component ───────────────────────────────────────────────────────

export class WelcomeComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private ui: TUI;
  private breatheFrame = 0;
  private breatheTimer: ReturnType<typeof setInterval> | null = null;
  private breathePalette: string[];
  private recentSessions: readonly RecentSession[];
  borderTitle: string | null = null;

  constructor(state: AppState, colors: ColorPalette, ui: TUI, recentSessions: readonly RecentSession[] = []) {
    this.state = state;
    this.colors = colors;
    this.ui = ui;
    this.recentSessions = recentSessions;
    this.breathePalette = buildBreathingPalette(colors.primary, HUE_STOPS, SUB_STEPS);
    this.startBreathing();
  }

  stopBreathing(): void {
    if (this.breatheTimer !== null) {
      clearInterval(this.breatheTimer);
      this.breatheTimer = null;
    }
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
    const boxColor = chalk.hex(breatheColor);
    const dim = chalk.hex(this.colors.textDim);
    const muted = chalk.hex(this.colors.textMuted);
    const titleColor = chalk.bold.hex(breatheColor);

    const boxWidth = Math.max(MIN_BOX_WIDTH, width);
    const innerWidth = boxWidth - 2;
    const showRightColumn = innerWidth >= 55;
    const leftCol = showRightColumn ? LEFT_COLUMN_WIDTH : innerWidth;
    const rightCol = showRightColumn ? Math.max(10, innerWidth - leftCol - 1) : 0;

    const isLoggedOut = !this.state.model;
    const activeModel = this.state.availableModels[this.state.model];
    const modelValue = isLoggedOut
      ? chalk.hex(this.colors.warning)('未设置')
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);

    let versionValue: string;
    if (this.state.hasNewVersion && this.state.latestVersion !== null) {
      versionValue =
        chalk.hex(this.colors.warning)(this.state.version) +
        ' ' +
        dim('(' + this.state.latestVersion + ')');
    } else {
      versionValue = this.state.version;
    }

    const frameIdx = this.breatheTimer !== null ? Math.floor(this.breatheFrame / 24) % LOGO_FRAMES.length : 0;
    const frame = LOGO_FRAMES[frameIdx]!;
    const logo = [boxColor(frame[0]), boxColor(frame[1])];

    // Right column content.
    const tipLines: string[] = [];
    for (const tip of WELCOME_TIPS) {
      tipLines.push(` ${dim('•')} ${muted(tip)}`);
    }

    const sessionLines: string[] = [];
    const sessions = this.recentSessions.slice(0, WELCOME_SESSION_SLOTS);
    if (sessions.length === 0) {
      sessionLines.push(` ${dim('•')} ${muted('无最近会话')}`);
    } else {
      for (const session of sessions) {
        const name = session.title ?? session.id;
        const timeAgo = formatTimeAgo(session.updatedAt);
        sessionLines.push(` ${dim('•')} ${muted(name)} ${dim(`(${timeAgo})`)}`);
      }
    }

    let leftRows: string[];
    let rightRows: string[] = [];
    let separatorRow = -1;

    if (showRightColumn) {
      rightRows = [
        ` ${titleColor('Tips')}`,
        ...tipLines,
        boxColor('─'.repeat(rightCol)),
        ` ${titleColor('最近会话')}`,
        ...sessionLines,
      ];
      separatorRow = 1 + tipLines.length;

      const leftContent = [
        '',
        centerText(logo[0]!, leftCol),
        centerText(logo[1]!, leftCol),
        '',
        centerText(dim(versionValue), leftCol),
        centerText(dim(modelValue), leftCol),
      ];
      const topPad = Math.max(0, Math.floor((rightRows.length - leftContent.length) / 2));
      const bottomPad = Math.max(0, rightRows.length - leftContent.length - topPad);
      leftRows = [
        ...Array(topPad).fill(''),
        ...leftContent,
        ...Array(bottomPad).fill(''),
      ];
    } else {
      const leftContent = [
        '',
        centerText(logo[0]!, leftCol),
        centerText(logo[1]!, leftCol),
        '',
        centerText(dim(versionValue), leftCol),
        centerText(dim(modelValue), leftCol),
        '',
      ];
      leftRows = leftContent;
    }

    // Top border with the title centered above the left-column logo.
    const borderTitle = this.borderTitle ?? '';
    const contentWidth = boxWidth - 2;
    let topBorder: string;
    if (borderTitle) {
      const titleVis = visibleWidth(borderTitle);
      const textPad = Math.floor((leftCol - titleVis) / 2);
      const leftDash = Math.max(0, textPad - 2);
      const titleText = `─ ${borderTitle} ─`;
      const titleBlockVis = titleVis + 4;
      const rightDash = Math.max(0, contentWidth - leftDash - titleBlockVis);
      topBorder = boxColor('╭' + '─'.repeat(leftDash) + titleText + '─'.repeat(rightDash) + '╮');
    } else {
      topBorder = boxColor('╭' + '─'.repeat(contentWidth) + '╮');
    }

    const lines: string[] = [''];
    const boxOffset = '';

    lines.push(boxOffset + topBorder);

    const totalRows = Math.max(leftRows.length, rightRows.length);
    for (let i = 0; i < totalRows; i++) {
      const left = this.#fitToWidth(leftRows[i] ?? '', leftCol);
      if (showRightColumn) {
        const right = this.#fitToWidth(rightRows[i] ?? '', rightCol);
        const sep = i === separatorRow ? boxColor('├') : boxColor('│');
        lines.push(boxOffset + boxColor('│') + left + sep + right + boxColor('│'));
      } else {
        lines.push(boxOffset + boxColor('│') + left + boxColor('│'));
      }
    }

    if (showRightColumn) {
      lines.push(boxOffset + boxColor('╰' + '─'.repeat(leftCol) + '┴' + '─'.repeat(rightCol) + '╯'));
    } else {
      lines.push(boxOffset + boxColor('╰' + '─'.repeat(leftCol) + '╯'));
    }
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
