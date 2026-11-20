import { t } from '@scream-code/config';

/**
 * "3 小时前" / "3h ago" for a millisecond timestamp, in the interface
 * language; '' for a missing one. Shared by the welcome panel and the
 * session and memory pickers so they say it the same way.
 */
export function formatRelativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return t('memory.just_now');
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return t('memory.minutes_ago', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('memory.hours_ago', { hours });
  const days = Math.floor(hours / 24);
  return t('memory.days_ago', { days });
}
