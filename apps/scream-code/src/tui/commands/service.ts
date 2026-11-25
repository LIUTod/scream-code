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

import { getHostLogFile } from '#/host/control';
import { describeHostCheck, type HostCheckResult } from '#/host/check';
import {
  checkServiceEnvironment,
  installService,
  restartService,
  serviceManagerFor,
  uninstallService,
} from '#/host/service';
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
  | 'notify-off'
  | 'check';

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
        { value: 'check', label: t('service.check') },
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
      await enableService(host);
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
    case 'check': {
      const spinner = host.showProgressSpinner(t('host.check.running'));
      const result = await checkServiceEnvironment();
      if (result === undefined) {
        spinner.stop({ ok: false, label: t('service.check_unavailable') });
        return;
      }
      spinner.stop({ ok: result.ok, label: describeHostCheck(result) });
      const note = envModelNote(result);
      if (note !== undefined) host.showStatus(note);
      return;
    }
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
  // Installed is not the same as working: the service runs without this
  // terminal's environment. Say right away when it cannot reach the model.
  if (result.check !== undefined && !result.check.ok) host.showError(describeHostCheck(result.check));
  const note = result.check === undefined ? undefined : envModelNote(result.check);
  if (note !== undefined) host.showStatus(note);
  return true;
}

/**
 * This terminal's model comes from `SCREAM_MODEL_*` variables, which the
 * service does not have: the background then answers with another model (or
 * none). Said once, where the person decides about the service.
 */
function envModelNote(check: HostCheckResult): string | undefined {
  if ((process.env['SCREAM_MODEL_NAME'] ?? '').trim() === '') return undefined;
  return check.ok ? t('service.check_env_model', { model: check.model ?? '' }) : t('service.check_env_model_none');
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
  if (yes) await enableService(host);
}
