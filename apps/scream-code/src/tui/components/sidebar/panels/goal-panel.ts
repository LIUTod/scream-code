import chalk from 'chalk';
import { truncateToWidth } from '@liutod-scream/pi-tui';
import { getLocale, t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import type { GoalJudgeState, GoalStatus } from '#/tui/types';
import { layoutSidebarGrid, type SidebarGridRow } from '#/tui/utils/display-width';

import {
  SIDEBAR_STATIC_MARKER,
  type SidebarPanel,
  type SidebarPanelContext,
} from '../sidebar-panel';

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
    // Free text still pays the marker column, so the block's left edge reads the
    // same as every other panel.
    lines.push(truncateToWidth(dim(`${SIDEBAR_STATIC_MARKER} ${goal.objective}`), width));

    const rows: SidebarGridRow[] = [
      { marker: SIDEBAR_STATIC_MARKER, label: t('sidebar.goal_tokens'), value: formatCount(goal.tokensUsed) },
      {
        marker: SIDEBAR_STATIC_MARKER,
        label: t('sidebar.goal_tokens_input'),
        value: goal.inputTokens === null ? '—' : formatCount(goal.inputTokens),
      },
      {
        marker: SIDEBAR_STATIC_MARKER,
        label: t('sidebar.goal_tokens_output'),
        value: goal.outputTokens === null ? '—' : formatCount(goal.outputTokens),
      },
      { marker: SIDEBAR_STATIC_MARKER, label: t('sidebar.goal_turns'), value: String(goal.turnsUsed) },
      { marker: SIDEBAR_STATIC_MARKER, label: t('sidebar.goal_wall'), value: formatWallClock(wallMs) },
      { marker: SIDEBAR_STATIC_MARKER, label: t('sidebar.goal_judge'), value: judgeText(goal.judge) },
    ];
    // Geometry comes from the shared sidebar grid (same marker + label columns as
    // every other panel, values right-aligned on the inner edge). The criterion
    // joins as a free-text row so its label stays inside the grid instead of
    // pushing a value past the shared column.
    const hasCriterion = goal.completionCriterion !== null;
    const gridRows: SidebarGridRow[] = hasCriterion
      ? [
          ...rows,
          {
            marker: SIDEBAR_STATIC_MARKER,
            label: t('sidebar.goal_criterion'),
            note: goal.completionCriterion ?? '',
          },
        ]
      : rows;
    for (const cell of layoutSidebarGrid(gridRows, width)) {
      const reading = cell.value ?? cell.note ?? '';
      lines.push(`${dim(`${cell.marker}${cell.label}`)}${' '.repeat(cell.gap)}${text(reading)}`);
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
