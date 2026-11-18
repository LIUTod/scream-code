import chalk from 'chalk';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import { layoutSidebarGrid, type SidebarGridRow } from '#/tui/utils/display-width';

import { SIDEBAR_STATIC_MARKER, type SidebarJobsData, type SidebarPanel, type SidebarPanelContext } from '../sidebar-panel';

/** How many jobs the panel lists before "N more, see /jobs". */
const MAX_ROWS = 5;

/** "今天 09:00" / "明天 09:00" / "周一 08:00" / "11-25 09:00" (and the English equivalents). */
export function formatNextRun(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days <= 0) return t('sidebar.jobs_today', { time: clock });
  if (days === 1) return t('sidebar.jobs_tomorrow', { time: clock });
  if (days < 7) return t('sidebar.jobs_weekday', { day: t(`sidebar.jobs_day_${String(date.getDay())}`), time: clock });
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/**
 * Background jobs, first in the sidebar and always shown: whether the
 * background runs them, what waits for the person, then each job (last
 * result, name, next run), soonest first. With nothing on and nothing
 * waiting it says so and how to make one.
 */
class JobsPanelContent {
  constructor(
    private readonly ctx: SidebarPanelContext,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const jobs = this.ctx.getData().jobs;
    const dim = (s: string): string => chalk.hex(this.colors.textDim)(s);
    if (jobs === undefined || (jobs.rows.length === 0 && jobs.waiting === 0)) {
      return [dim(`○ ${t('sidebar.jobs_none')}`)];
    }
    const text = (s: string): string => chalk.hex(this.colors.text)(s);
    const warn = (s: string): string => chalk.hex(this.colors.warning)(s);

    const rows: { row: SidebarGridRow; paint: (s: string) => string; markPaint: (s: string) => string }[] = [];
    if (jobs.rows.length > 0) {
      rows.push({
        row: {
          marker: SIDEBAR_STATIC_MARKER,
          label: t('sidebar.jobs_background'),
          value: jobs.hostRunning ? t('sidebar.jobs_running') : t('sidebar.jobs_stopped'),
        },
        paint: jobs.hostRunning ? dim : warn,
        markPaint: jobs.hostRunning ? (s) => chalk.hex(this.colors.success)(s) : warn,
      });
    }
    if (jobs.waiting > 0) {
      rows.push({
        row: { marker: SIDEBAR_STATIC_MARKER, label: t('sidebar.jobs_waiting'), value: t('sidebar.jobs_waiting_value', { count: String(jobs.waiting) }) },
        paint: warn,
        markPaint: warn,
      });
    }
    for (const job of jobs.rows.slice(0, MAX_ROWS)) {
      const mark = job.lastOk === true ? '✓' : job.lastOk === false ? '✗' : '·';
      rows.push({
        row: { marker: mark, label: job.title, value: job.nextRunAt === undefined ? '—' : formatNextRun(job.nextRunAt) },
        paint: dim,
        markPaint:
          job.lastOk === true
            ? (s) => chalk.hex(this.colors.success)(s)
            : job.lastOk === false
              ? (s) => chalk.hex(this.colors.error)(s)
              : dim,
      });
    }
    const cells = layoutSidebarGrid(
      rows.map((entry) => entry.row),
      width,
    );
    const lines = cells.map((cell, index) => {
      const entry = rows[index]!;
      const value = cell.value === undefined ? '' : entry.paint(cell.value);
      return `${entry.markPaint(cell.marker)}${text(cell.label)}${' '.repeat(cell.gap)}${value}`;
    });
    if (jobs.rows.length > MAX_ROWS) {
      lines.push(dim(`  ${t('sidebar.jobs_more', { count: String(jobs.rows.length - MAX_ROWS) })}`));
    }
    return lines;
  }
}

export const jobsPanel: SidebarPanel = {
  id: 'jobs',
  get title() {
    return 'Jobs';
  },
  width: 30,
  build(ctx) {
    return new JobsPanelContent(ctx, ctx.colors);
  },
};

export type { SidebarJobsData };
