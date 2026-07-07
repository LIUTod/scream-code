/**
 * /cc slash command — one-click cc-connect daemon lifecycle management.
 *
 * Typing /cc opens a picker with four options: Start, Stop, Restart, Uninstall.
 * Selecting one runs the appropriate command for the current platform:
 *   - macOS  / Linux               → cc-connect daemon start/stop/restart
 *   - Windows (daemon supported)   → cc-connect daemon start/stop/restart
 *   - Windows (no daemon, pm2)     → pm2 start/stop/restart cc-connect
 *
 * Uninstall removes cc-connect completely: stops the daemon, removes the
 * scheduled task / pm2 process, deletes ~/.cc-connect, and runs
 * `npm uninstall -g cc-connect`. After confirming, the machine is as if
 * cc-connect was never installed.
 */

import { exec } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';

import { t } from '@scream-code/config';

import {
  ccConnectSupportsDaemon,
  ccConnectVersion,
  detectCcConnectEntry,
} from '../../cli/cc-connect-daemon';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

type LifecycleAction = 'start' | 'stop' | 'restart';
type Action = LifecycleAction | 'uninstall';

interface ActionDef {
  label: string;
  action: Action;
  description: string;
  tone?: 'danger';
}

function getActions(): ActionDef[] {
  return [
    { label: t('cc.start'), action: 'start', description: t('cc.start_desc') },
    { label: t('cc.stop'), action: 'stop', description: t('cc.stop_desc') },
    { label: t('cc.restart'), action: 'restart', description: t('cc.restart_desc') },
    { label: t('cc.uninstall'), action: 'uninstall', description: t('cc.uninstall_desc'), tone: 'danger' },
  ];
}

// ── Platform-aware command builder ─────────────────────────────────────

interface DaemonMode {
  method: string;
  buildCmd: (action: LifecycleAction) => string;
  useShell?: boolean;
}

function resolveDaemonMode(): DaemonMode {
  const isWindows = process.platform === 'win32';

  if (!isWindows) {
    // macOS / Linux — native daemon
    return {
      method: process.platform === 'darwin' ? 'launchd' : 'systemd',
      buildCmd: (action) => `cc-connect daemon ${action}`,
    };
  }

  // Windows
  if (ccConnectSupportsDaemon()) {
    return {
      method: 'schtasks (Windows Task Scheduler)',
      buildCmd: (action) => `cc-connect daemon ${action}`,
    };
  }

  // Windows without daemon — fall back to pm2
  const entry = detectCcConnectEntry();
  const target = entry ?? 'cc-connect';
  return {
    method: 'pm2 (Node.js process manager)',
    buildCmd: (action) => {
      switch (action) {
        case 'start':
          // Try restart first (handles already-registered processes and
          // freshly-resurrected ones).  If that fails, register from scratch
          // and persist so pm2 resurrect can recover it after reboot.
          return `pm2 restart cc-connect 2>nul || pm2 start "${target}" --name cc-connect && pm2 save`;
        case 'stop':
          return 'pm2 stop cc-connect';
        case 'restart':
          // Same fallback as start: prefer restart, fall back to fresh start.
          return `pm2 restart cc-connect 2>nul || pm2 start "${target}" --name cc-connect && pm2 save`;
      }
    },
  };
}

function runCmd(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, output: stderr.trim() || error.message });
      } else {
        resolve({ ok: true, output: stdout.trim() });
      }
    });
  });
}

// ── Install detection ─────────────────────────────────────────────────

interface CcConnectInstall {
  entry: string | null;
  version: string | undefined;
}

function detectCcConnectInstall(): CcConnectInstall {
  return {
    entry: detectCcConnectEntry(),
    version: ccConnectVersion(),
  };
}

function isCcConnectInstalled(install: CcConnectInstall): boolean {
  return install.entry !== null || install.version !== undefined;
}

/**
 * Scan pm2 process list for any cc-connect-related processes (by name or
 * script path).  Used to catch stray/residual processes that weren't cleaned
 * up by the named `pm2 delete cc-connect`.
 */
