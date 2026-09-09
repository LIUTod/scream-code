import chalk from 'chalk';
import { truncateToWidth } from '@liutod-scream/pi-tui';
import { getLocale, t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import { displayWidth, padLabel } from '#/tui/utils/display-width';

import type { SidebarPanel, SidebarPanelContext } from '../sidebar-panel';

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const zh = getLocale() === 'zh';
  if (zh) {
    if (totalSeconds < 60) return `${totalSeconds}秒`;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return hours > 0 ? `${hours}小时${minutes}分` : `${minutes}分钟`;
  }
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** 1,234 → "1,234" via the platform locale grouping. */
function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

// displayWidth/padLabel now live in utils/display-width.ts (shared with the
// Goal panel) so both side panels use the same CJK-aware label alignment.

/**
 * Session summary, live-rendered each frame: total token consumption and
 * total working time as the primary rows, turn/tool/message/compaction
 * counters as the secondary row. Uptime derives from `startedAt` so it ticks
 * between data updates; counts come from the snapshot in getData().
 */
class SessionPanelContent {
  constructor(
    private readonly ctx: SidebarPanelContext,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const stats = this.ctx.getData().sessionStats;
    if (stats === undefined) {
      return [chalk.hex(this.colors.textDim)(t('sidebar.session_empty'))];
    }
    const label = (s: string): string => chalk.hex(this.colors.textDim)(s);
    const value = (s: string): string => chalk.hex(this.colors.text)(s);
    const now = Date.now();

    const rows: Array<[string, string]> = [
      [t('sidebar.tokens'), formatCount(stats.tokensTotal)],
      [t('sidebar.tokens_cache_hit'), formatCount(stats.tokensInputCacheHit)],
      [t('sidebar.tokens_cache_miss'), formatCount(stats.tokensInputCacheMiss)],
      [t('sidebar.tokens_output'), formatCount(stats.tokensOutput)],
      [t('sidebar.uptime'), formatDuration(now - stats.startedAt)],
    ];
    // Align values on one column: pad labels to the widest label's width.
    const maxCols = Math.max(...rows.map(([k]) => displayWidth(k)));
    const lines: string[] = [];
    for (const [k, v] of rows) {
      lines.push(label(padLabel(k, maxCols)) + value(v));
    }
    // Secondary counters split into two lines so nothing gets folded at the
    // default 30-column sidebar width.
    lines.push(
      truncateToWidth(
        chalk.hex(this.colors.textDim)(
          `${t('sidebar.turns')} ${stats.turns} · ${t('sidebar.tools')} ${stats.toolCalls}`,
        ),
        width,
      ),
    );
    lines.push(
      truncateToWidth(
        chalk.hex(this.colors.textDim)(
          `${t('sidebar.messages')} ${formatCount(stats.messages)} · ${t('sidebar.compacts')} ${stats.compactions}`,
        ),
        width,
      ),
    );
    return lines;
  }
}

export const sessionPanel: SidebarPanel = {
  id: 'session',
  get title() {
    return t('sidebar.session');
  },
  width: 30,
  build(ctx) {
    return new SessionPanelContent(ctx, ctx.colors);
  },
};
