/**
 * Welcome panel shown at the top of the TUI.
 *
 * Responsive layout (borderless):
 * - Wide terminal (≥55 cols): the mascot, the SCREAM wordmark, the info line
 *   and — when there is something to say — a second line (last session,
 *   memories, what waits for the person).
 * - Narrow terminal: the mascot, the info line and the second line.
 *
 * It opens with a short intro (wake → scream → settle, see `introFrame`) and
 * then glances around now and then until the person types.
 */

import type { Component, TUI } from '@liutod-scream/pi-tui';
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, RecentSession } from '#/tui/types';
import { BREATHE_INTERVAL_MS } from '#/tui/utils/breathing-clock';
import { motionEnabled } from '#/tui/utils/motion';
import { formatRelativeTime } from '#/tui/utils/relative-time';

// 24 hues × 5 interpolated steps = 120 palette entries. Each shout of the
// intro jumps SHOUT_HUE_STEP entries, so every colour change lands on a burst
// of light instead of drifting continuously.
const HUE_STOPS = 24;
const SUB_STEPS = 5;

const MIN_PANEL_WIDTH = 50;

// SCREAM art is 51 columns wide (longest line); keep a small margin.
const FULL_LOGO_MIN_WIDTH = 55;
const LOGO_WIDTH = 51;

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

// ── The mascot ──────────────────────────────────────────────────────
// Two rows: the head, then the face. Its only expressions are the original
// ones — the `▀` looking straight on, centre, left and right.
const FACE_TOP = '██▄▄▄██';
const FACE = {
  open: '▐█▄▀▄█▌',
  centre: '▐▄▄▀▄▄▌',
  left: '▐▄▀▄▄▄▌',
  right: '▐▄▄▄▀▄▌',
} as const;
// Each shout looks somewhere new, in the original order.
const SHOUT_FACES = [FACE.centre, FACE.left, FACE.right] as const;

// ── The intro: wake → scream → settle (ms from the start) ───────────
const WAKE_MS = 500;            // looking down the middle, brightening; then straight on
const SHOUTS_MS = [500, 800, 1100] as const; // three shouts, each a ray burst
const SHOUT_MS = 300;
const SCREAM_END_MS = 1400;
const SWEEP_START_MS = 600;     // the wordmark is swept in left to right
const SWEEP_MS = 1000;
const SETTLE_MS = 700;          // the colour comes home to primary
const INFO_START_MS = 1600;     // the info line types itself out
const INFO_MS = 800;
const INTRO_MS = 2400;
// After the intro the mascot glances left and right now and then, until the
// person types: left, right, then straight on again.
const BLINK_EVERY_MS = 6000;
const BLINK_MS = 220;
// A bounded idle: a welcome left on screen (after /clear the first-input hook
// has already fired) stops by itself instead of rendering forever.
const MAX_BLINKS = 10;
// One hue step per shout (45° around the wheel).
const SHOUT_HUE_STEP = 15;

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

const easeOut = (x: number): number => 1 - (1 - Math.max(0, Math.min(1, x))) ** 3;

// Light rays: a burst that expands outward from the mascot, then vanishes.
const RAY_LEN_MAX = 12;

/**
 * One mascot row with symmetric light rays. `pulse` runs 0..1 over one burst
 * (the rays grow for the first 72% and fade with it); null draws no rays.
 */
