import type { Component, TUI } from '@liutod-scream/pi-tui';
import { Text, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS, MESSAGE_INDENT } from '#/tui/constant/rendering';
import { DONE_MARK, FAILURE_MARK } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';

/** Bullet and coloured headline/detail pair of one background task notice. */
export interface BackgroundStatusView {
  readonly bullet: string;
  readonly text: string;
}

/**
 * Builds the bullet + text of a background task notice. Shared by the standalone
 * card and the activity block row so a notice looks the same in both places.
 */
export function renderBackgroundStatus(
  data: BackgroundAgentStatusData,
  colors: ColorPalette,
  /**
   * Cells the caller can spend on the text. Passing it keeps a block row at one
   * line: the notice is clipped instead of wrapping. Omit it for the standalone
   * card, which is allowed to wrap like every other message.
   */
  maxCells?: number,
  /**
   * Frame of `BRAILLE_SPINNER_FRAMES` to draw for a notice that is still running.
   * The activity block passes its own frame so the row matches the header it sits
   * under; the standalone card advances its own.
   */
  frameIndex = 0,
): BackgroundStatusView {
  const tone =
    data.phase === 'started'
      ? colors.primary
      : data.phase === 'completed'
        ? colors.success
        : colors.error;

  const bullet =
    data.phase === 'completed'
      ? chalk.hex(colors.success)(DONE_MARK)
      : data.phase === 'failed'
        ? chalk.hex(colors.error)(FAILURE_MARK)
        : // Running, like any tool row: the same spinner glyph, drawn at the
          // caller's frame instead of a frozen first frame.
          chalk.hex(colors.textDim)(
            `${BRAILLE_SPINNER_FRAMES[frameIndex] ?? BRAILLE_SPINNER_FRAMES[0] ?? '⠋'} `,
          );

  const hasDetail = data.detail !== undefined && data.detail.length > 0;
  const plain = hasDetail ? `${data.headline} (${data.detail ?? ''})` : data.headline;
  if (maxCells !== undefined && visibleWidth(plain) > maxCells) {
    // Clipped: colouring headline and detail separately no longer matches what
    // is left of the text, so the row keeps the phase tone only.
    return { bullet, text: chalk.hex(tone)(truncateToWidth(plain, maxCells, '…')) };
  }
  const text =
    chalk.hex(tone)(data.headline) +
    (hasDetail ? chalk.hex(colors.textDim)(` (${data.detail ?? ''})`) : '');
  return { bullet, text };
}

export class BackgroundAgentStatusComponent implements Component {
  private readonly textComponent: Text;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSpinnerTickAt = 0;
  /** Only a notice that is still running animates; a finished one is static. */
  private live: boolean;

  constructor(
    private readonly data: BackgroundAgentStatusData,
    private readonly colors: ColorPalette,
    private readonly ui?: TUI,
  ) {
    this.textComponent = new Text(renderBackgroundStatus(data, colors).text, 0, 0);
    this.live = data.phase === 'started' && ui !== undefined;
    if (this.live) this.startSpinner();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.stopSpinner();
  }

  /**
   * The task this card announced is over: stop the ticker and fall back to the
   * first frame, then let the cache answer again. Without the reset a settled
   * card would keep whatever frame it froze on, which reads as a stuck spinner.
   */
  settle(): void {
    this.stopSpinner();
    this.live = false;
    if (this.spinnerFrame === 0) return;
    this.spinnerFrame = 0;
    this.invalidate();
  }

  render(width: number): string[] {
    // A live notice is never served from cache: its glyph advances every
    // BRAILLE_SPINNER_INTERVAL_MS and a stale array would freeze the animation.
    if (!this.live && this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const view = renderBackgroundStatus(this.data, this.colors, undefined, this.spinnerFrame);
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.textComponent.render(contentWidth);
    const lines = [
      '',
      ...contentLines.map((line, index) => (index === 0 ? view.bullet : MESSAGE_INDENT) + line),
    ];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private startSpinner(): void {
    if (this.spinnerTimer !== undefined) return;
    this.lastSpinnerTickAt = performance.now();
    this.scheduleSpinnerTick(BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return;
    clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

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
        this.invalidate();
        this.ui?.requestRender();
      }
      const frameCostMs = performance.now() - startedAt;
      if (this.spinnerTimer !== timer) return;
      // Same cadence as the activity block: keep the 80 ms beat, but give up the
      // frame instead of piling up timers when a repaint is slower than the beat.
      const cadenceDelayMs = Math.max(0, BRAILLE_SPINNER_INTERVAL_MS - frameCostMs);
      this.scheduleSpinnerTick(Math.max(cadenceDelayMs, frameCostMs * 9));
    }, delayMs);
    this.spinnerTimer = timer;
  }
}
