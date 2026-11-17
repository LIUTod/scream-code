/**
 * Status bar above the editor: one line holding the work-phase pulse wave, an
 * optional transient label (reconnect text / idle tip) and the collaboration
 * ticker (subagent ↔ main-agent traffic).
 *
 * The row is single-line by contract — the dock reserves exactly one row for it
 * (see LifecycleController.buildLayout) — so every segment is composed into one
 * string and truncated to the available width.
 */

import { Container, Text, truncateToWidth, visibleWidth, type Component } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { PulseWaveLoader } from '../chrome/pulse-wave-loader';

/** One transient chip on the status row (newest of its slot wins). */
export interface StatusChipLine {
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
   * Live scheduled-task reminder (⏰ cron chip). Read on every render like
   * `activity`, and drawn BEFORE it: a fired reminder is time-sensitive, so
   * when the row must truncate it is the collaboration ticker that loses.
   */
  readonly reminder?: () => StatusChipLine | null;
  /**
   * Live collaboration line. Read on every render (not captured at update
   * time), so a new request replaces the previous one without rebuilding the
   * row — the wave animation keeps its phase.
   */
  readonly activity?: () => StatusChipLine | null;
  /**
   * Live MCP server notice (connecting / connected / disabled). Its own slot,
   * so a burst of server statuses can never evict a collaboration notice or a
   * fired reminder; it expires on its own TTL like every other chip here.
   */
  readonly notice?: () => StatusChipLine | null;
}

/** One piece of the status row. Lower `rank` = higher priority; rank 0 (the wave) is never dropped. */
export interface StatusRowPart {
  readonly text: string;
  readonly rank: number;
}

/** Columns a chip needs to be worth showing truncated; below this it is dropped whole. */
const MIN_TRUNCATED_CHIP_COLS = 10;
const STATUS_ROW_SEPARATOR = 2;

/**
 * Compose the row, dropping by priority when it does not fit.
 *
 * The lowest-priority part goes first: it is truncated (single `…`) when it
 * would still keep at least {@link MIN_TRUNCATED_CHIP_COLS} columns, otherwise
 * dropped whole, so a chip never shows up as a bare `...`. Priority: wave
 * (never dropped) > reminder > collaboration ticker > MCP notice > label. The
 * last part standing is clipped by the caller's width truncation instead.
 */
export function fitStatusRow(parts: readonly StatusRowPart[], width: number): string {
  const available = Math.max(1, width - 1); // leading space
  let kept = parts.map((part) => ({ ...part }));
  const total = (): number =>
    kept.reduce((sum, part) => sum + visibleWidth(part.text), 0) +
    Math.max(0, kept.length - 1) * STATUS_ROW_SEPARATOR;
  while (total() > available) {
    const droppable = kept.filter((part) => part.rank > 0);
    if (droppable.length === 0) break;
    const victim = droppable.reduce((worst, part) => (part.rank > worst.rank ? part : worst));
    const room = visibleWidth(victim.text) - (total() - available);
    if (droppable.length > 1 && room < MIN_TRUNCATED_CHIP_COLS) {
      kept = kept.filter((part) => part !== victim);
      continue;
    }
    if (room >= 1) victim.text = truncateToWidth(victim.text, room, '…');
    else kept = kept.filter((part) => part !== victim);
    break;
  }
  return ` ${kept.map((part) => part.text).join('  ')}`;
}

/**
 * Single-line row: `<wave>  <label>  <reminder>  <activity>  <notice>`,
 * empty parts omitted.
 *
 * HStack cannot produce this layout: pi-tui's Text.render pads every line to
 * the full row width, so each child's intrinsic width equals the full width
 * and HStack's shrink distribution pushes later segments far to the right.
 * Composing the line manually from the loader's unpadded frame text keeps the
 * segments adjacent, and it re-reads the frame (and every chip) on every
 * render so the wave keeps animating and the tickers update in place.
 */
class StatusLine implements Component {
  constructor(
    private readonly wave: PulseWaveLoader | undefined,
    private readonly label: string,
    private readonly labelColor: string | undefined,
    private readonly reminder: (() => StatusChipLine | null) | undefined,
    private readonly activity: (() => StatusChipLine | null) | undefined,
    private readonly notice: (() => StatusChipLine | null) | undefined,
    /** Idle rows: an actionable collaboration notice supersedes the rotating
     * tip, which would otherwise eat the whole row and truncate the notice
     * away. Informational MCP notices do NOT collapse the tip — they append
     * after it and yield space first. */
    private readonly labelCollapsesOnChip = false,
  ) {}

  render(width: number): string[] {
    const minWidth = Math.max(1, width);
    const reminder = this.reminder?.() ?? null;
    const activity = this.activity?.() ?? null;
    const notice = this.notice?.() ?? null;
    const showLabel = !(this.labelCollapsesOnChip && (reminder !== null || activity !== null));

    const waveText = this.wave !== undefined ? this.wave.getFrameText() : null;
    const paintChip = (chip: StatusChipLine | null): string | null => {
      if (chip === null) return null;
      return chip.color === undefined ? chip.text : chalk.hex(chip.color)(chip.text);
    };
    const reminderText = paintChip(reminder);
    const activityText = paintChip(activity);
    const noticeText = paintChip(notice);
    let labelText: string | null =
      showLabel && this.label.length > 0
        ? this.labelColor === undefined
          ? this.label
          : chalk.hex(this.labelColor)(this.label)
        : null;

    // Keep display order (wave, label, reminder, activity, notice) but fit by
    // priority — see fitStatusRow.
    const parts: StatusRowPart[] = [];
    if (waveText !== null) parts.push({ text: waveText, rank: 0 });
    if (labelText !== null && labelText.length > 0) parts.push({ text: labelText, rank: 4 });
    if (reminderText !== null) parts.push({ text: reminderText, rank: 1 });
    if (activityText !== null) parts.push({ text: activityText, rank: 2 });
    if (noticeText !== null) parts.push({ text: noticeText, rank: 3 });
    if (parts.length === 0) return [];
    // A bare wave keeps the pre-existing output (no padding).
    if (this.wave !== undefined && parts.length === 1) {
      return [truncateToWidth(parts[0]!.text, minWidth)];
    }
    return [truncateToWidth(fitStatusRow(parts, minWidth), minWidth)];
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
      // The chip getters are live: mounting the row even with an empty label
      // lets a collaboration notice, an MCP server notice or a cron reminder
      // appear while the session sits idle.
      if (
        options.label.length > 0 ||
        options.reminder !== undefined ||
        options.activity !== undefined ||
        options.notice !== undefined
      ) {
        this.addChild(
          new StatusLine(
            undefined,
            options.label,
            options.labelColor,
            options.reminder,
            options.activity,
            options.notice,
            true,
          ),
        );
      }
      return;
    }
    if (options.pulseWave !== undefined) {
      this.addChild(
        new StatusLine(
          options.pulseWave,
          options.label,
          options.labelColor,
          options.reminder,
          options.activity,
          options.notice,
        ),
      );
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