function renderMascotRow(
  glyphs: string,
  contentWidth: number,
  color: string,
  dimColor: string,
  pulse: number | null,
): string {
  const mascotX = Math.floor((contentWidth - glyphs.length) / 2);
  const leftAvail = Math.max(0, mascotX - 2);
  const rightAvail = Math.max(0, contentWidth - (mascotX + glyphs.length) - 2);
  const rayLen = Math.min(RAY_LEN_MAX, leftAvail, rightAvail);
  const cells = Array.from({ length: contentWidth }, () => ' ');
  for (let i = 0; i < glyphs.length; i++) {
    cells[mascotX + i] = chalk.hex(color)(glyphs[i]!);
  }
  if (rayLen > 0 && pulse !== null && pulse >= 0 && pulse <= 0.72) {
    const len = Math.max(1, Math.round(rayLen * easeOut(pulse / 0.72)));
    for (let i = 0; i < len; i++) {
      const head = i === len - 1;
      const distFromHead = len - 1 - i;
      const fade = len === 1 ? 0 : distFromHead / (len - 1);
      const glyph = head ? '█' : distFromHead <= 3 ? '▓' : distFromHead <= 7 ? '▒' : '░';
      const rayColor = head
        ? color
        : mixHex(mixHex(color, dimColor, 0.1 + 0.9 * fade), dimColor, 0.25 * (pulse / 0.72));
      const painted = chalk.hex(rayColor)(glyph);
      cells[mascotX - 2 - i] = painted;
      cells[mascotX + glyphs.length + 1 + i] = painted;
    }
  }
  return cells.join('');
}

/** What the intro shows at `ms` (exported for tests). */
export interface IntroFrame {
  readonly face: string;
  /** Index into the hue wheel; null for the resting primary colour. */
  readonly hueStep: number | null;
  /** 0 → dim outline, 1 → full colour (the wake). */
  readonly brightness: number;
  /** 0 → the shout's hue, 1 → back to primary (the settle). */
  readonly settle: number;
  readonly pulseTop: number | null;
  readonly pulseFace: number | null;
  /** Wordmark shake: -1, 0 or 1 column. */
  readonly shift: number;
  /** Share of the wordmark's columns drawn (0..1). */
  readonly reveal: number;
  /** Share of the info line typed out (0..1). */
  readonly info: number;
}

export function introFrame(ms: number): IntroFrame {
  const rest: IntroFrame = {
    face: FACE.open, hueStep: null, brightness: 1, settle: 1,
    pulseTop: null, pulseFace: null, shift: 0, reveal: 1, info: 1,
  };
  if (ms >= INTRO_MS) return rest;
  const reveal = ms < SWEEP_START_MS ? 0 : easeOut((ms - SWEEP_START_MS) / SWEEP_MS);
  const info = ms < INFO_START_MS ? 0 : Math.min(1, (ms - INFO_START_MS) / INFO_MS);
  if (ms < WAKE_MS) {
    // Waking up: looking down the middle, then straight on.
    return { ...rest, face: ms < 300 ? FACE.centre : FACE.open, brightness: easeOut(ms / WAKE_MS), reveal, info };
  }
  const shoutsDone = SHOUTS_MS.filter((start) => ms >= start).length;
  if (ms < SCREAM_END_MS) {
    const shout = SHOUTS_MS.findIndex((start) => ms >= start && ms < start + SHOUT_MS);
    if (shout === -1) return { ...rest, hueStep: shoutsDone, settle: 0, reveal, info };
    const t = (ms - SHOUTS_MS[shout]!) / SHOUT_MS;
    return {
      ...rest,
      face: SHOUT_FACES[shout]!,
      hueStep: shout + 1,
      settle: 0,
      pulseTop: t,
      pulseFace: Math.max(0, t - 0.12),
      shift: t < 0.12 ? (shout % 2 === 0 ? 1 : -1) : 0,
      reveal,
      info,
    };
  }
  return { ...rest, hueStep: shoutsDone, settle: easeOut((ms - SCREAM_END_MS) / SETTLE_MS), reveal, info };
}

/** Wordmark line with only its first `columns` drawn; a white scan head at the edge. */
function revealLogoLine(
  line: string,
  columns: number,
  boxColor: (s: string) => string,
  dim: (s: string) => string,
  white: (s: string) => string,
): string {
  const chars = Array.from(line);
  if (columns >= chars.length) return renderLogoLine(line, boxColor, dim, white);
  const shown = chars.slice(0, columns).join('');
  const scanned = columns > 0 ? renderLogoLine(chars.slice(0, Math.max(0, columns - 1)).join(''), boxColor, dim, white) : '';
  const head = columns > 0 && shown.at(-1) !== ' ' ? chalk.bold.hex('#FFFFFF')(shown.at(-1)!) : columns > 0 ? ' ' : '';
  return scanned + head + ' '.repeat(chars.length - columns);
}

