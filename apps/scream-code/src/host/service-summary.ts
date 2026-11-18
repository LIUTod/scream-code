/**
 * What `/service` and `scream service status` show: whether the resident
 * service is installed, whether its host runs and for how long, when it
 * starts, the chat channel and the keep-awake setting.
 */

import { userInfo } from 'node:os';

import { t } from '@scream-code/config';
import { listInbox } from '@scream-code/scream-code-sdk';

import { loadLineConfig } from '#/line/config';

import { readHostStatus } from './control';
import { readServiceStatus, type ServiceStatus } from './service';
import { formatTokenLimit } from '#/utils/usage/token-limit';
import { getDataDir } from '#/utils/paths';

import { readHostSettings } from './settings';
import { hostTokensToday } from './usage';

export interface ServiceSummary {
  readonly status: ServiceStatus;
  readonly running: boolean;
  readonly startedAt?: number | undefined;
  readonly channel: 'feishu' | 'weixin' | undefined;
  readonly keepAwake: boolean;
  readonly tokensToday: number;
  readonly dailyTokenLimit: number;
  /** Items in "waiting for you" (approvals, questions). */
  readonly waiting?: number;
}

export async function readServiceSummary(): Promise<ServiceSummary> {
  const [status, host] = await Promise.all([readServiceStatus(), readHostStatus()]);
  let channel: ServiceSummary['channel'];
  try {
    const config = await loadLineConfig();
    channel = config?.feishu !== undefined ? 'feishu' : config?.weixin !== undefined ? 'weixin' : undefined;
  } catch {
    channel = undefined;
  }
  return {
    status,
    running: host.running,
    startedAt: host.startedAt,
    channel,
    keepAwake: readHostSettings().keepAwake,
    tokensToday: hostTokensToday(),
    dailyTokenLimit: readHostSettings().dailyTokenLimit,
    waiting: listInbox(getDataDir()).filter((item) => item.status === 'pending' && item.expiresAt > Date.now()).length,
  };
}

/** "starts at login" / "starts at boot" for the platform and its linger state. */
export function describeServiceStart(status: ServiceStatus): string {
  return status.manager === 'systemd' && status.linger === true ? t('service.when_boot') : t('service.when_login');
}

export function formatUptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return t('service.uptime_minutes', { m: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('service.uptime_hours', { h: String(hours), m: String(minutes % 60) });
  return t('service.uptime_days', { d: String(Math.floor(hours / 24)), h: String(hours % 24) });
}

/** The status lines, in the order both surfaces show them. */
export function serviceSummaryLines(summary: ServiceSummary, now: number = Date.now()): string[] {
  const lines: string[] = [];
  if (!summary.status.installed) {
    lines.push(`${t('service.title')}  ${t('service.state_off')}`, t('service.off_detail'));
    return lines;
  }
  const when = describeServiceStart(summary.status);
  lines.push(
    `${t('service.title')}  ${
      summary.running
        ? t('service.state_running', {
            when,
            uptime: formatUptime(summary.startedAt === undefined ? 0 : now - summary.startedAt),
          })
        : t('service.state_stopped', { when })
    }`,
  );
  if (summary.status.manager === 'systemd' && summary.status.linger !== true) {
    lines.push(t('service.linger_hint', { user: userInfo().username }));
  }
  const channel =
    summary.channel === 'feishu' ? 'Feishu' : summary.channel === 'weixin' ? 'WeChat' : t('service.channel_none');
  lines.push(
    (summary.waiting ?? 0) > 0
      ? `${t('service.channel', { channel })} · ${t('service.waiting', { count: String(summary.waiting) })}`
      : t('service.channel', { channel }),
  );
  lines.push(
    summary.dailyTokenLimit > 0
      ? t('service.tokens_limited', {
          used: formatTokenLimit(summary.tokensToday),
          limit: formatTokenLimit(summary.dailyTokenLimit),
        })
      : t('service.tokens_unlimited', { used: formatTokenLimit(summary.tokensToday) }),
  );
  lines.push(summary.keepAwake ? t('service.keep_awake_on') : t('service.keep_awake_off'));
  if (summary.keepAwake && process.platform === 'darwin') lines.push(t('service.keep_awake_note'));
  return lines;
}
