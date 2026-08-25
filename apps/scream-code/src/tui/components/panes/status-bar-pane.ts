import { Container, Text, truncateToWidth, type Component } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { MoonLoader } from '../chrome/moon-loader';
import type { PulseWaveLoader } from '../chrome/pulse-wave-loader';

/**
 * Single-line row: pulse wave immediately followed by its label.
 *
 * HStack cannot produce this layout: pi-tui's Text.render pads every line to
 * the full row width, so each child's intrinsic width equals the full width
 * and HStack's shrink distribution pushes the label far to the right.
 * Composing the line manually from the loader's unpadded frame text keeps
 * the label snug against the wave, and it re-reads the frame on every render
 * so the wave keeps animating.
 */
class PulseWaveLabelRow implements Component {
  constructor(
    private readonly wave: PulseWaveLoader,
    private readonly label: string,
  ) {}

  render(width: number): string[] {
    const line = ` ${this.wave.getFrameText()}  ${this.label}`;
    return [truncateToWidth(line, Math.max(1, width))];
  }

  invalidate(): void {
    this.wave.invalidate();
  }
}

export type StatusBarMode = 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool';

export interface StatusBarPaneOptions {
  readonly mode: StatusBarMode;
  readonly label: string;
  readonly labelColor?: string;
  readonly spinner?: MoonLoader;
  readonly pulseWave?: PulseWaveLoader;
}

/**
 * A fixed one-line status bar shown directly above the input editor: it
 * displays the current work phase (idle / waiting / thinking / composing /
 * tool) with its spinner, pinned to the bottom of the terminal via the dock
 * VStack. Designed to hold more status widgets later — add children to the
 * container when needed.
 */
export class StatusBarPaneComponent extends Container {
  constructor(options: StatusBarPaneOptions) {
    super();
    this.update(options);
  }

  /** Re-renders the bar for a new mode/label. The spinner/pulse are the
   * caller's shared instances (kept alive across mode changes), so this only
   * swaps which children are visible. */
  update(options: StatusBarPaneOptions): void {
    this.clear();
    if (options.mode === 'idle') {
      // Idle normally renders nothing, but the empty-session hint (a static
      // one-line label above the editor) is rendered when provided, dimmed
      // below body-text contrast so it reads as a quiet interactive cue.
      if (options.label.length > 0) {
        const text = options.labelColor !== undefined
          ? chalk.hex(options.labelColor)(options.label)
          : options.label;
        this.addChild(new Text(text, 1, 0));
      }
      return;
    }
    // Pulse wave + optional label sit on one line. Spinner (MoonLoader)
    // carries its own label, so it is mounted alone. A bare label (no
    // spinner/pulse) renders as static text — used while diagnosing
    // animation-render issues.
    if (options.mode === 'waiting' || options.mode === 'tool' || options.mode === 'composing' || options.mode === 'thinking') {
      if (options.pulseWave !== undefined) {
        if (options.label.length > 0) {
          this.addChild(new PulseWaveLabelRow(options.pulseWave, options.label));
        } else {
          this.addChild(options.pulseWave);
        }
        return;
      }
      if (options.spinner !== undefined) {
        this.addChild(options.spinner);
        return;
      }
      if (options.label.length > 0) {
        this.addChild(new Text(options.label, 1, 0));
      }
    }
  }
}
