/**
 * PlanModeBanner — fixed one-line banner pinned above the editor showing the
 * current plan mode (plan / fusionplan) and the plan file's basename.
 *
 * Replaces the verbose two-line `showNotice(title, '计划将创建于此：' + path)`
 * that used to be appended to the transcript on every shift+tab toggle and
 * stacked up across multiple switches. Renders nothing when plan mode is off.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import type { ColorPalette } from '#/tui/theme/colors';
import type { PlanModeState } from '#/tui/types';

const PLAN_LABEL: Record<Exclude<PlanModeState, 'off'>, string> = {
  plan: '计划模式',
  fusionplan: '融合计划模式',
};

export class PlanModeBannerComponent implements Component {
  private mode: PlanModeState = 'off';
  private planPath: string | undefined;
  private readonly colors: ColorPalette;

  constructor(colors: ColorPalette) {
    this.colors = colors;
  }

  setPlanMode(mode: PlanModeState, planPath?: string): void {
    this.mode = mode;
    this.planPath = planPath;
  }

  /** Update only the mode, preserving the last known plan path. */
  setMode(mode: PlanModeState): void {
    this.mode = mode;
  }

  invalidate(): void {
    // Stateless beyond `mode` / `planPath`; nothing to invalidate.
  }

  render(width: number): string[] {
    if (this.mode === 'off') return [];

    const tone = this.mode === 'fusionplan' ? this.colors.fusionPlanMode : this.colors.planMode;
    const label = PLAN_LABEL[this.mode];
    const prefix = `${chalk.hex(tone)(STATUS_BULLET)}${chalk.hex(tone).bold(label)}`;

    const basename = this.planPath !== undefined && this.planPath.length > 0
      ? path.basename(this.planPath)
      : undefined;
    if (basename === undefined || basename.length === 0) {
      return [truncateToWidth(prefix, width)];
    }

    const sep = chalk.hex(this.colors.textDim)(' · ');
    const linked = path.isAbsolute(this.planPath!)
      ? toTerminalHyperlink(chalk.hex(this.colors.text)(basename), pathToFileURL(this.planPath!).href)
      : chalk.hex(this.colors.text)(basename);

    const line = `${prefix}${sep}${linked}`;
    if (visibleWidth(line) <= width) return [line];

    // Path too long — truncate the basename, keep the label intact.
    const fixedWidth = visibleWidth(prefix) + visibleWidth(sep);
    const budget = Math.max(0, width - fixedWidth);
    if (budget < 4) return [truncateToWidth(prefix, width)];
    const truncated = truncateToWidth(basename, budget, '…');
    return [`${prefix}${sep}${chalk.hex(this.colors.text)(truncated)}`];
  }
}
