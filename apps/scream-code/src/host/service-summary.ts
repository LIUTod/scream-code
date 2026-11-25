/**
 * What `/service` and `scream service status` show: whether the resident
 * service is installed, whether its host runs and for how long, when it
 * starts, the chat channel and the keep-awake setting.
 */

import { userInfo } from 'node:os';

import { t } from '@scream-code/config';
import { listInbox } from '@scream-code/scream-code-sdk';

import { loadLineConfig } from '#/line/config';
import { getVersion } from '#/cli/version';

import { readHostStatus } from './control';
import { machineHasBattery } from './keep-awake';
import { describeHostCheck, readHostCheck, type HostCheckResult } from './check';
import { readServiceStatus, serviceLauncherFingerprint, type ServiceStatus } from './service';
import { formatTokenLimit } from '#/utils/usage/token-limit';
import { getDataDir } from '#/utils/paths';

import { readHostSettings } from './settings';
import { hostTokensToday } from './usage';

export interface ServiceSummary {
  readonly status: ServiceStatus;
  readonly running: boolean;
  readonly startedAt?: number | undefined;
  /**
   * The build the running host loaded and the build installed on disk. They
   * differ after an upgrade until the host restarts — the reason an upgrade can
   * look like it did nothing. Absent when the running host predates the flag.
   */
  readonly runningVersion?: string | undefined;
  readonly installedVersion?: string | undefined;
  readonly channel: 'feishu' | 'weixin' | undefined;
  readonly keepAwake: boolean;
  /**
   * Whether the machine has a battery, i.e. a lid that can be closed while work
   * runs. `undefined` when it could not be read, so the lid caveat stays hidden
   * rather than describing hardware the person may not have.
   */
  readonly hasBattery?: boolean | undefined;
  readonly tokensToday: number;
  readonly dailyTokenLimit: number;
  /** Items in "waiting for you" (approvals, questions). */
  readonly waiting?: number;
  /**
   * The last check run through the service's current launcher (`scream host
   * check`): whether its own environment reaches the model. Absent when none
   * ran since the launcher was written.
   */
  readonly check?: HostCheckResult | undefined;
}

export async function readServiceSummary(): Promise<ServiceSummary> {
  const [status, host, launcher] = await Promise.all([readServiceStatus(), readHostStatus(), serviceLauncherFingerprint()]);
  const lastCheck = readHostCheck();
  const check = lastCheck !== undefined && launcher !== undefined && lastCheck.launcher === launcher ? lastCheck : undefined;
  let channel: ServiceSummary['channel'];
  try {
    const config = await loadLineConfig();
    channel = config?.feishu !== undefined ? 'feishu' : config?.weixin !== undefined ? 'weixin' : undefined;
  } catch {
    channel = undefined;
  }
  const settings = readHostSettings();
  // Only worth a probe when the lid caveat can actually appear.
  const hasBattery = settings.keepAwake ? await machineHasBattery() : undefined;
  return {
    status,
    running: host.running,
    startedAt: host.startedAt,
    ...(host.version === undefined ? {} : { runningVersion: host.version }),
    installedVersion: getVersion(),
    channel,
    keepAwake: settings.keepAwake,
    ...(hasBattery === undefined ? {} : { hasBattery }),
    tokensToday: hostTokensToday(),
    dailyTokenLimit: settings.dailyTokenLimit,
    waiting: listInbox(getDataDir()).filter((item) => item.status === 'pending' && item.expiresAt > Date.now()).length,
    ...(check === undefined ? {} : { check }),
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

/**
 * The line that names the running build against the installed one, or
 * `undefined` when there is nothing to say.
 *
 * An unstamped host gets a neutral line rather than a guess: it cannot name a
 * build from before the stamp existed, and calling it "old" would be wrong
 * whenever that host is in fact the installed one.
 */
export function staleBuildLine(
  running: { readonly running: boolean; readonly version?: string | undefined },
  installed: string,
): string | undefined {
  if (!running.running) return undefined;
  if (running.version === installed) return undefined;
  return running.version === undefined
    ? t('service.build_unstamped', { installed })
    : t('service.stale_build', { running: running.version, installed });
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
  // An upgraded package does not restart the resident host: it keeps running the
  // build it loaded, and nothing said so — the person upgrades, sees no change,
  // and reports the old bug again.
  if (summary.running && summary.installedVersion !== undefined) {
    const drift = staleBuildLine(
      { running: true, ...(summary.runningVersion === undefined ? {} : { version: summary.runningVersion }) },
      summary.installedVersion,
    );
    if (drift !== undefined) lines.push(drift);
  }
  // Whether the service's own environment reaches the model: the one thing
  // that works in a terminal and silently fails in the background.
  lines.push(summary.check === undefined ? t('service.check_none') : describeHostCheck(summary.check));
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
  // Only where a lid exists: on a desktop the caveat describes hardware the
  // person does not have, and an unreadable machine stays quiet.
  if (summary.keepAwake && summary.hasBattery === true) lines.push(t('service.keep_awake_note'));
  return lines;
}
