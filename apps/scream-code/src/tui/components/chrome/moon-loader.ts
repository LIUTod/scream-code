import { Text } from '@liutod-scream/pi-tui';
import type { TUI } from '@liutod-scream/pi-tui';

import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';

export class MoonLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private ui: TUI;
  private colorFn?: (s: string) => string;
  private label: string;
  /** Wall-clock time of the last frame advance, for drift-free scheduling. */
  private lastTickAt = 0;

  constructor(ui: TUI, colorFn?: (s: string) => string, label: string = '') {
    super('', 1, 0);
    this.ui = ui;
    this.colorFn = colorFn;
    this.label = label;
    this.start();
  }

  start(): void {
    this.lastTickAt = performance.now();
    this.updateDisplay();
    this.scheduleTick(BRAILLE_SPINNER_INTERVAL_MS, BRAILLE_SPINNER_INTERVAL_MS);
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
   * stacking intervals, keeping the spinner ≤ ~10% CPU under slow writes.
   */
  private scheduleTick(intervalMs: number, delayMs: number): void {
    const timer = setTimeout(() => {
      if (this.intervalId !== timer) return;
      const startedAt = performance.now();
      const elapsed = startedAt - this.lastTickAt;
      if (elapsed >= intervalMs) {
        const steps = Math.floor(elapsed / intervalMs);
        this.currentFrame = (this.currentFrame + steps) % BRAILLE_SPINNER_FRAMES.length;
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

  setLabel(label: string): void {
    this.label = label;
    this.updateDisplay();
  }

  setColorFn(colorFn: (s: string) => string): void {
    this.colorFn = colorFn;
    this.updateDisplay();
  }

  private updateDisplay(): void {
    const frame = BRAILLE_SPINNER_FRAMES[this.currentFrame]!;
    const coloredFrame = this.colorFn ? this.colorFn(frame) : frame;
    this.setText(this.label ? `${coloredFrame} ${this.label}` : coloredFrame);
    this.ui.requestRender();
  }
}
