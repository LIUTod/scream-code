import { Text } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import {
  PULSE_WAVE_FRAMES,
  PULSE_WAVE_INTERVAL_MS,
} from '#/tui/constant/rendering';

const FULL_BOX = '■';
const DIM_DOT = '⬝';

/**
 * 3-box pulse-wave loading indicator.
 *
 * Cycles through a breathing wave pattern:
 *   ■ ⬝ ⬝  →  ■ ■ ⬝  →  ⬝ ■ ■  →  (bounce back)
 *
 * Colouring mirrors Grok's PromptLoadingBoxes:
 *   - active box (distance 0) → full primary colour
 *   - trailing box (distance 1) → ~72 % opacity via chalk dim
 *   - dim dot (distance ≥ 2) → muted
 *
 * The component auto-starts on construction. Call `stop()` to tear
 * down the interval timer.
 */
export class PulseWaveLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ui: TUI;
  private colorHex: string;

  constructor(ui: TUI, colorHex: string) {
    super('', 1, 0);
    this.ui = ui;
    this.colorHex = colorHex;
    this.start();
  }

  start(): void {
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % PULSE_WAVE_FRAMES.length;
      this.updateDisplay();
    }, PULSE_WAVE_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  setColorHex(colorHex: string): void {
    this.colorHex = colorHex;
    this.updateDisplay();
  }

  private updateDisplay(): void {
    const step = PULSE_WAVE_FRAMES[this.currentFrame] ?? PULSE_WAVE_FRAMES[0];
    const cells = [0, 1, 2].map((idx) => this.renderCell(idx, step.active, step.forward));
    this.setText(cells.join(' '));
    this.ui.requestRender();
  }

  private renderCell(index: number, active: number, forward: boolean): string {
    const distance = forward ? active - index : index - active;
    const glyph = distance >= 0 && distance < 2 ? FULL_BOX : DIM_DOT;

    if (distance === 0) return chalk.hex(this.colorHex)(glyph);
    if (distance === 1) return chalk.hex(this.colorHex).dim(glyph);
    return chalk.dim(glyph);
  }
}
