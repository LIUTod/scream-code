import { Text } from '@liutod-scream/pi-tui';
import type { TUI } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import {
  PULSE_WAVE_CELLS,
  PULSE_WAVE_FRAMES,
  PULSE_WAVE_INTERVAL_MS,
} from '#/tui/constant/rendering';

/** Leading/trailing glyph: U+2588 (Block Elements — guaranteed single-column
 * width). The remaining stage cells render muted middle dots (U+00B7). */
const LEADING_BOX = '■';

/**
 * 8-box flowing pulse-wave loading indicator.
 *
 * A leading box (full primary colour) sweeps across an 8-cell stage, trailed
 * by a dim box, over a row of muted middle dots:
 *   ■ 淡 ■ · · · · · ·  →  ■ ■ 淡 ■ · · · ·  →  … →  (bounce back)
 * (淡 shown here only to mark the trailing box; it renders as primary+dim.)
 *
 * 14-frame ping-pong loop @ 80 ms — the leading edge never teleports, it
 * walks cell by cell.
 *
 * All glyphs are width-safe in terminal fonts (U+2588 Block Elements and
 * U+00B7 Latin-1) — the earlier ■/⬝ mix reflowed the whole line on every
 * frame because U+2B1D is not single-column guaranteed.
 *
 * The component auto-starts on construction. Call `stop()` to tear
 * down the timer chain.
 */
export class PulseWaveLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private ui: TUI;
  private colorHex: string;
  /** Wall-clock time of the last frame advance, for drift-free scheduling. */
  private lastTickAt = 0;
  /** Raw frame text without Text's full-width render padding, exposed so
   * callers can compose the wave inline with trailing content (e.g. the
   * reconnect label in the status bar). */
  private frameText = '';

  /** The current frame's cells ("■ ⬝ ⬝"), unpadded. */
  getFrameText(): string {
    return this.frameText;
  }

  constructor(ui: TUI, colorHex: string) {
    super('', 1, 0);
    this.ui = ui;
    this.colorHex = colorHex;
    this.start();
  }

  start(): void {
    this.lastTickAt = performance.now();
    this.updateDisplay();
    this.scheduleTick(PULSE_WAVE_INTERVAL_MS, PULSE_WAVE_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  dispose(): void {
    this.stop();
  }

  /**
   * setTimeout self-rescheduling chain with drift-free frame advancement and
   * paint-cost backpressure (same pattern as the pi-tui Loader): a slow tick
   * defers the next one by `max(0, interval - cost, cost × 9)` instead of
   * stacking intervals, keeping the wave ≤ ~10% CPU under slow writes.
   */
  private scheduleTick(intervalMs: number, delayMs: number): void {
    const timer = setTimeout(() => {
      if (this.intervalId !== timer) return;
      const startedAt = performance.now();
      const elapsed = startedAt - this.lastTickAt;
      if (elapsed >= intervalMs) {
        const steps = Math.floor(elapsed / intervalMs);
        this.currentFrame = (this.currentFrame + steps) % PULSE_WAVE_FRAMES.length;
        this.lastTickAt += steps * intervalMs;
        this.updateDisplay();
      }
      const frameCostMs = performance.now() - startedAt;
      if (this.intervalId !== timer) return;
      const cadenceDelayMs = Math.max(0, intervalMs - frameCostMs);
      const backpressureDelayMs = frameCostMs * 9;
      this.scheduleTick(intervalMs, Math.max(cadenceDelayMs, backpressureDelayMs));
    }, delayMs);
    this.intervalId = timer;
  }

  setColorHex(colorHex: string): void {
    this.colorHex = colorHex;
    this.updateDisplay();
  }

  private updateDisplay(): void {
    // The frame list is statically generated (non-empty); the fallback is a
    // safety net for out-of-range indices only.
    const step = PULSE_WAVE_FRAMES[this.currentFrame] ?? PULSE_WAVE_FRAMES[0]!;
    const cells = Array.from({ length: PULSE_WAVE_CELLS }, (_, idx) =>
      this.renderCell(idx, step.active, step.forward),
    );
    // Boxes are glued together (no separators) per the approved design.
    this.frameText = cells.join('');
    this.setText(this.frameText);
    // Use a full render so the footer status timer updates in sync with the
    // pulse wave during the 'waiting' phase, when no other render activity is
    // happening. Component-scoped render would skip the footer lines.
    this.ui.requestRender();
  }

  private renderCell(index: number, active: number, forward: boolean): string {
    const distance = forward ? active - index : index - active;
    if (distance === 0) return chalk.hex(this.colorHex)(LEADING_BOX);
    if (distance === 1) return chalk.hex(this.colorHex).dim(LEADING_BOX);
    // Rest of the stage: muted middle dots (Latin-1, width-safe).
    return chalk.dim('·');
  }
}