async function findStrayCcConnectPm2ProcessNames(): Promise<string[]> {
  const { ok, output } = await runCmd('pm2 jlist 2>nul');
  if (!ok || !output) return [];
  try {
    const list = JSON.parse(output) as Array<{
      name?: string;
      pm2_env?: { pm_exec_path?: string };
    }>;
    return list
      .filter((p) => {
        const name = p.name ?? '';
        const execPath = p.pm2_env?.pm_exec_path ?? '';
        return name.includes('cc-connect') || execPath.includes('cc-connect');
      })
      .map((p) => p.name ?? '')
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

/**
 * Scan a directory for entries whose name contains "cc-connect".
 * Returns absolute paths.  Returns [] if the directory doesn't exist or
 * can't be read.
 */
async function scanDirForCcConnect(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((e) => e.toLowerCase().includes('cc-connect'))
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
}

/**
 * Find residual cc-connect files outside the main config dir.
 *
 * The main config + session dir is `~/.cc-connect` (handled separately because
 * it's the most critical).  This function scans for stragglers that, if left
 * behind, would cause the next install to collide:
 *
 *   - macOS launchd plists: `~/Library/LaunchAgents/cc-connect*.plist`
 *     (if `cc-connect daemon uninstall` failed to remove them)
 *   - Linux systemd units: `~/.config/systemd/user/cc-connect*`
 *     (same fallback as above)
 *   - pm2 logs: `~/.pm2/logs/cc-connect*`
 *     (pm2 never cleans these up; resurrect doesn't need them but they
 *      confuse debugging on next install)
 *
 * npm bin shims are deliberately NOT scanned here — `npm uninstall -g
 * cc-connect` (Step 4) is responsible for those, and scanning manually
 * risks deleting `node_modules/cc-connect` before npm gets to it.
 *
 * `excludePath` is the main config dir — already handled, so skipped here.
 */
async function findCcConnectResidualPaths(excludePath: string): Promise<string[]> {
  const paths = new Set<string>();
  const home = homedir();

  if (process.platform === 'darwin') {
    for (const p of await scanDirForCcConnect(join(home, 'Library', 'LaunchAgents'))) {
      paths.add(p);
    }
  }

  if (process.platform === 'linux') {
    for (const p of await scanDirForCcConnect(join(home, '.config', 'systemd', 'user'))) {
      paths.add(p);
    }
  }

  // pm2 logs — exists on all platforms if pm2 was ever installed
  for (const p of await scanDirForCcConnect(join(home, '.pm2', 'logs'))) {
    paths.add(p);
  }

  const existing: string[] = [];
  for (const p of paths) {
    if (p === excludePath) continue;
    try {
      await stat(p);
      existing.push(p);
    } catch {
      // doesn't exist — skip
    }
  }
  return existing.sort();
}

// ── Command handler ────────────────────────────────────────────────────

export async function handleCcCommand(host: SlashCommandHost): Promise<void> {
  const daemon = resolveDaemonMode();

  const options: ChoiceOption[] = getActions().map((a) => ({
    label: a.label,
    value: a.action,
    description: a.description,
    tone: a.tone,
  }));

  const picker = new ChoicePickerComponent({
    title: `${t('cc.manage_title')} (${daemon.method})`,
    options,
    colors: host.state.theme.colors,
    onSelect: (value) => {
      const action = value as Action;
      host.restoreEditor();
      if (action === 'uninstall') {
        void confirmAndUninstall(host, daemon);
        return;
      }
      runLifecycleAction(host, daemon, action);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}

// ── Lifecycle (start/stop/restart) ─────────────────────────────────────

function runLifecycleAction(host: SlashCommandHost, daemon: DaemonMode, action: LifecycleAction): void {
  const label = action === 'start' ? t('common.start') : action === 'stop' ? t('common.stop') : t('common.restart');
  const cmd = daemon.buildCmd(action);

  host.showStatus(t('cc.operating', { label }));

  void (async () => {
    const { ok, output } = await runCmd(cmd);
    if (ok) {
      host.showStatus(
        t('cc.started', { label }) + (output ? `（${output}）` : ''),
        host.state.theme.colors.success,
      );
      host.refreshCcStatus();
    } else {
      host.showError(t('cc.start_failed', { label, output: output || '未知错误' }));
    }
  })();
}

// ── Uninstall ─────────────────────────────────────────────────────────

const CC_CONNECT_CONFIG_DIR = () => join(homedir(), '.cc-connect');

function buildUninstallSummary(
  daemon: DaemonMode,
  install: CcConnectInstall,
  residualPaths: string[] = [],
): string {
  const lines = [
    t('cc.will_clean'),
    t('cc.clean_daemon', { label: daemon.method }),
    t('cc.clean_config', { detail: t('cc.clean_config.detail') }),
    '· 执行 npm uninstall -g cc-connect',
  ];
  if (install.version) {
    lines.push(t('cc.current_version', { version: install.version }));
  }
  if (install.entry) {
    lines.push(t('cc.install_path', { path: install.entry }));
  }
  if (daemon.method.includes('pm2')) {
    lines.splice(2, 0, t('cc.clean_pm2'));
  }
  if (residualPaths.length > 0) {
    lines.push(t('cc.clean_residual', { count: residualPaths.length }));
  }
  return lines.join('\n');
}

async function confirmAndUninstall(host: SlashCommandHost, daemon: DaemonMode): Promise<void> {
  // Detection gate — if we can't find cc-connect installed via the default
  // npm path AND the binary isn't callable, surface a "未识别安装" notice
  // instead of running a confusing best-effort cleanup.
  const install = detectCcConnectInstall();
  if (!isCcConnectInstalled(install)) {
    host.showNotice(
      t('cc.not_detected'),
      t('cc.not_detected_desc'),
    );
    return;
  }

  const configDir = CC_CONNECT_CONFIG_DIR();
  // Scan residual files before showing the confirm dialog so the user sees
  // the full cleanup scope upfront.
  const residualPaths = await findCcConnectResidualPaths(configDir);

  const confirmed = await confirmCcConnectUninstall(
    host,
    buildUninstallSummary(daemon, install, residualPaths),
  );
  if (!confirmed) return;

  const spinner = host.showProgressSpinner(t('cc.uninstalling'));
  const steps: { label: string; ok: boolean; output: string }[] = [];

  // Step 1: stop daemon (best-effort, ignore errors — process may already be gone)
  const stopCmd = daemon.buildCmd('stop');
  const stopResult = await runCmd(stopCmd);
  steps.push({ label: t('cc.stop_daemon'), ok: stopResult.ok, output: stopResult.output });

  // Step 2: platform-specific scheduler/pm2 cleanup
  await cleanupSchedulerOrPm2(daemon, steps);

  // Step 3: delete ~/.cc-connect (config + sessions + logs — the critical one)
  try {
    await rm(configDir, { recursive: true, force: true });
    steps.push({ label: `${t('cc.delete_label')} ${configDir}`, ok: true, output: '' });
  } catch (error) {
    steps.push({
      label: `${t('cc.delete_label')} ${configDir}`,
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 3b: scan and delete residual files (launchd/systemd/pm2 logs)
  // These are the stragglers that cause "next install collides with stale state".
  if (residualPaths.length > 0) {
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const p of residualPaths) {
      try {
        await rm(p, { recursive: true, force: true });
        deleted.push(p);
      } catch (error) {
        failed.push(`${p}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    steps.push({
      label: t('cc.clean_files', { count: `${residualPaths.length}` }),
      ok: failed.length === 0,
      output: [...deleted, ...failed].join('\n'),
    });
  }

  // Step 4: npm uninstall -g cc-connect
  const npmResult = await runCmd('npm uninstall -g cc-connect');
  steps.push({ label: 'npm uninstall -g cc-connect', ok: npmResult.ok, output: npmResult.output });

  const allOk = steps.every((s) => s.ok);
  spinner.stop({
    ok: allOk,
    label: allOk ? t('cc.uninstall_done') : t('cc.uninstall_partial'),
  });

  const summary = steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.label}${s.output ? `：${s.output}` : ''}`).join('\n');
  if (allOk) {
    host.showNotice(
      t('cc.uninstalled'),
      `${summary}\n\n${t('cc.restart_hint')}`,
    );
  } else {
    host.showNotice(t('cc.uninstall_partial_label'), summary);
  }
  host.refreshCcStatus();
}

async function cleanupSchedulerOrPm2(
  daemon: DaemonMode,
  steps: { label: string; ok: boolean; output: string }[],
): Promise<void> {
  // Windows pm2 path — delete pm2 process + startup bat + scheduled task
  if (daemon.method.includes('pm2')) {
    // Delete the primary named process first
    const pm2Delete = await runCmd('pm2 delete cc-connect 2>nul');
    steps.push({ label: 'pm2 delete cc-connect', ok: pm2Delete.ok, output: pm2Delete.output });

    // Scan for and delete any stray cc-connect-related pm2 processes that
    // might have been registered under a different name or resurrected from
    // a stale dump.  This is the "乱七八糟的进程" safety net.
    const strayNames = await findStrayCcConnectPm2ProcessNames();
    for (const name of strayNames) {
      if (name === 'cc-connect') continue; // already deleted above
      // Sanitize: pm2 process names should only contain safe chars.
      // Skip anything weird to prevent command injection via shell interpolation.
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) continue;
      const r = await runCmd(`pm2 delete "${name}" 2>nul`);
      steps.push({ label: `pm2 delete ${name} (${t('cc.residual')})`, ok: r.ok, output: r.output });
    }

    // Persist the cleaned-up process list so pm2 resurrect won't bring back
    // cc-connect on the next reboot.
    const pm2Save = await runCmd('pm2 save 2>nul');
    steps.push({ label: 'pm2 save', ok: pm2Save.ok, output: pm2Save.output });

    // cc-connect-startup.bat in Windows Startup folder
    const startupBat = await runCmd(
      `if exist "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\cc-connect-startup.bat" del /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\cc-connect-startup.bat"`,
    );
    steps.push({ label: `${t('cc.delete_label')} cc-connect-startup.bat`, ok: startupBat.ok, output: startupBat.output });

    // Scheduled task that resurrects pm2 at logon (if it exists)
    const schtask = await runCmd('schtasks /query /tn "cc-connect-pm2" 2>nul && schtasks /delete /tn "cc-connect-pm2" /f || echo no-such-task');
    steps.push({ label: `${t('cc.delete_label')} schtasks cc-connect-pm2`, ok: schtask.ok, output: schtask.output });
    return;
  }

  // Windows daemon path — try cc-connect daemon uninstall first, then clear the scheduled task
  if (process.platform === 'win32') {
    const daemonUninstall = await runCmd('cc-connect daemon uninstall');
    steps.push({ label: 'cc-connect daemon uninstall', ok: daemonUninstall.ok, output: daemonUninstall.output });
    const schtask = await runCmd('schtasks /query /tn "cc-connect-daemon" 2>nul && schtasks /delete /tn "cc-connect-daemon" /f || echo no-such-task');
    steps.push({ label: `${t('cc.delete_label')} schtasks cc-connect-daemon`, ok: schtask.ok, output: schtask.output });
    return;
  }

  // macOS / Linux — cc-connect daemon uninstall (launchd/systemd unit)
  const daemonUninstall = await runCmd('cc-connect daemon uninstall');
  steps.push({ label: 'cc-connect daemon uninstall', ok: daemonUninstall.ok, output: daemonUninstall.output });
}

function confirmCcConnectUninstall(host: SlashCommandHost, summary: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('cc.confirm_uninstall'),
      hint: t('cc.uninstall_irreversible'),
      options: [
        { value: 'no', label: t('common.cancel') },
        { value: 'yes', label: t('cc.confirm_uninstall_btn'), tone: 'danger', description: summary },
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
}
