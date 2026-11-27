/**
 * Status row above the editor: one row that says what is going on right now.
 *
 *   working  `■■······  思考中 · 12s      Esc 中断` (the pulse wave, the phase and how long; the key that stops it)
 *   blocked  `◆ 等待批准 · 4m`                   (the session waits for the person)
 *   idle     `Tips  <one tip>        Ctrl+B 关闭`
 *
 * Notices (a fired reminder, a collaboration request, MCP) are not here: they
 * live in the footer's single notice slot. The only thing that shares this row
 * is the scroll cue ("↓ 2 new messages"), which belongs next to the transcript.
 *
 * The row is single-line by contract (the dock reserves exactly one row for it)
 * and is fitted item by item: an item shrinks, then is dropped whole, lowest
 * priority first; nothing is cut in the middle.
 */

import { Container, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import type { Component } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import { type FitItem, fitRow } from '#/tui/utils/fit-row';
import type { WorkState } from '#/tui/utils/status-text';

import type { PulseWaveLoader } from '../chrome/pulse-wave-loader';

/** One transient chip on the status row. */
export interface StatusChipLine {
  readonly text: string;
  readonly color?: string;
}

export type StatusBarMode = 'idle' | 'working' | 'blocked';

export interface StatusBarPaneOptions {
  readonly mode: StatusBarMode;
  readonly colors: ColorPalette;
  readonly pulseWave?: PulseWaveLoader;
  /**
   * Live work state (phase and time, or what the session waits for). Read on
   * every render so the clock moves without the row being rebuilt.
   */
  readonly state?: () => WorkState | null;
  /** Reconnect detail. It replaces the phase text while a retry is in flight. */
  readonly reconnect?: string;
  /** Idle: the tip, already composed (it may carry a link). Empty = no tip. */
  readonly tip?: string;
  /**
   * Shown while the transcript is scrolled up and the session goes on below it
   * ("↓ 2 new messages"). Read live like the state.
   */
  readonly scrollCue?: () => StatusChipLine | null;
  /**
   * True while Esc does something other than interrupt: a picker or a panel in
   * the editor's place closes on it, and queued messages are cancelled by it.
   * The row then does not offer Esc as the interrupt key. Read live.
   */
  readonly escTaken?: () => boolean;
}

/** Display widths a tip may shrink to, widest first (`…` included). */
const TIP_STEPS = [70, 50, 34, 22] as const;
/** Display widths the right-hand cue may shrink to. */
const CUE_STEPS = [40, 28, 18] as const;

function shrinkVariants(text: string, steps: readonly number[]): string[] {
  const out = [text];
  const width = visibleWidth(text);
  for (const cols of steps) if (cols < width) out.push(truncateToWidth(text, cols, '…'));
  return out;
}

class StatusLine implements Component {
  constructor(private readonly options: StatusBarPaneOptions) {}

  render(width: number): string[] {
    const { mode, colors, pulseWave, reconnect, tip, scrollCue } = this.options;
    // The tip is a quiet suggestion for an empty chat: the lightest tone the
    // theme has for text, so it never competes with what the person types.
    const quiet = chalk.hex(colors.textMuted);
    const left: FitItem[] = [];
    const right: FitItem[] = [];
    const cue = scrollCue?.() ?? null;

    if (mode === 'working') {
      if (pulseWave !== undefined) left.push({ id: 'wave', rank: 0, keep: true, variants: [pulseWave.getFrameText()] });
      if (reconnect !== undefined && reconnect.length > 0) {
        // Trouble outranks the phase: the row says what is wrong, in the warning colour.
        left.push({
          id: 'reconnect',
          rank: 1,
          dropRank: 6,
          variants: shrinkVariants(chalk.hex(colors.warning)(reconnect), [60, 40, 24]),
        });
      } else {
        const state = this.options.state?.() ?? null;
        if (state !== null) {
          left.push({
            id: 'state',
            rank: 1,
            dropRank: 6,
            // Grey, like the other quiet text: the wave already says "working", the
            // words only add which phase and how long, and must not glare.
            variants: state.variants.map((v) => chalk.hex(colors.textDim)(v)),
          });
        }
      }
    } else if (mode === 'blocked') {
      const state = this.options.state?.() ?? null;
      if (state !== null) {
        left.push({
          id: 'blocked',
          rank: 0.3,
          keep: true,
          variants: state.variants.map(
            (v) => `${chalk.hex(colors.warning).bold('◆')} ${chalk.hex(colors.warning).bold(v)}`,
          ),
        });
      }
    } else if (tip !== undefined && tip.length > 0) {
      left.push({
        id: 'tip',
        rank: 2,
        dropRank: 5,
        variants: shrinkVariants(`${quiet('Tips')}  ${quiet(tip)}`, TIP_STEPS),
      });
    }

    if (cue !== null) {
      const text = cue.color === undefined ? cue.text : chalk.hex(cue.color)(cue.text);
      right.push({ id: 'cue', rank: 1.5, dropRank: 4, variants: shrinkVariants(text, CUE_STEPS) });
    } else if (mode === 'working' && this.options.escTaken?.() !== true) {
      // The key that stops what the row describes, quiet like the rest of the row.
      // It is the first thing to give way: the phase says more than the key.
      right.push({
        id: 'esc',
        rank: 7,
        variants: [`${chalk.hex(colors.textDim)('Esc')} ${quiet(t('footer.hint_interrupt'))}`],
      });
    } else if (mode === 'idle' && tip !== undefined && tip.length > 0) {
      right.push({ id: 'close', rank: 3, variants: [chalk.hex(colors.textMuted)(t('status.tip_close'))] });
    }

    if (left.length === 0 && right.length === 0) return [];
    return [fitRow(left, right, Math.max(1, width), { itemGap: 2 })];
  }

  invalidate(): void {
    this.options.pulseWave?.invalidate();
  }
}

/**
 * Fixed one-line status row. Holds no timers: the wave instance is created and
 * stopped by LifecycleController, which recreates this component when the mode
 * changes.
 */
export class StatusBarPaneComponent extends Container {
  constructor(options: StatusBarPaneOptions) {
    super();
    this.update(options);
  }

  update(options: StatusBarPaneOptions): void {
    this.clear();
    this.addChild(new StatusLine(options));
  }
}
