/**
 * /cc slash command — one-click cc-connect daemon lifecycle management.
 *
 * Typing /cc opens a picker with three options: Start, Stop, Restart.
 * Selecting one runs the appropriate command for the current platform:
 *   - macOS  / Linux               → cc-connect daemon start/stop/restart
 *   - Windows (daemon supported)   → cc-connect daemon start/stop/restart
 *   - Windows (no daemon, pm2)     → pm2 start/stop/restart cc-connect
 */

import { exec } from 'node:child_process';

import {
  ccConnectSupportsDaemon,
  detectCcConnectEntry,
} from '../../cli/cc-connect-daemon';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

type Action = 'start' | 'stop' | 'restart';

interface ActionDef {
  label: string;
  action: Action;
  description: string;
}

const ACTIONS: ActionDef[] = [
  { label: '启动', action: 'start', description: '启动 cc-connect 后台守护进程' },
  { label: '关闭', action: 'stop', description: '停止 cc-connect 后台守护进程' },
  { label: '重启', action: 'restart', description: '重启 cc-connect 后台守护进程' },
];

// ── Platform-aware command builder ─────────────────────────────────────

interface DaemonMode {
  method: string;
  buildCmd: (action: Action) => string;
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

// ── Command handler ────────────────────────────────────────────────────

export async function handleCcCommand(host: SlashCommandHost): Promise<void> {
  const daemon = resolveDaemonMode();

  const options: ChoiceOption[] = ACTIONS.map((a) => ({
    label: a.label,
    value: a.action,
    description: a.description,
  }));

  const picker = new ChoicePickerComponent({
    title: `cc-connect 守护进程管理 (${daemon.method})`,
    options,
    colors: host.state.theme.colors,
    onSelect: (value) => {
      const action = value as Action;
      const label = action === 'start' ? '启动' : action === 'stop' ? '关闭' : '重启';
      const cmd = daemon.buildCmd(action);

      host.restoreEditor();
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
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}
