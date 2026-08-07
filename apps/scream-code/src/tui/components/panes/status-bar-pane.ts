import { Container, HStack, Text, type Component } from '@liutod-scream/pi-tui';

import type { MoonLoader } from '../chrome/moon-loader';
import type { PulseWaveLoader } from '../chrome/pulse-wave-loader';

export type StatusBarMode = 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool';

export interface StatusBarPaneOptions {
  readonly mode: StatusBarMode;
  readonly label: string;
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
      return;
    }
    // Pulse wave + optional label sit on one line via HStack (Container
    // stacks vertically). Spinner (MoonLoader) carries its own label, so it
    // is mounted alone. A bare label (no spinner/pulse) renders as static
    // text — used while diagnosing animation-render issues.
    if (options.mode === 'waiting' || options.mode === 'tool' || options.mode === 'composing' || options.mode === 'thinking') {
      if (options.pulseWave !== undefined) {
        if (options.label.length > 0) {
          const row = new HStack();
          row.addChild(options.pulseWave);
          row.addChild(new Text(` ${options.label}`, 1, 0));
          this.addChild(row);
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
