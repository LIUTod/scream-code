import chalk from 'chalk';
import { getLocale, t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import {
  displayWidth,
  layoutSidebarGrid,
  SIDEBAR_LABEL_COLS,
  SIDEBAR_MARKER_COLS,
  SIDEBAR_MIN_GAP,
  type SidebarGridRow,
} from '#/tui/utils/display-width';

import {
  SIDEBAR_STATIC_MARKER,
  type SidebarPanel,
  type SidebarPanelContext,
} from '../sidebar-panel';

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

/**
 * Compact token form for narrow sidebars: 2,267,680,102 → `22.7亿` (zh) or
 * `2.3B` (en). Used only when the thousands-separated form cannot fit, so a
 * narrow sidebar keeps every value readable instead of cutting digits.
 */
function formatCompact(n: number): string {
  // The 999.5M / 999.5K (zh: 99.95M / 9.5K) floors keep a mantissa from
  // rounding up into a four-digit "1000K" / "10000万" just below the next
  // unit — that would widen the value column by 1-3 columns for one tick.
  if (getLocale() === 'zh') {
    if (n >= 99_950_000) return `${(n / 100_000_000).toFixed(1)}亿`;
    if (n >= 9_500) return `${Math.round(n / 10_000)}万`;
    return String(n);
  }
  if (n >= 999_500_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** True when the shared grid can show these values at full width: the label
 *  column is fixed across panels, so only the value column decides the fit. */
function gridFits(rows: ReadonlyArray<readonly [string, string]>, width: number): boolean {
  const valueCols = Math.max(0, ...rows.map(([, value]) => displayWidth(value)));
  return (
    SIDEBAR_MARKER_COLS + SIDEBAR_LABEL_COLS + SIDEBAR_MIN_GAP + valueCols <= width
  );
}

// displayWidth/padLabel now live in utils/display-width.ts (shared with the
// Goal panel) so both side panels use the same CJK-aware label alignment.

/**
 * Session summary, live-rendered each frame as a strict two-column table:
 * one field per row, labels sharing a left column, values sharing a right
 * edge. Uptime derives from `startedAt` so it ticks between data updates;
 * every other value comes from the snapshot in getData().
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

    const tokenRows: ReadonlyArray<readonly [string, number]> = [
      [t('sidebar.tokens'), stats.tokensTotal],
      [t('sidebar.tokens_cache_hit'), stats.tokensInputCacheHit],
      [t('sidebar.tokens_cache_miss'), stats.tokensInputCacheMiss],
      [t('sidebar.tokens_output'), stats.tokensOutput],
    ];
    const countRows: Array<[string, string]> = [
      [t('sidebar.uptime'), formatDuration(now - stats.startedAt)],
      [t('sidebar.turns'), formatCount(stats.turns)],
      [t('sidebar.tools'), formatCount(stats.toolCalls)],
      [t('sidebar.calls'), formatCount(stats.apiCalls)],
      [t('sidebar.compacts'), formatCount(stats.compactions)],
    ];
    const withTokens = (compact: boolean): Array<[string, string]> => [
      ...tokenRows.map(
        ([name, n]) => [name, compact ? formatCompact(n) : formatCount(n)] as [string, string],
      ),
      ...countRows,
    ];
    // Thousands separators by default, compact units when they cannot fit.
    // Secondary counters used to be paired two-per-line ("轮次 25 · 工具 124")
    // and values were left-aligned, which is what made the block read ragged.
    const full = withTokens(false);
    const rows: SidebarGridRow[] = (gridFits(full, width) ? full : withTokens(true)).map(
      ([name, reading]) => ({ marker: SIDEBAR_STATIC_MARKER, label: name, value: reading }),
    );
    // Geometry comes from the shared sidebar grid: the same marker and label
    // columns as every other panel, values right-aligned on the inner edge.
    return layoutSidebarGrid(rows, width).map((cell) => `${label(cell.marker)}${label(cell.label)}${' '.repeat(cell.gap)}${value(cell.value ?? '')}`);
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
