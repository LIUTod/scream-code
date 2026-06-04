import type { Component } from '@earendil-works/pi-tui';
import { Spacer, Text, visibleWidth } from '@earendil-works/pi-tui';
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

  constructor(
    prompt: string,
    data: CronTranscriptData,
    private readonly colors: ColorPalette,
  ) {
    const missed = data.missedCount !== undefined;
    this.title = missed ? '错过的定时提醒' : '定时提醒触发';
    this.detail = cronDetail(data);
    this.titleColor = data.stale === true || missed ? colors.warning : colors.accent;
    this.promptText = new Text(chalk.hex(colors.text)(prompt), 0, 0);
  }

  invalidate(): void {
    this.promptText.invalidate();
  }

  render(width: number): string[] {
    const bullet = chalk.hex(this.titleColor).bold(STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, width - bulletWidth);
    const lines: string[] = [];

    for (const line of this.spacer.render(width)) {
      lines.push(line);
    }

    const title = chalk.hex(this.titleColor).bold(this.title);
    lines.push(`${bullet}${title}`);

    if (this.detail !== undefined) {
      lines.push(`${' '.repeat(bulletWidth)}${chalk.hex(this.colors.textDim)(this.detail)}`);
    }

    const promptLines = this.promptText.render(contentWidth);
    for (const line of promptLines) {
      lines.push(`${' '.repeat(bulletWidth)}${line}`);
    }

    return lines;
  }
}

function cronDetail(data: CronTranscriptData): string | undefined {
  const parts: string[] = [];
  if (data.cron !== undefined && data.cron.length > 0) parts.push(data.cron);
  if (data.jobId !== undefined && data.jobId.length > 0) parts.push(`job ${data.jobId}`);
  if (data.recurring === false) parts.push('一次性');
  if (data.coalescedCount !== undefined && data.coalescedCount > 1) {
    parts.push(`${String(data.coalescedCount)} 次合并触发`);
  }
  if (data.missedCount !== undefined) {
    parts.push(`${String(data.missedCount)} 次错过`);
  }
  if (data.stale === true) parts.push('最终投递');
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
