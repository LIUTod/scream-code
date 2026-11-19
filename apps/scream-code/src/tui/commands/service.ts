/**
 * `/service` — the resident service: turn it on or off, restart it, find its
 * log, and switch "keep awake while work runs".
 *
 * Turning it on installs the background host as a per-user service (a
 * LaunchAgent, a systemd user unit, a logon task): it starts with the login,
 * comes back after a crash, and continues work a terminal handed over or a
 * shutdown cut off. Nothing is installed without the person choosing it here,
 * in `scream service install`, or in the one offer made when a chat channel
 * is first set up.
 */

import { userInfo } from 'node:os';

import { t } from '@scream-code/config';
import { JobStore } from '@scream-code/scream-code-sdk';

import { getHostLogFile } from '#/host/control';
import { installService, restartService, serviceManagerFor, uninstallService } from '#/host/service';
import { addBriefJob, isBriefJob } from '#/line/background-commands';
import { isSelfReviewJob } from '#/host/self-review';
import { enableSelfReview } from './jobs';
import { loadLineConfig } from '#/line/config';
import { loadLastChat } from '#/line/session-driver';
import { getDataDir } from '#/utils/paths';
import { describeServiceStart, readServiceSummary, serviceSummaryLines } from '#/host/service-summary';
import { readHostSettings, writeHostSettings } from '#/host/settings';

import { formatTokenLimit, parseTokenLimit } from '#/utils/usage/token-limit';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { promptTextInput } from './cron';
import type { SlashCommandHost } from './dispatch';

type ServiceChoice =
  | 'enable'
  | 'disable'
  | 'restart'
  | 'logs'
  | 'keep-awake-on'
  | 'keep-awake-off'
  | 'token-limit'
  | 'notify-on'
  | 'notify-off';

export async function handleServiceCommand(host: SlashCommandHost): Promise<void> {
  if (serviceManagerFor() === undefined) {
    host.showStatus(t('service.unsupported', { platform: process.platform }));
    return;
  }
  const summary = await readServiceSummary();
  const lines = serviceSummaryLines(summary);
  // System notifications work with or without the resident service: jobs and
  // handed-over work also run in a background started by the terminal.
  const notifyToggle: ChoiceOption = readHostSettings().desktopNotifications
    ? { value: 'notify-off', label: t('service.toggle_notify_off') }
    : { value: 'notify-on', label: t('service.toggle_notify_on') };
  const options: ChoiceOption[] = summary.status.installed
    ? [
        { value: 'restart', label: t('service.restart') },
        { value: 'logs', label: t('service.logs') },
        summary.keepAwake
          ? { value: 'keep-awake-off', label: t('service.toggle_keep_awake_off') }
          : { value: 'keep-awake-on', label: t('service.toggle_keep_awake_on') },
        notifyToggle,
        { value: 'token-limit', label: t('service.set_token_limit') },
        { value: 'disable', label: t('service.disable'), tone: 'danger' },
      ]
    : [{ value: 'enable', label: t('service.enable', { when: describeServiceStart(summary.status) }) }, notifyToggle];

  const choice = await new Promise<ServiceChoice | undefined>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: lines[0] ?? t('service.title'),
      details: lines.slice(1),
      hint: t('service.hint'),
      options,
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        resolve(value as ServiceChoice);
        host.restoreEditor();
      },
      onCancel: () => {
        resolve(undefined);
        host.restoreEditor();
      },
      onDispose: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
  if (choice === undefined) return;
  await applyServiceChoice(host, choice);
}

async function applyServiceChoice(host: SlashCommandHost, choice: ServiceChoice): Promise<void> {
  switch (choice) {
    case 'enable':
      if (await enableService(host)) await offerBriefOnce(host);
      return;
    case 'disable': {
      const result = await uninstallService();
      host.showStatus(result.ok ? t('service.disabled') : t('service.failed', { error: result.error ?? '' }));
      return;
    }
    case 'restart': {
      const result = await restartService();
      host.showStatus(result.ok ? t('service.restarted') : t('service.failed', { error: result.error ?? '' }));
      return;
    }
    case 'logs':
      host.showStatus(t('service.logs_path', { path: getHostLogFile() }));
      return;
    case 'token-limit': {
      const typed = await promptTextInput(host, t('service.token_limit_title'), {
        subtitle: t('service.token_limit_hint'),
        placeholder: '20m',
      });
      if (typed === undefined) return;
      const parsed = parseTokenLimit(typed);
      if (parsed.kind === 'invalid') {
        host.showError(t('service.token_limit_invalid', { value: typed }));
        return;
      }
      const limit = parsed.kind === 'off' ? 0 : parsed.tokens;
      writeHostSettings({ dailyTokenLimit: limit });
      host.showStatus(
        limit === 0 ? t('service.token_limit_off') : t('service.token_limit_set', { limit: formatTokenLimit(limit) }),
      );
      return;
    }
    case 'notify-on':
    case 'notify-off': {
      const settings = writeHostSettings({ desktopNotifications: choice === 'notify-on' });
      host.showStatus(settings.desktopNotifications ? t('service.notify_on') : t('service.notify_off'));
      return;
    }
    case 'keep-awake-on':
    case 'keep-awake-off': {
      const settings = writeHostSettings({ keepAwake: choice === 'keep-awake-on' });
      host.showStatus(settings.keepAwake ? t('service.keep_awake_on') : t('service.keep_awake_off'));
      return;
    }
  }
}

