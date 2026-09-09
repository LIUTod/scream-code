import chalk from 'chalk';
import { truncateToWidth } from '@liutod-scream/pi-tui';
import { getLocale, t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { GoalJudgeState, GoalStatus } from '#/tui/types';
import { displayWidth, padLabel } from '#/tui/utils/display-width';

import type { SidebarPanel, SidebarPanelContext } from '../sidebar-panel';

function formatWallClock(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (getLocale() === 'zh') {
    return hours > 0 ? `${hours}小时${minutes}分` : `${minutes}分钟`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function judgeText(state: GoalJudgeState): string {
  switch (state) {
    case 'judging':
      return t('sidebar.goal_judge_judging');
    case 'adjudicated':
      return t('sidebar.goal_judge_adjudicated');
    case 'awaiting':
      return t('sidebar.goal_judge_awaiting');
  }
}

/**
 * Goal status panel, always visible: state badge (in-progress / completed /
 * paused / blocked / judging), objective, then the same two-column metric
 * layout as the Session panel (tokens spent / turns / wall-clock / judge),
 * and the completion criterion line.
 */
class GoalPanelContent {
  constructor(
    private readonly ctx: SidebarPanelContext,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const goal = this.ctx.getData().goal;
    // Always-visible panel: without a goal snapshot show a resting placeholder.
    if (goal === undefined) {
      return [chalk.hex(this.colors.textDim)('○ ' + t('sidebar.goal_idle'))];
    }
    const dim = (s: string): string => chalk.hex(this.colors.textDim)(s);
    const text = (s: string): string => chalk.hex(this.colors.text)(s);
    const now = Date.now();
    // Live wall-clock: only accumulate while the goal is active — agent-core
    // freezes wallClockMs for paused/blocked/complete, so adding elapsed for
    // those states would make the line grow forever.
    const wallMs =
      goal.status === 'active'
        ? goal.wallClockMs + Math.max(0, now - goal.wallClockBaseAt)
        : goal.wallClockMs;

    const lines: string[] = [];
    lines.push(this.renderBadge(goal.status, goal.judge, dim));
    lines.push(truncateToWidth(dim(goal.objective), width));

    const rows: Array<[string, string]> = [
      [t('sidebar.goal_tokens'), formatCount(goal.tokensUsed)],
      [
        t('sidebar.goal_tokens_input'),
        goal.inputTokens === null ? '—' : formatCount(goal.inputTokens),
      ],
      [
        t('sidebar.goal_tokens_output'),
        goal.outputTokens === null ? '—' : formatCount(goal.outputTokens),
      ],
      [t('sidebar.goal_turns'), String(goal.turnsUsed)],
      [t('sidebar.goal_wall'), formatWallClock(wallMs)],
      [t('sidebar.goal_judge'), judgeText(goal.judge)],
    ];
    // Align values on one column: pad labels to the widest label's width.
    const maxCols = Math.max(...rows.map(([k]) => displayWidth(k)));
    for (const [label, value] of rows) {
      lines.push(dim(padLabel(label, maxCols)) + text(value));
    }

    if (goal.completionCriterion !== null) {
      lines.push(
        dim(padLabel(t('sidebar.goal_criterion'), maxCols)) +
          truncateToWidth(text(goal.completionCriterion), Math.max(4, width - maxCols)),
      );
    }
    return lines;
  }

  /** State badge: judging wins over everything; otherwise map the snapshot
   *  status 1:1 (paused is NOT completed — fixes the interrupted-goal bug). */
  private renderBadge(status: GoalStatus, judge: GoalJudgeState, dim: (s: string) => string): string {
    if (judge === 'judging') {
      return chalk.hex(this.colors.accent)('⚖') + dim(' ' + t('sidebar.goal_judging'));
    }
    switch (status) {
      case 'active':
        return chalk.hex(this.colors.primary)('●') + dim(' ' + t('sidebar.goal_active'));
      case 'complete':
        return chalk.hex(this.colors.success)('✓') + dim(' ' + t('sidebar.goal_completed'));
      case 'paused':
        return chalk.hex(this.colors.warning)('⏸') + dim(' ' + t('sidebar.goal_paused'));
      case 'blocked':
        return chalk.hex(this.colors.warning)('⚠') + dim(' ' + t('sidebar.goal_blocked'));
      default: {
        const exhaustive: never = status;
        void exhaustive;
        return dim(String(status));
      }
    }
  }
}

export const goalPanel: SidebarPanel = {
  id: 'goal',
  get title() {
    return t('sidebar.goal');
  },
  width: 32,
  // Always visible (resting placeholder when no goal snapshot exists).
  build(ctx) {
    return new GoalPanelContent(ctx, ctx.colors);
  },
};
