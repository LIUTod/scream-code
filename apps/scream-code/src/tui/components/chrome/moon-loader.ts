import { Text } from '@liutod-scream/pi-tui';
import type { TUI } from '@liutod-scream/pi-tui';

import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';

export class MoonLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ui: TUI;
  private colorFn?: (s: string) => string;
  private label: string;

  constructor(ui: TUI, colorFn?: (s: string) => string, label: string = '') {
    super('', 1, 0);
    this.ui = ui;
    this.colorFn = colorFn;
    this.label = label;
    this.start();
  }

  start(): void {
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.updateDisplay();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
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
    this.ui.requestComponentRender(this);
  }
}
