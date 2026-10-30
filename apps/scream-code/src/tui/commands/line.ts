/**
 * /line slash command — native IM channel wizards (Feishu/Lark & WeChat) +
 * line daemon lifecycle.
 *
 * Choice picker + confirm + spinner manage scream's own line daemon,
 * configured through `~/.scream-code/line/config.json`.
 */

import { t } from '@scream-code/config';

import {
  LineConfigError,
  getLineConfigPath,
  loadLineConfig,
  removeLineDir,
  resolveWeixinOptions,
  saveLineConfig,
  type FeishuPlatformConfig,
  type LineConfig,
  type WeixinPlatformConfig,
} from '#/line/config';
import { readLineDaemonStatus, startLineDaemonDetached, stopLineDaemon } from '#/line/pidfile';
import { validateFeishuCredentials } from '#/line/feishu/client';
import { validateWeixinToken } from '#/line/weixin/client';
import { beginWeixinQRLogin, pollWeixinQRStatus, WeixinLoginError } from '#/line/weixin/qrcode';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

// ─── Entry ────────────────────────────────────────────────────────────────

export async function handleLineCommand(host: SlashCommandHost): Promise<void> {
  let config: LineConfig | null;
  try {
    config = await loadLineConfig();
  } catch (error) {
    if (error instanceof LineConfigError) {
      host.showNotice(t('line.config_broken'), error.message);
      return;
    }
    throw error;
  }
  const status = await readLineDaemonStatus();
  const stateLabel = status.running
    ? t('line.state_running', { pid: `${status.pid ?? '?'}` })
    : t('line.state_stopped');

  const options: ChoiceOption[] = [
    { value: 'wizard-feishu', label: t('line.opt_wizard'), description: t('line.opt_wizard_desc') },
    { value: 'wizard-weixin', label: t('line.opt_wizard_weixin'), description: t('line.opt_wizard_weixin_desc') },
    { value: 'start', label: t('common.start'), description: t('line.opt_start_desc') },
    { value: 'stop', label: t('common.stop'), description: t('line.opt_stop_desc') },
    { value: 'restart', label: t('common.restart'), description: t('line.opt_restart_desc') },
    {
      value: 'uninstall',
      label: t('line.opt_uninstall'),
      description: t('line.opt_uninstall_desc'),
      tone: 'danger',
    },
  ];

  const picker = new ChoicePickerComponent({
    title: `${t('line.title')}（${stateLabel}）`,
    hint: t('line.picker_hint'),
    options,
    colors: host.state.theme.colors,
    onSelect: (value) => {
      host.restoreEditor();
      switch (value) {
        case 'wizard-feishu':
          void runWizard(host, 'feishu', config);
          return;
        case 'wizard-weixin':
          void runWizard(host, 'weixin', config);
          return;
        case 'start':
          void doStart(host);
          return;
        case 'stop':
          void doStop(host);
          return;
        case 'restart':
          void doRestart(host);
          return;
        case 'uninstall':
          void doUninstall(host);
          return;
      }
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

/** Single-channel invariant helper: is `kind` blocked by the other platform? */
export function isChannelTaken(config: LineConfig | null, kind: LinePlatformKind): boolean {
  if (config === null) return false;
  if (kind === 'feishu') return config.weixin !== undefined;
  return config.feishu !== undefined;
}

// ─── Wizard ───────────────────────────────────────────────────────────────

type LinePlatformKind = 'feishu' | 'weixin';

async function runWizard(host: SlashCommandHost, platform: LinePlatformKind, config: LineConfig | null): Promise<void> {
  // Single-channel invariant: the other platform blocks this wizard.
  if (isChannelTaken(config, platform)) {
    const taken = platform === 'feishu' ? t('line.channel_weixin') : t('line.channel_feishu');
    host.showNotice(t('line.platform_taken'), t('line.platform_taken_detail', { taken }));
    return;
  }
  if (platform === 'weixin') {
    await runWeixinWizard(host);
    return;
  }
  await runFeishuWizard(host);
}

async function runFeishuWizard(host: SlashCommandHost): Promise<void> {
  const options: ChoiceOption[] = [
    { value: 'guided', label: t('line.opt_guided'), description: t('line.opt_guided_desc') },
    { value: 'manual', label: t('line.opt_manual'), description: t('line.opt_manual_desc') },
    { value: 'tutorial', label: t('line.opt_tutorial'), description: t('line.opt_tutorial_desc') },
  ];

  const picker = new ChoicePickerComponent({
    title: t('line.wizard_title'),
    hint: t('line.wizard_hint'),
    options,
    colors: host.state.theme.colors,
    onSelect: (value) => {
      host.restoreEditor();
      if (value === 'tutorial') {
        host.showNotice(t('line.tutorial_title'), t('line.tutorial'));
        return;
      }
      if (value === 'guided') {
        void runFeishuGuidedSetup(host, 0);
        return;
      }
      void collectFeishuCredentials(host);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

// ─── Feishu guided setup (step-by-step, self-contained) ───────────────────

const FEISHU_GUIDED_STEPS = [
  'line.fs_step1',
  'line.fs_step2',
  'line.fs_step3',
  'line.fs_step4',
  'line.fs_step5',
  'line.fs_step6',
] as const;

function runFeishuGuidedSetup(host: SlashCommandHost, step: number): void {
  const total = FEISHU_GUIDED_STEPS.length;
  if (step >= total) {
    void collectFeishuCredentials(host);
    return;
  }
  host.showNotice(t('line.fs_wizard_title'), t(FEISHU_GUIDED_STEPS[step] as string));
  const isLast = step === total - 1;
  const options: ChoiceOption[] = isLast
    ? [{ value: 'credentials', label: t('line.fs_goto_credentials') }]
    : [{ value: 'next', label: t('line.fs_next') }];
  const picker = new ChoicePickerComponent({
    title: t('line.fs_step_title', { n: `${step + 1}`, total: `${total}` }),
    hint: t('line.fs_later'),
    options,
    colors: host.state.theme.colors,
    onSelect: (value) => {
      host.restoreEditor();
      if (value === 'credentials') {
        void collectFeishuCredentials(host);
        return;
      }
      runFeishuGuidedSetup(host, step + 1);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

async function collectFeishuCredentials(host: SlashCommandHost): Promise<void> {
  const appId = await askInput(host, {
    title: t('line.input_appid'),
    placeholder: 'cli_xxxxxxxxxxxx',
  });
  if (appId === undefined) return;

  const appSecret = await askInput(host, {
    title: t('line.input_secret'),
    placeholder: 'QhkMpxxxxxxxxxxxxxxxx',
    masked: true,
  });
  if (appSecret === undefined) return;

  host.showStatus(t('line.validating'));
  try {
    await validateFeishuCredentials(appId, appSecret);
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
    return;
  }

  const feishu: FeishuPlatformConfig = { app_id: appId, app_secret: appSecret };
  if (!(await mergeAndSaveConfig(host, { feishu }))) return;
  askStartNow(host);
}

// ─── Weixin QR login (native) ─────────────────────────────────────────────

async function runWeixinQRFlow(host: SlashCommandHost): Promise<void> {
  host.showStatus(t('line.weixin_qr_begin'));
  let begin: { qrKey: string; qrUrl: string };
  try {
    begin = await beginWeixinQRLogin({});
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
    return;
  }
  host.showNotice(t('line.weixin_qr_title'), t('line.weixin_qr_notice', { url: begin.qrUrl }));

  const spinner = host.showProgressSpinner(t('line.weixin_qr_waiting'));
  const deadline = Date.now() + WEIXIN_QR_DEADLINE_MS;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new WeixinLoginError(t('line.weixin_qr_timeout'));
      }
      const poll = await pollWeixinQRStatus({}, begin.qrKey);
      if (poll.status === 'confirmed') {
        await finishWeixinQRLogin(host, spinner, poll);
        return;
      }
      await weixinQRSleep();
    }
  } catch (error) {
    spinner.stop({
      ok: false,
      label: t('line.weixin_qr_failed', { error: error instanceof Error ? error.message : String(error) }),
    });
  }
}

async function finishWeixinQRLogin(
  host: SlashCommandHost,
  spinner: ReturnType<SlashCommandHost['showProgressSpinner']>,
  poll: Extract<Awaited<ReturnType<typeof pollWeixinQRStatus>>, { status: 'confirmed' }>,
): Promise<void> {
  spinner.stop({ ok: true, label: t('line.weixin_qr_confirmed') });

  const weixin: WeixinPlatformConfig = { token: poll.botToken };
  const existing = await loadLineConfig().catch(() => null);
  const hasAllowFrom = (existing?.weixin?.allow_from ?? '').trim() !== '';
  if (!hasAllowFrom && poll.ilinkUserId !== '') {
    weixin.allow_from = poll.ilinkUserId;
  }
  if (poll.baseUrl !== '') {
    weixin.base_url = poll.baseUrl;
  }

  const saved = await mergeAndSaveConfig(host, { weixin });
  if (!saved) return;
  if (weixin.allow_from !== undefined) {
    host.showNotice(t('line.weixin_allow_from_note'), `${poll.ilinkUserId}`);
  }
  askStartNow(host);
}

const WEIXIN_QR_DEADLINE_MS = 8 * 60 * 1000;

function weixinQRSleep(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 1500);
  });
}

// ─── Manual / import credential entry ─────────────────────────────────────

async function runWeixinWizard(host: SlashCommandHost): Promise<void> {
  const options: ChoiceOption[] = [
    { value: 'qr', label: t('line.weixin_opt_qr'), description: t('line.weixin_opt_qr_desc') },
    { value: 'manual', label: t('line.weixin_opt_manual'), description: t('line.weixin_opt_manual_desc') },
    { value: 'tutorial', label: t('line.weixin_opt_tutorial'), description: t('line.weixin_opt_tutorial_desc') },
  ];

  const picker = new ChoicePickerComponent({
    title: t('line.weixin_wizard_title'),
    hint: t('line.weixin_wizard_hint'),
    options,
    colors: host.state.theme.colors,
    onSelect: (value) => {
      host.restoreEditor();
      if (value === 'tutorial') {
        host.showNotice(t('line.weixin_tutorial_title'), t('line.weixin_tutorial'));
        return;
      }
      if (value === 'qr') {
        void runWeixinQRFlow(host);
        return;
      }
      void collectWeixinCredentials(host);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

async function collectWeixinCredentials(host: SlashCommandHost): Promise<void> {
  const token = await askInput(host, {
    title: t('line.weixin_input_token'),
    placeholder: 'ilink bot Bearer token',
    masked: true,
  });
  if (token === undefined) return;

  host.showStatus(t('line.weixin_validating'));
  const probeOptions = { ...resolveWeixinOptions({ token }), longPollTimeoutMs: 5_000 };
  try {
    const check = await validateWeixinToken(probeOptions);
    if (check.sessionExpired) {
      host.showNotice(t('line.weixin_session_expired'), t('line.weixin_session_expired_hint'));
    }
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
    return;
  }

  const weixin: WeixinPlatformConfig = { token };
  if (!(await mergeAndSaveConfig(host, { weixin }))) return;
  askStartNow(host);
}

// ─── Shared save + start prompt ───────────────────────────────────────────

async function mergeAndSaveConfig(
  host: SlashCommandHost,
  patch: { feishu?: FeishuPlatformConfig; weixin?: WeixinPlatformConfig },
): Promise<boolean> {
  try {
    const existing = await loadLineConfig();
    const config: LineConfig = {
      version: 1,
      // Single-channel invariant: saving one platform clears the other.
      feishu: patch.feishu ?? (patch.weixin !== undefined ? undefined : existing?.feishu),
      weixin: patch.weixin ?? (patch.feishu !== undefined ? undefined : existing?.weixin),
      permissionMode: existing?.permissionMode ?? 'yolo',
      autoStart: existing?.autoStart ?? true,
      ...(existing?.workDir !== undefined ? { workDir: existing.workDir } : {}),
    };
    await saveLineConfig(config);
    host.setAppState({ linePlatform: config.feishu !== undefined ? 'lark' : 'wechat' });
    host.noteLineStateWrite?.();
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
    return false;
  }
  host.showNotice(
    patch.weixin && !patch.feishu ? t('line.weixin_config_saved') : t('line.config_saved'),
    getLineConfigPath(),
  );
  return true;
}

function askStartNow(host: SlashCommandHost): void {
  const picker = new ChoicePickerComponent({
    title: t('line.ask_start'),
    options: [
      { value: 'now', label: t('line.opt_start_now'), description: t('line.opt_start_now_desc') },
      { value: 'later', label: t('common.cancel') },
    ],
    colors: host.state.theme.colors,
    onSelect: (value) => {
      host.restoreEditor();
      if (value === 'now') void doStart(host);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

// ─── Lifecycle actions ────────────────────────────────────────────────────

async function doStart(host: SlashCommandHost): Promise<void> {
  const config = await loadLineConfig().catch(() => null);
  if (!config?.feishu && !config?.weixin) {
    host.showError(t('line.not_configured'));
    return;
  }
  host.showStatus(t('line.starting'));
  try {
    const { pid, alreadyRunning } = await startLineDaemonDetached();
    host.showStatus(alreadyRunning ? t('line.already_running', { pid: `${pid}` }) : t('line.started', { pid: `${pid}` }));
    host.setAppState({
      lineActive: true,
      linePlatform: config.feishu !== undefined ? 'lark' : 'wechat',
    });
    host.noteLineStateWrite?.();
  } catch (error) {
    host.showError(t('line.start_failed', { error: error instanceof Error ? error.message : String(error) }));
    host.setAppState({ lineActive: false });
    host.noteLineStateWrite?.();
  }
}

async function doStop(host: SlashCommandHost): Promise<void> {
  host.showStatus(t('line.stopping'));
  const stopped = await stopLineDaemon();
  host.showStatus(stopped ? t('line.stopped') : t('line.not_running'));
  host.setAppState({ lineActive: false });
}

async function doRestart(host: SlashCommandHost): Promise<void> {
  host.showStatus(t('line.restarting'));
  await stopLineDaemon();
  await doStart(host);
}

async function doUninstall(host: SlashCommandHost): Promise<void> {
  const confirmed = await new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('line.confirm_uninstall'),
      hint: t('line.uninstall_irreversible'),
      options: [
        { value: 'no', label: t('common.cancel') },
        { value: 'yes', label: t('line.confirm_uninstall_btn'), tone: 'danger', description: t('line.will_clean') },
      ],
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        host.restoreEditor();
        resolve(value === 'yes');
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
  if (!confirmed) return;

  const spinner = host.showProgressSpinner(t('line.uninstalling'));
  await stopLineDaemon().catch(() => {});
  try {
    await removeLineDir();
    spinner.stop({ ok: true, label: t('line.uninstalled') });
    host.showNotice(t('line.uninstalled'), t('line.uninstall_note'));
  } catch (error) {
    spinner.stop({
      ok: false,
      label: t('line.uninstall_failed', { error: error instanceof Error ? error.message : String(error) }),
    });
  }
  host.setAppState({ lineActive: false, linePlatform: null });
  host.noteLineStateWrite?.();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function askInput(
  host: SlashCommandHost,
  opts: { title: string; placeholder?: string; initialValue?: string; masked?: boolean },
): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const dialog = new TextInputDialogComponent(
    (result) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    },
    {
      title: opts.title,
      placeholder: opts.placeholder,
      initialValue: opts.initialValue,
      masked: opts.masked,
      allowEmpty: false,
      colors: host.state.theme.colors,
    },
  );
  host.mountEditorReplacement(dialog);
  return promise;
}
