import type { Component } from '@earendil-works/pi-tui';
import { Spacer, Text, visibleWidth } from '@earendil-works/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { CronTranscriptData } from '#/tui/types';

export class CronMessageComponent implements Component {
  private readonly spacer = new Spacer(1);
  private readonly title: string;
  private readonly detail: string | undefined;
  private readonly titleColor: string;
  private readonly promptText: Text;
  private readonly bullet: string;
  private readonly bulletWidth: number;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    prompt: string,
    data: CronTranscriptData,
    private readonly colors: ColorPalette,
  ) {
    const missed = data.missedCount !== undefined;
    this.title = missed ? t('cronmsg.missed_reminder') : t('cronmsg.reminder_fired');
    this.detail = cronDetail(data);
    this.titleColor = data.stale === true || missed ? colors.warning : colors.accent;
    this.promptText = new Text(chalk.hex(colors.text)(prompt), 0, 0);
    this.bullet = chalk.hex(this.titleColor).bold(STATUS_BULLET);
    this.bulletWidth = visibleWidth(this.bullet);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.promptText.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const contentWidth = Math.max(1, width - this.bulletWidth);
    const lines: string[] = [];

    for (const line of this.spacer.render(width)) {
      lines.push(line);
    }

    const title = chalk.hex(this.titleColor).bold(this.title);
    lines.push(`${this.bullet}${title}`);

    if (this.detail !== undefined) {
      lines.push(`${' '.repeat(this.bulletWidth)}${chalk.hex(this.colors.textDim)(this.detail)}`);
    }

    const promptLines = this.promptText.render(contentWidth);
    for (const line of promptLines) {
      lines.push(`${' '.repeat(this.bulletWidth)}${line}`);
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function cronDetail(data: CronTranscriptData): string | undefined {
  const parts: string[] = [];
  if (data.cron !== undefined && data.cron.length > 0) parts.push(data.cron);
  if (data.jobId !== undefined && data.jobId.length > 0) parts.push(`job ${data.jobId}`);
  if (data.recurring === false) parts.push(t('cronmsg.one_time'));
  if (data.coalescedCount !== undefined && data.coalescedCount > 1) {
    parts.push(t('cronmsg.coalesced', { count: String(data.coalescedCount) }));
  }
  if (data.missedCount !== undefined) {
    parts.push(t('cronmsg.missed', { count: String(data.missedCount) }));
  }
  if (data.stale === true) parts.push(t('cronmsg.final_delivery'));
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