/** Install and start the service, with a spinner; also used by the one-time offer. */
export async function enableService(host: SlashCommandHost): Promise<boolean> {
  const spinner = host.showProgressSpinner(t('service.enabling'));
  const result = await installService();
  if (!result.ok) {
    spinner.stop({ ok: false, label: t('service.failed', { error: result.error ?? '' }) });
    return false;
  }
  const summary = await readServiceSummary();
  spinner.stop({ ok: true, label: t('service.enabled', { when: describeServiceStart(summary.status) }) });
  if (result.lingerOff === true) host.showStatus(t('service.linger_hint', { user: userInfo().username }));
  return true;
}

/**
 * Offer the resident service once, at a moment it obviously helps (a chat
 * channel was just set up). Does nothing when it is already on or the
 * platform cannot have one.
 */
export async function offerServiceOnce(host: SlashCommandHost): Promise<void> {
  if (serviceManagerFor() === undefined || readHostSettings().serviceOffered) return;
  const summary = await readServiceSummary();
  if (summary.status.installed) return;
  writeHostSettings({ serviceOffered: true });
  const yes = await new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('service.offer_title'),
      details: [t('service.off_detail')],
      options: [
        { value: 'yes', label: t('service.offer_yes') },
        { value: 'no', label: t('service.offer_no') },
      ],
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        resolve(value === 'yes');
        host.restoreEditor();
      },
      onCancel: () => {
        resolve(false);
        host.restoreEditor();
      },
      onDispose: () => {
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
  if (yes && (await enableService(host))) await offerBriefOnce(host);
}

/**
 * Right after the service is turned on, offer the daily brief once: every day
 * at 08:30, what background work did. It goes to the chat the person last
 * wrote from, when there is one; otherwise it is kept in `/jobs` and
 * `scream report`.
 */
async function offerBriefOnce(host: SlashCommandHost): Promise<void> {
  // The brief is a message to the phone: without a chat channel there is
  // nowhere to send it, and the terminal's "while you were away" note covers it.
  const channel = await loadLineConfig().catch(() => undefined);
  if (channel?.feishu === undefined && channel?.weixin === undefined) {
    await offerSelfReview(host, getDataDir());
    return;
  }
  if (readHostSettings().briefOffered) return;
  writeHostSettings({ briefOffered: true });
  const home = getDataDir();
  if (new JobStore(home).list().some(isBriefJob)) return;
  const chat = await loadLastChat().catch(() => undefined);
  const yes = await new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('service.brief_offer_title'),
      details: [chat === undefined ? t('service.brief_offer_local') : t('service.brief_offer_chat')],
      options: [
        { value: 'yes', label: t('service.brief_offer_yes') },
        { value: 'no', label: t('service.offer_no') },
      ],
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        resolve(value === 'yes');
        host.restoreEditor();
      },
      onCancel: () => {
        resolve(false);
        host.restoreEditor();
      },
      onDispose: () => {
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
  if (yes) {
    try {
      await addBriefJob(home, { workDir: host.state.appState.workDir, deliverTo: chat });
      host.showStatus(t('service.brief_on'));
    } catch (error) {
      host.showError(error instanceof Error ? error.message : String(error));
    }
  }
  await offerSelfReview(host, home);
}

/** Then, once, the weekly self-review (it only proposes until the person lets it act). */
async function offerSelfReview(host: SlashCommandHost, home: string): Promise<void> {
  if (new JobStore(home).list().some(isSelfReviewJob)) return;
  const yes = await new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('service.self_review_offer_title'),
      details: [t('jobs.self_review_hint')],
      options: [
        { value: 'yes', label: t('service.self_review_offer_yes') },
        { value: 'no', label: t('service.offer_no') },
      ],
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        resolve(value === 'yes');
        host.restoreEditor();
      },
      onCancel: () => {
        resolve(false);
        host.restoreEditor();
      },
      onDispose: () => {
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
  if (yes) await enableSelfReview(host);
}
