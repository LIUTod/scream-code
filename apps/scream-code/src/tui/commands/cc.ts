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

const ACTIONS: ActionDef[] = [
  { label: '启动', action: 'start', description: '启动 cc-connect 后台守护进程' },
  { label: '关闭', action: 'stop', description: '停止 cc-connect 后台守护进程' },
  { label: '重启', action: 'restart', description: '重启 cc-connect 后台守护进程' },
  { label: '卸载', action: 'uninstall', description: '彻底卸载 cc-connect（守护进程 + 配置 + npm 包）', tone: 'danger' },
];

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

  const options: ChoiceOption[] = ACTIONS.map((a) => ({
    label: a.label,
    value: a.action,
    description: a.description,
    tone: a.tone,
  }));

  const picker = new ChoicePickerComponent({
    title: `cc-connect 守护进程管理 (${daemon.method})`,
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
  const label = action === 'start' ? '启动' : action === 'stop' ? '关闭' : '重启';
  const cmd = daemon.buildCmd(action);

  host.showStatus(`正在${label} cc-connect...`);

  void (async () => {
    const { ok, output } = await runCmd(cmd);
    if (ok) {
      host.showStatus(
        `✅ cc-connect 已${label}` + (output ? `（${output}）` : ''),
        host.state.theme.colors.success,
      );
      host.refreshCcStatus();
    } else {
      host.showError(`❌ ${label}失败：${output || '未知错误'}`);
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
    '将执行以下清理：',
    `· 停止并卸载 ${daemon.method} 守护进程`,
    '· 删除配置目录 ~/.cc-connect（含会话记录、配置、日志）',
    '· 执行 npm uninstall -g cc-connect',
  ];
  if (install.version) {
    lines.push(`· 当前版本：v${install.version}`);
  }
  if (install.entry) {
    lines.push(`· 安装路径：${install.entry}`);
  }
  if (daemon.method.includes('pm2')) {
    lines.splice(2, 0, '· 删除 pm2 进程 + 启动项（startup.bat / schtasks）');
  }
  if (residualPaths.length > 0) {
    lines.push(`· 清理 ${residualPaths.length} 个残留文件（launchd/systemd/pm2 日志）`);
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
      '未识别 cc-connect 安装',
      '未在默认 npm 全局路径下检测到 cc-connect 安装，已中止卸载。\n建议将此情况发送给 scream，由其指导手动清理。',
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

  const spinner = host.showProgressSpinner('正在卸载 cc-connect…');
  const steps: { label: string; ok: boolean; output: string }[] = [];

  // Step 1: stop daemon (best-effort, ignore errors — process may already be gone)
  const stopCmd = daemon.buildCmd('stop');
  const stopResult = await runCmd(stopCmd);
  steps.push({ label: '停止守护进程', ok: stopResult.ok, output: stopResult.output });

  // Step 2: platform-specific scheduler/pm2 cleanup
  await cleanupSchedulerOrPm2(daemon, steps);

  // Step 3: delete ~/.cc-connect (config + sessions + logs — the critical one)
  try {
    await rm(configDir, { recursive: true, force: true });
    steps.push({ label: `删除 ${configDir}`, ok: true, output: '' });
  } catch (error) {
    steps.push({
      label: `删除 ${configDir}`,
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
      label: `清理残留文件 (${residualPaths.length})`,
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
    label: allOk ? 'cc-connect 已彻底卸载' : '部分步骤失败，详见下方提示',
  });

  const summary = steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.label}${s.output ? `：${s.output}` : ''}`).join('\n');
  if (allOk) {
    host.showNotice(
      'cc-connect 已卸载',
      `${summary}\n\n建议重启 Scream Code 以确保 cc-connect 状态完全清空。`,
    );
  } else {
    host.showNotice('卸载部分失败', summary);
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
      steps.push({ label: `pm2 delete ${name} (残留)`, ok: r.ok, output: r.output });
    }

    // Persist the cleaned-up process list so pm2 resurrect won't bring back
    // cc-connect on the next reboot.
    const pm2Save = await runCmd('pm2 save 2>nul');
    steps.push({ label: 'pm2 save', ok: pm2Save.ok, output: pm2Save.output });

    // cc-connect-startup.bat in Windows Startup folder
    const startupBat = await runCmd(
      `if exist "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\cc-connect-startup.bat" del /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\cc-connect-startup.bat"`,
    );
    steps.push({ label: '删除 cc-connect-startup.bat', ok: startupBat.ok, output: startupBat.output });

    // Scheduled task that resurrects pm2 at logon (if it exists)
    const schtask = await runCmd('schtasks /query /tn "cc-connect-pm2" 2>nul && schtasks /delete /tn "cc-connect-pm2" /f || echo no-such-task');
    steps.push({ label: '删除 schtasks cc-connect-pm2', ok: schtask.ok, output: schtask.output });
    return;
  }

  // Windows daemon path — try cc-connect daemon uninstall first, then clear the scheduled task
  if (process.platform === 'win32') {
    const daemonUninstall = await runCmd('cc-connect daemon uninstall');
    steps.push({ label: 'cc-connect daemon uninstall', ok: daemonUninstall.ok, output: daemonUninstall.output });
    const schtask = await runCmd('schtasks /query /tn "cc-connect-daemon" 2>nul && schtasks /delete /tn "cc-connect-daemon" /f || echo no-such-task');
    steps.push({ label: '删除 schtasks cc-connect-daemon', ok: schtask.ok, output: schtask.output });
    return;
  }

  // macOS / Linux — cc-connect daemon uninstall (launchd/systemd unit)
  const daemonUninstall = await runCmd('cc-connect daemon uninstall');
  steps.push({ label: 'cc-connect daemon uninstall', ok: daemonUninstall.ok, output: daemonUninstall.output });
}

function confirmCcConnectUninstall(host: SlashCommandHost, summary: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: '确认彻底卸载 cc-connect？',
      hint: '此操作不可撤销，所有 cc-connect 数据将被清除',
      options: [
        { value: 'no', label: '取消' },
        { value: 'yes', label: '确认卸载', tone: 'danger', description: summary },
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
