/**
 * Status bar above the editor: one line holding the work-phase pulse wave, an
 * optional transient label (reconnect text / idle tip) and the collaboration
 * ticker (subagent ↔ main-agent traffic).
 *
 * The row is single-line by contract — the dock reserves exactly one row for it
 * (see LifecycleController.buildLayout) — so every segment is composed into one
 * string and truncated to the available width.
 */

import { Container, Text, truncateToWidth, type Component } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { PulseWaveLoader } from '../chrome/pulse-wave-loader';

/** Transient collaboration line drawn after the wave (one slot, newest wins). */
export interface CollabActivityLine {
  readonly text: string;
  readonly color?: string;
}

export type StatusBarMode = 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool';

export interface StatusBarPaneOptions {
  readonly mode: StatusBarMode;
  /** Reconnect text or idle tip. Styled by the caller unless `labelColor` is set. */
  readonly label: string;
  /** Colour applied to `label` for the idle tip (theme-independent grey). */
  readonly labelColor?: string;
  readonly pulseWave?: PulseWaveLoader;
  /**
   * Live collaboration line. Read on every render (not captured at update
   * time), so a new request replaces the previous one without rebuilding the
   * row — the wave animation keeps its phase.
   */
  readonly activity?: () => CollabActivityLine | null;
}

/**
 * Single-line row: `<wave>  <label>  <activity>`, empty parts omitted.
 *
 * HStack cannot produce this layout: pi-tui's Text.render pads every line to
 * the full row width, so each child's intrinsic width equals the full width
 * and HStack's shrink distribution pushes later segments far to the right.
 * Composing the line manually from the loader's unpadded frame text keeps the
 * segments adjacent, and it re-reads the frame (and the activity) on every
 * render so the wave keeps animating and the ticker updates in place.
 */
class StatusLine implements Component {
  constructor(
    private readonly wave: PulseWaveLoader | undefined,
    private readonly label: string,
    private readonly activity: (() => CollabActivityLine | null) | undefined,
    private readonly labelColor: string | undefined,
    /** Idle rows: a live notice supersedes the rotating tip, which would
     * otherwise eat the whole row and truncate the notice away. */
    private readonly labelCollapsesOnActivity = false,
  ) {}

  render(width: number): string[] {
    const minWidth = Math.max(1, width);
    const activity = this.activity?.() ?? null;
    const showLabel = !(this.labelCollapsesOnActivity && activity !== null);
    const segments: string[] = [];
    if (this.wave !== undefined) segments.push(this.wave.getFrameText());
    if (showLabel && this.label.length > 0) {
      segments.push(this.labelColor === undefined ? this.label : chalk.hex(this.labelColor)(this.label));
    }
    if (activity !== null) {
      segments.push(activity.color === undefined ? activity.text : chalk.hex(activity.color)(activity.text));
    }
    if (segments.length === 0) return [];
    // A bare wave keeps the pre-existing output (no padding).
    if (this.wave !== undefined && segments.length === 1) {
      return [truncateToWidth(segments[0]!, minWidth)];
    }
    return [truncateToWidth(` ${segments.join('  ')}`, minWidth)];
  }

  invalidate(): void {
    this.wave?.invalidate();
  }
}

/**
 * Fixed one-line status bar shown directly above the editor: the work phase
 * (waiting / thinking / composing / tool) with its pulse wave, the reconnect
 * label, and the collaboration ticker. Idle shows the empty-session hint (or
 * the ticker alone, when one is live).
 *
 * Holds no timers: the wave instance is created and stopped by
 * LifecycleController, which recreates this component only when the phase
 * changes.
 */
export class StatusBarPaneComponent extends Container {
  constructor(options: StatusBarPaneOptions) {
    super();
    this.update(options);
  }

  /** Re-renders the bar for a new mode/label. The wave is the caller's
   * instance (kept alive across label changes), so this only swaps the row. */
  update(options: StatusBarPaneOptions): void {
    this.clear();
    if (options.mode === 'idle') {
      // The activity getter is live: mounting the row even with an empty label
      // lets a collaboration notice appear while the session sits idle.
      if (options.label.length > 0 || options.activity !== undefined) {
        this.addChild(new StatusLine(undefined, options.label, options.activity, options.labelColor, true));
      }
      return;
    }
    if (options.pulseWave !== undefined) {
      this.addChild(new StatusLine(options.pulseWave, options.label, options.activity, undefined));
      return;
    }
    // Compatibility: a bare label (no wave) still renders as static text —
    // used while diagnosing animation-render issues.
    if (options.label.length > 0) {
      const text = options.labelColor !== undefined
        ? chalk.hex(options.labelColor)(options.label)
        : options.label;
      this.addChild(new Text(text, 1, 0));
    }
  }
}
