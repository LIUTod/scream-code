import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { GoalSnapshotData } from '@scream-cli/agent-core';
import chalk from 'chalk';

import { formatTokenCount } from '#/utils/usage/usage-format';
import { UsagePanelComponent } from './usage-panel';

const WRAP_WIDTH = 72;
const MAX_OBJECTIVE_LINES = 6;
const MAX_CRITERION_LINES = 3;
const LABEL_WIDTH = 11;

export function formatGoalElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.replaceAll(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  if (lines.length === 0) return [''];
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = `${clipped[maxLines - 1]!.slice(0, Math.max(0, width - 1))}…`;
  return clipped;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return '#7aa2f7';
    case 'complete':
      return '#9ece6a';
    case 'blocked':
      return '#e0af68';
    case 'paused':
      return '#565f89';
    default:
      return '#565f89';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'active':
      return '▶ 运行中';
    case 'complete':
      return '✅ 已完成';
    case 'blocked':
      return '🚫 已阻塞';
    case 'paused':
      return '⏸ 已暂停';
    default:
      return status;
  }
}

export function buildGoalReportLines(goal: GoalSnapshotData, colors: { primary: string; text: string; textDim: string }): string[] {
  const accent = chalk.hex(statusColor(goal.status));
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);

  const lines: string[] = [];

  // Objective as blockquote
  for (const line of wrap(goal.objective, WRAP_WIDTH, MAX_OBJECTIVE_LINES)) {
    lines.push(`${accent('▌')} ${value(line)}`);
  }
  // Completion criterion
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(`✓ ${goal.completionCriterion}`, WRAP_WIDTH, MAX_CRITERION_LINES)) {
      lines.push(`${accent('▌')} ${muted(line)}`);
    }
  }
  lines.push('');

  const row = (label: string, val: string): string => `${muted(label.padEnd(LABEL_WIDTH))}${val}`;

  // Status row for terminal states
  const isTerminal = goal.status === 'complete' || goal.status === 'blocked' || goal.status === 'paused';
  if (isTerminal) {
    const statusText = accent(statusLabel(goal.status));
    const reason = goal.terminalReason !== undefined ? muted(` — ${goal.terminalReason}`) : '';
    lines.push(row('Status', statusText + reason));
  }

  lines.push(row('Running', value(formatGoalElapsed(goal.wallClockMs))));
  lines.push(row('Turns', value(`${goal.turnsUsed}`)));
  lines.push(row('Tokens', value(formatTokenCount(goal.tokensUsed))));

  // Stop condition
  if (goal.status !== 'complete') {
    const parts: string[] = [];
    if (goal.budget.turnBudget !== null) {
      parts.push(`after ${goal.budget.turnBudget} turns (${goal.turnsUsed}/${goal.budget.turnBudget})`);
    }
    if (goal.budget.tokenBudget !== null) {
      parts.push(`at ${formatTokenCount(goal.budget.tokenBudget)} tokens`);
    }
    if (goal.budget.wallClockBudgetMs !== null) {
      parts.push(`after ${formatGoalElapsed(goal.budget.wallClockBudgetMs)}`);
    }
    if (parts.length > 0) {
      lines.push(row('Stop', value(parts.join(', '))));
    } else {
      lines.push(muted('  No stop condition — runs until evaluated complete.'));
    }
  }

  return lines;
}

function buildEmptyGoalLines(colors: { text: string; textDim: string }): string[] {
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  return [
    value('未开启任务'),
    '',
    `${muted('/goal')} ${value('<目标描述>')}   ${muted('创建并启动目标')}`,
    `${muted('/goal pause')}       ${muted('暂停当前目标')}`,
    `${muted('/goal resume')}      ${muted('恢复已暂停的目标')}`,
    `${muted('/goaloff')}          ${muted('取消当前目标')}`,
  ];
}

export class GoalStatusMessageComponent implements Component {
  private readonly panel: UsagePanelComponent;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly goal: GoalSnapshotData | null,
    private readonly colors: { primary: string; text: string; textDim: string; success: string },
  ) {
    if (goal === null) {
      this.panel = new UsagePanelComponent(
        buildEmptyGoalLines(this.colors),
        this.colors.success,
        ' Scream Goal ',
      );
    } else {
      const title = ` Scream Goal · ${statusLabel(goal.status)} `;
      this.panel = new UsagePanelComponent(
        buildGoalReportLines(goal, this.colors),
        this.colors.success,
        title,
      );
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.panel.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = ['', ...this.panel.render(width)];
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
