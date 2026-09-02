/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 */

import type { Component, TUI } from '@liutod-scream/pi-tui';
import { Text, truncateToWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { easeSpeedRatio, getSharedSpeedTracker, lerpHex, SPEED_MAX } from '#/tui/utils/speed-tracker';

/** gpt-5 reasoning summaries contain empty HTML comment padding sentinels
 * like `<!-- -->`. Strip them to keep the thinking display clean. */
const EMPTY_COMMENT_RE = /<!--\s*-->/g;

function filterThinkingNoise(text: string): string {
  return text.replace(EMPTY_COMMENT_RE, '');
}

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component {
  private text: string;
  private color: string;
  private readonly dimColor: string;
  private readonly accentColor: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private expanded = false;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSpinnerTickAt = 0;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    text: string,
    colors: ColorPalette,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    // Strip leading newlines so the STATUS_BULLET aligns with the first
    // actual content line, not an empty line from the model's thinking output.
    this.text = text.replace(/^\n+/, '');
    this.color = colors.roleThinking;
    this.dimColor = colors.textDim;
    this.accentColor = colors.primary;
    this.showMarker = showMarker;
    this.mode = mode;
    this.ui = ui;
    this.textComponent = new Text(this.styled(this.text), 0, 0);
    if (mode === 'live') {
      this.startSpinner();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  setText(text: string): void {
    const trimmed = text.replace(/^\n+/, '');
    if (this.text === trimmed) return;
    this.text = trimmed;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.textComponent.setText(this.styled(trimmed));
  }

  private styled(text: string): string {
    return chalk.hex(this.color).italic(filterThinkingNoise(text));
  }

  finalize(): void {
    if (this.mode === 'finalized') return;
    this.mode = 'finalized';
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.stopSpinner();
  }

  dispose(): void {
    // Finalize so the component stops rendering in live mode (spinner +
    // "thinking..." label). Without this, a disposed-but-still-visible
    // component shows a frozen spinner line that looks like a duplicate
    // thinking block when a new one starts (e.g. after a step retry).
    this.finalize();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    // Live mode is intentionally not cached: the spinner frame changes every
    // 80 ms, and returning a stale cached array would freeze the animation.
    if (
      isRenderCacheEnabled() &&
      this.mode === 'finalized' &&
      this.cachedLines !== undefined &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];

    if (this.mode === 'live') {
      const visibleLines =
        contentLines.length > THINKING_PREVIEW_LINES
          ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
          : contentLines;
      const spinner = chalk.hex(this.color)(
        `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
      );
      // Real rate, not clamped — show the actual tok/s so users see true
      // throughput. SPEED_MAX remains the color-gauge reference (rate >= 200
      // shows the full accent color; the number keeps rising past it).
      const rate = getSharedSpeedTracker().getSpeed();
      const rateSuffix = rate > 0.05
        ? chalk.hex(lerpHex(this.dimColor, this.accentColor, easeSpeedRatio(rate / SPEED_MAX)))(
            ` · ${rate.toFixed(1)} toks/s`,
          )
        : '';
      return [
        '',
        spinner + chalk.hex(this.color)(t('thinking.in_progress')) + rateSuffix,
        ...visibleLines.map((line) => MESSAGE_INDENT + line),
      ];
    }

    const rendered: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p = i === 0 && this.showMarker ? chalk.hex(this.color)(STATUS_BULLET) : MESSAGE_INDENT;
      rendered.push(p + contentLines[i]);
    }

    if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES) {
      if (isRenderCacheEnabled()) {
        this.cachedWidth = width;
        this.cachedLines = rendered;
      }
      return rendered;
    }

    // Leading blank + first PREVIEW_LINES content lines + hint line.
    const truncated = rendered.slice(0, 1 + THINKING_PREVIEW_LINES);
    const remaining = contentLines.length - THINKING_PREVIEW_LINES;
    const hint = t('thinking.more_lines', { count: String(remaining) });
    const hintWidth = Math.max(0, width - MESSAGE_INDENT.length);
    truncated.push(
      MESSAGE_INDENT + chalk.dim(truncateToWidth(hint, hintWidth, '…')),
    );
    if (isRenderCacheEnabled()) {
      this.cachedWidth = width;
      this.cachedLines = truncated;
    }
    return truncated;
  }

  /**
   * setTimeout self-rescheduling chain with drift-free frame advancement and
   * paint-cost backpressure (same pattern as the pi-tui Loader): a slow tick
   * defers the next one instead of stacking intervals, keeping the live
   * thinking indicator ≤ ~10% CPU even under slow terminal writes.
   */
  private scheduleSpinnerTick(delayMs: number): void {
    if (this.ui === undefined) return;
    const timer = setTimeout(() => {
      if (this.spinnerTimer !== timer) return;
      const startedAt = performance.now();
      const elapsed = startedAt - this.lastSpinnerTickAt;
      if (elapsed >= BRAILLE_SPINNER_INTERVAL_MS) {
        const steps = Math.floor(elapsed / BRAILLE_SPINNER_INTERVAL_MS);
        this.spinnerFrame = (this.spinnerFrame + steps) % BRAILLE_SPINNER_FRAMES.length;
        this.lastSpinnerTickAt += steps * BRAILLE_SPINNER_INTERVAL_MS;
        this.ui?.requestRender();
      }
      const frameCostMs = performance.now() - startedAt;
      if (this.spinnerTimer !== timer) return;
      const cadenceDelayMs = Math.max(0, BRAILLE_SPINNER_INTERVAL_MS - frameCostMs);
      const backpressureDelayMs = frameCostMs * 9;
      this.scheduleSpinnerTick(Math.max(cadenceDelayMs, backpressureDelayMs));
    }, delayMs);
    this.spinnerTimer = timer;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerTimer !== undefined) return;
    this.lastSpinnerTickAt = performance.now();
    this.scheduleSpinnerTick(BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return;
    clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }
}
