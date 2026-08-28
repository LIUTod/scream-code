/**
 * EmbeddingSetupCardComponent — startup card shown when the vector embedding
 * model has not been downloaded yet. Mirrors OnboardingCardComponent's visual
 * language (theme-colored bordered card, warning glyph, highlighted selection)
 * so the two first-run experiences read as siblings. Offers: download now
 * (runs the same manual download flow as the /knowledge menu item) or skip.
 */

import type { Component, Focusable } from '@liutod-scream/pi-tui';
import { Container, matchesKey, Key, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { t } from '@scream-code/config';

export interface EmbeddingSetupCardOptions {
  readonly colors: ColorPalette;
  readonly onDownload: () => void;
  readonly onSkip: () => void;
}

export class EmbeddingSetupCardComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: EmbeddingSetupCardOptions;
  private selectedIndex = 0;
  private activated = false;
  private readonly actions: ReadonlyArray<{ label: string; run: () => void }>;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(opts: EmbeddingSetupCardOptions) {
    super();
    this.opts = opts;
    this.actions = [
      { label: t('kw.setup_download'), run: () => this.opts.onDownload() },
      { label: t('kw.setup_skip'), run: () => this.opts.onSkip() },
    ];
  }

  override invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    // One-shot: after an action fires (or skip), ignore further input so a
    // second Enter during the async download flow can't start it twice.
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

    const cardWidth = Math.max(20, width);
    const innerWidth = cardWidth - 2;

    const borderColor = chalk.hex(colors.primary);
    const descColor = chalk.hex(colors.textDim);
    const accent = chalk.hex(colors.accent);

    const lines: string[] = [];

    lines.push(borderColor('┌' + '─'.repeat(innerWidth) + '┐'));
    lines.push(borderColor('│') + padInner('', innerWidth) + borderColor('│'));
    for (const descLine of wrapText(t('kw.setup_description'), innerWidth)) {
      lines.push(borderColor('│') + padInner(descColor(descLine), innerWidth) + borderColor('│'));
    }
    lines.push(borderColor('│') + padInner('', innerWidth) + borderColor('│'));

    for (let i = 0; i < this.actions.length; i++) {
      const action = this.actions[i];
      const selected = i === this.selectedIndex;
      const label = action === undefined ? '' : action.label;
      const row = selected
        ? accent('▶ ' + label)
        : descColor('  ' + label);
      lines.push(borderColor('│') + padInner(row, innerWidth) + borderColor('│'));
    }

    lines.push(borderColor('│') + padInner('', innerWidth) + borderColor('│'));
    lines.push(borderColor('│') + padInner(descColor(t('kw.setup_hint')), innerWidth) + borderColor('│'));
    lines.push(borderColor('└' + '─'.repeat(innerWidth) + '┘'));

    const truncated = lines.map((line) => truncateToWidth(line, width));
    this.cachedWidth = width;
    this.cachedLines = truncated;
    return truncated;
  }
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