// ── Component ───────────────────────────────────────────────────────

export class WelcomeComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private ui: TUI;
  private introTimer: ReturnType<typeof setInterval> | null = null;
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  private introStart = 0;
  /** The idle glance: null, or which way the mascot is looking. */
  private glance: 'left' | 'right' | null = null;
  private blinks = 0;
  private breathePalette: string[];
  /**
   * Whether Ctrl+R would resume the last session right now (a new page:
   * nothing in the transcript, nothing typed). The hint shows exactly then,
   * so it never offers a key that does nothing. Absent: never offered.
   */
  private readonly resumeAvailable: () => boolean;

  constructor(state: AppState, colors: ColorPalette, ui: TUI, options: { resumeAvailable?: () => boolean } = {}) {
    this.state = state;
    this.colors = colors;
    this.ui = ui;
    this.resumeAvailable = options.resumeAvailable ?? (() => false);
    this.breathePalette = buildBreathingPalette(colors.primary, HUE_STOPS, SUB_STEPS);
    this.startIntro();
  }

  /** Ends the intro and the idle glances for good (the person started typing). */
  stopBreathing(): void {
    const wasMoving = this.introTimer !== null || this.glance !== null;
    if (this.introTimer !== null) {
      clearInterval(this.introTimer);
      this.introTimer = null;
    }
    if (this.blinkTimer !== null) {
      clearTimeout(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.glance = null;
    if (wasMoving) this.ui.requestRender();
  }

  private startIntro(): void {
    if (!motionEnabled()) return; // resting frame, no timers
    this.introStart = Date.now();
    this.introTimer = setInterval(() => {
      if (Date.now() - this.introStart >= INTRO_MS) {
        if (this.introTimer !== null) clearInterval(this.introTimer);
        this.introTimer = null;
        this.scheduleBlink();
      }
      this.ui.requestRender();
    }, BREATHE_INTERVAL_MS);
  }

  /** One glance every BLINK_EVERY_MS: left, right, straight on (three renders). */
  private scheduleBlink(): void {
    if (this.blinks >= MAX_BLINKS) {
      this.blinkTimer = null;
      return;
    }
    this.blinks += 1;
    const step = (next: 'left' | 'right' | null, then: () => void, delay: number): void => {
      this.blinkTimer = setTimeout(() => {
        this.glance = next;
        this.ui.requestRender();
        then();
      }, delay);
      this.blinkTimer.unref?.();
    };
    step('left', () => {
      step('right', () => {
        step(null, () => {
          this.scheduleBlink();
        }, BLINK_MS);
      }, BLINK_MS);
    }, BLINK_EVERY_MS);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const frame = this.introTimer !== null ? introFrame(Date.now() - this.introStart) : introFrame(INTRO_MS);
    const shoutColor =
      frame.hueStep === null
        ? this.colors.primary
        : (this.breathePalette[(frame.hueStep * SHOUT_HUE_STEP) % this.breathePalette.length] ?? this.colors.primary);
    let color = frame.settle >= 1 ? this.colors.primary : mixHex(shoutColor, this.colors.primary, frame.settle);
    if (frame.brightness < 1) color = mixHex(this.colors.textDim, color, frame.brightness);
    const face = this.glance === null ? frame.face : FACE[this.glance];
    const boxColor = chalk.hex(color);
    const dim = chalk.hex(this.colors.textDim);
    const white = chalk.hex('#FFFFFF');

    const contentWidth = Math.max(MIN_PANEL_WIDTH, width);
    const useFullLogo = contentWidth >= FULL_LOGO_MIN_WIDTH;

    const lines: string[] = [
      '',
      renderMascotRow(FACE_TOP, contentWidth, color, this.colors.textDim, frame.pulseTop),
      renderMascotRow(face, contentWidth, color, this.colors.textDim, frame.pulseFace),
      '',
    ];

    if (useFullLogo) {
      const columns = Math.round(LOGO_WIDTH * frame.reveal);
      for (const line of LOGO) {
        const rendered = revealLogoLine(line, columns, boxColor, dim, white);
        lines.push(shiftLine(centerText(rendered, contentWidth), frame.shift, contentWidth));
      }
      lines.push('');
    }

    const info = this.infoLine();
    // Typed out from its final left edge (padded to full width), so it never slides.
    const infoWidth = visibleWidth(info);
    const typed = frame.info >= 1 ? info : truncateToWidth(info, Math.floor(infoWidth * frame.info), '');
    lines.push(centerText(typed + ' '.repeat(Math.max(0, infoWidth - visibleWidth(typed))), contentWidth));
    lines.push('');

    // The status line arrives last, once the info line has typed itself out;
    // its row is kept blank until then so nothing below jumps.
    const status = this.statusLine(contentWidth);
    if (status !== undefined) {
      lines.push(frame.info >= 1 ? centerText(status, contentWidth) : '');
      lines.push('');
    }
    return lines;
  }

  private infoLine(): string {
    const dim = chalk.hex(this.colors.textDim);
    const isLoggedOut = !this.state.model;
    const activeModel = this.state.availableModels[this.state.model];
    const modelValue = isLoggedOut
      ? chalk.hex(this.colors.warning)(t('common.not_set'))
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);
    const like = this.state.like;
    const likeActive = Boolean((like.nickname ?? '').trim() || (like.tone ?? '').trim() || (like.other ?? '').trim());
    const likeValue = likeActive
      ? chalk.hex(this.colors.success)(t('welcome.like_active'))
      : dim(t('welcome.like_inactive'));
    const versionValue =
      this.state.hasNewVersion && this.state.latestVersion !== null
        ? chalk.hex(this.colors.warning)(this.state.version) + ' ' + dim('(' + this.state.latestVersion + ')')
        : dim(this.state.version);
    const separator = dim(' · ');
    return versionValue + separator + modelValue + separator + likeValue + separator + dim(t('welcome.help_hint'));
  }

  /**
   * The second line under the logo, in the info line's voice (centred, dim,
   * `·`): the last conversation of this folder, how much Scream remembers,
   * and what waits for the person (the only part in a warning colour). Left
   * out only when there is nothing at all, as on a first start.
   */
  private statusLine(contentWidth: number): string | undefined {
    const dim = chalk.hex(this.colors.textDim);
    const parts: string[] = [];
    const last = lastSessionToResume(this.state);
    const waiting = this.state.jobsWaiting ?? 0;
    if (last !== undefined) {
      let part = dim(t('welcome.hint_last', { title: last.title!.trim(), time: formatRelativeTime(last.updatedAt) }));
      // Ctrl+R resumes it while the page is new (see EditorKeyboardController).
      if (this.resumeAvailable()) part += ' ' + chalk.hex(this.colors.primary)('Ctrl+R') + ' ' + dim(t('welcome.hint_resume_key'));
      parts.push(part);
    }
    const memories = this.state.memoryCount ?? 0;
    if (memories > 0) parts.push(dim(t('welcome.hint_memory', { count: String(memories) })));
    if (waiting > 0) parts.push(chalk.hex(this.colors.warning)(t('welcome.hint_waiting', { count: String(waiting) })));
    if (parts.length === 0) return undefined;
    const line = parts.join(dim(' · '));
    // A long title is cut, never the line pushed past the panel.
    return visibleWidth(line) > contentWidth - 4 ? truncateToWidth(line, contentWidth - 4, '…') : line;
  }
}

/**
 * The conversation the welcome offers to resume: the newest one of this
 * folder (already filtered at start), not the current one, with a real title.
 */
export function lastSessionToResume(state: Pick<AppState, 'recentSessions' | 'sessionId'>): RecentSession | undefined {
  return (state.recentSessions ?? []).find(
    (session) =>
      session.id !== state.sessionId && (session.title ?? '').trim() !== '' && session.title !== 'New Session',
  );
}

/** Move a centred line one column left or right (the wordmark's shake). */
function shiftLine(line: string, shift: number, width: number): string {
  if (shift > 0) return truncateToWidth(' ' + line, width, '');
  if (shift < 0 && line.startsWith(' ')) return line.slice(1) + ' ';
  return line;
}
