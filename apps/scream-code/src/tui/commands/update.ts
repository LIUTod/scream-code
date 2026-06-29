/**
 * /update slash command — manually install the latest Scream Code update.
 *
 * Runs `npm install -g scream-code@latest`, then asks the user to restart.
 * Network-error detection with user-friendly Chinese prompts.
 */

import { spawn } from 'node:child_process';

import { readUpdateCache } from '#/cli/update/cache';
import { refreshUpdateCache } from '#/cli/update/refresh';
import { selectUpdateTarget } from '#/cli/update/select';
import { isBusy } from '../utils/app-state';

import type { SlashCommandHost } from './dispatch';

// Per-step timeout (ms). The default Node.js spawn timeout is infinite.
const INSTALL_TIMEOUT_MS = 300_000;

/**
 * Resolve the npm executable name for the current platform.
 *
 * On Windows, `npm` is `npm.cmd` — a batch file Node can spawn directly
 * without `shell: true` (which would trigger DEP0190 when args are passed).
 */
function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

const NETWORK_ERROR_PATTERNS = [
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /EPIPE/i,
  /timeout/i,
  /couldn't connect/i,
  /Could not resolve host/i,
  /Failed to connect/i,
  /request failed/i,
  /443/i,
  /TLS/i,
  /SSL/i,
];

function isNetworkError(message: string): boolean {
  return NETWORK_ERROR_PATTERNS.some((p) => p.test(message));
}

interface StepResult {
  ok: boolean;
  message: string;
}

async function runInstallStep(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  label: string,
  timeoutMs: number = INSTALL_TIMEOUT_MS,
): Promise<StepResult> {
  return new Promise<StepResult>((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'pipe' });
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({
          ok: false,
          message:
            `${label}超时，可能因网络原因卡住。\n` +
            '请检查网络后重试（国内用户建议科学上网）。',
        });
      }
    }, timeoutMs);

    const finalize = (result: StepResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.once('error', (err: NodeJS.ErrnoException) => {
      const msg = stderr.trim() || err.message;
      if (isNetworkError(msg)) {
        finalize({
          ok: false,
          message:
            `${label}失败：网络连接异常，请检查网络后重试。\n` +
            '（国内用户建议科学上网，如遇网络错误请多尝试几次）',
        });
      } else {
        finalize({ ok: false, message: `${label}失败：${msg}` });
      }
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        finalize({ ok: true, message: '' });
        return;
      }
      const msg = stderr.trim();
      const detail = signal !== null ? `信号 ${signal}` : `退出码 ${String(code)}`;

      if (isNetworkError(msg)) {
        finalize({
          ok: false,
          message:
            `${label}失败：网络连接异常，请检查网络后重试。\n` +
            '（国内用户建议科学上网，如遇网络错误请多尝试几次）',
        });
      } else {
        finalize({ ok: false, message: `${label}以 ${detail} 退出：${msg}` });
      }
    });
  });
}

export async function handleUpdateCommand(host: SlashCommandHost): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError('请在空闲时执行更新。');
    return;
  }

  host.showStatus('正在检测更新...');

  // Refresh the cache first so we're checking against the latest release.
  await refreshUpdateCache().catch(() => {});
  const cache = await readUpdateCache().catch(() => null);
  const target = selectUpdateTarget(host.state.appState.version, cache?.latest ?? null);
  if (target === null) {
    host.showStatus(
      '✅ 当前已是最新版本（' + host.state.appState.version + '）',
      host.state.theme.colors.success,
    );
    return;
  }

  host.showStatus(`正在更新到 ${target.version}...`);

  host.showStatus('正在通过 npm 安装最新版本...');
  const result = await runInstallStep(
    npmExecutable(),
    ['install', '-g', 'scream-code@latest'],
    undefined,
    '安装 scream-code',
  );
  if (!result.ok) {
    host.showError(`❌ ${result.message}`);
    return;
  }

  host.showStatus(
    '✅ 更新完成。请重启 Scream Code 以使用新版本。',
    host.state.theme.colors.success,
  );
  host.setAppState({ hasNewVersion: false, latestVersion: null });
}
