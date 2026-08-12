/**
 * OnboardingCardComponent — a visually clean, centered-at-the-bottom card
 * shown when the TUI starts with no configured model. Offers two actions:
 * configure now (enters the /config connect flow) or skip (stays on welcome).
 *
 * Rendered as a custom component (not ChoicePicker) so the card can look
 * deliberate: theme-colored border, warning glyph, and a highlighted
 * selection instead of a bare list.
 */

import type { Component, Focusable } from '@liutod-scream/pi-tui';
import { Container, matchesKey, Key, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { t } from '@scream-code/config';

export interface OnboardingCardOptions {
  readonly colors: ColorPalette;
  readonly onConfigure: () => void;
  readonly onSkip: () => void;
}

export class OnboardingCardComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: OnboardingCardOptions;
  private selectedIndex = 0;
  private activated = false;
  private readonly actions: ReadonlyArray<{ label: string; run: () => void }>;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(opts: OnboardingCardOptions) {
    super();
    this.opts = opts;
    this.actions = [
      { label: t('onboarding.configure'), run: () => this.opts.onConfigure() },
      { label: t('onboarding.skip'), run: () => this.opts.onSkip() },
    ];
  }

  override invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    // One-shot: after an action fires (or skip), ignore further input so a
    // second Enter during the async /config flow can't start it twice.
    if (this.activated) return;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex + this.actions.length - 1) % this.actions.length;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.activated = true;
      const action = this.actions[this.selectedIndex];
      if (action !== undefined) action.run();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
      this.activated = true;
      this.opts.onSkip();
    }
  }

  override render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const { colors } = this.opts;

    // Card spans the full editor width (left/right aligned to the terminal),
    // so it reads as a deliberate bottom panel rather than a floating chip.
    const cardWidth = Math.max(20, width);
    const innerWidth = cardWidth - 2;
    const leftPad = 0;

    const borderColor = chalk.hex(colors.primary);
    const descColor = chalk.hex(colors.textDim);
    const accent = chalk.hex(colors.accent);

    const lines: string[] = [];

    // Top border.
    lines.push(leftPadText(leftPad, borderColor('┌' + '─'.repeat(innerWidth) + '┐')));

    // Blank separator.
    lines.push(leftPadText(leftPad, borderColor('│') + padInner('', innerWidth) + borderColor('│')));
    // Description lines.
    for (const descLine of wrapText(t('onboarding.description'), innerWidth)) {
      lines.push(leftPadText(leftPad, borderColor('│') + padInner(descColor(descLine), innerWidth) + borderColor('│')));
    }
    lines.push(leftPadText(leftPad, borderColor('│') + padInner('', innerWidth) + borderColor('│')));

    // Actions.
    for (let i = 0; i < this.actions.length; i++) {
      const action = this.actions[i];
      const selected = i === this.selectedIndex;
      const label = action === undefined ? '' : action.label;
      const row = selected
        ? accent('▶ ' + label)
        : descColor('  ' + label);
      lines.push(leftPadText(leftPad, borderColor('│') + padInner(row, innerWidth) + borderColor('│')));
    }

    lines.push(leftPadText(leftPad, borderColor('│') + padInner('', innerWidth) + borderColor('│')));
    // Bottom hint.
    lines.push(leftPadText(leftPad, borderColor('│') + padInner(descColor(t('onboarding.hint')), innerWidth) + borderColor('│')));
    // Bottom border.
    lines.push(leftPadText(leftPad, borderColor('└' + '─'.repeat(innerWidth) + '┘')));

    const truncated = lines.map((line) => truncateToWidth(line, width));
    this.cachedWidth = width;
    this.cachedLines = truncated;
    return truncated;
  }
}

function leftPadText(pad: number, text: string): string {
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

function padInner(text: string, width: number): string {
  const vw = visibleWidth(text);
  return text + ' '.repeat(Math.max(0, width - vw));
}

function wrapText(text: string, width: number): string[] {
  // Greedy wrap by visible width, char by char — handles CJK text naturally
  // (no word-boundary splitting that would break mid-CJK).
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const ch of text) {
    const chWidth = visibleWidth(ch);
    if (currentWidth + chWidth > width && currentWidth > 0) {
      lines.push(current);
      current = ch;
      currentWidth = chWidth;
    } else {
      current += ch;
      currentWidth += chWidth;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
