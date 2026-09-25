/**
 * /update slash command — manually install the latest Scream Code update.
 *
 * Runs `npm install -g scream-code@latest`, then asks the user to restart.
 * Network-error detection with user-friendly Chinese prompts.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { t } from '@scream-code/config';
import { killProcessTree } from '@scream-code/jian';
import { installLatestArgs } from '#/cli/update/prefix';
import { readUpdateCache } from '#/cli/update/cache';
import { refreshUpdateCache } from '#/cli/update/refresh';
import { selectUpdateTarget } from '#/cli/update/select';
import { npmLaunchPlan, type NpmLaunchPlan } from '#/utils/exec/npm';
import { isBusy } from '../utils/app-state';

import type { SlashCommandHost } from './dispatch';

// Per-step timeout (ms). The default Node.js spawn timeout is infinite.
const INSTALL_TIMEOUT_MS = 300_000;

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

/**
 * Reap an install step whose timeout expired.
 *
 * On Windows the direct child is `cmd.exe` (see `npmLaunchPlan`), so signalling
 * it stops the wrapper and leaves the `npm` / `node` beneath it running — there
 * is no process group on Windows to signal instead. `killProcessTree` makes up
 * for that with `taskkill /F /T /PID`, which walks the tree. POSIX has no
 * wrapper in between, so the child itself is signalled exactly as before.
 *
 * Never rejects: the step has already failed with a timeout and the caller is
 * told so, and a reaper that could not run must not turn that into a different
 * error.
 */
async function reapTimedOutStep(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  try {
    // `pid ?? 0` covers a spawn that never produced a process; a non-positive
    // pid is a no-op inside `killProcessTree`.
    await killProcessTree(child.pid ?? 0, { signal: 'SIGTERM', platform });
  } catch {
    /* the tree may already be gone; the timeout report is what matters */
  }
}

/**
 * Run one install step. `launch` comes from `npmLaunchPlan`, so a Windows host
 * gets the `cmd.exe` command line its `.cmd` shim needs; `spawn` receives the
 * matching `windowsVerbatimArguments` flag because the line is already quoted.
 * `launch` also carries the platform, which is what the timeout teardown
 * branches on.
 */
export async function runInstallStep(
  launch: NpmLaunchPlan,
  cwd: string | undefined,
  label: string,
  timeoutMs: number = INSTALL_TIMEOUT_MS,
): Promise<StepResult> {
  return new Promise<StepResult>((resolve) => {
    const child = spawn(launch.command, [...launch.args], {
      cwd,
      stdio: 'pipe',
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // The timeout result lands only after the teardown, so it never reports a
      // timeout while the install it describes is still running. Marking the
      // step settled up front keeps the exit that the kill triggers from
      // producing a second result.
      void reapTimedOutStep(child, launch.platform).then(() => {
        resolve({
          ok: false,
          message:
            `${label}${t('update.timeout')}\n` +
            t('update.network_hint'),
        });
      });
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
            `${label}${t('update.network_error')}\n` +
            t('update.network_hint_retry'),
        });
      } else {
        finalize({ ok: false, message: `${label}${t('update.failed', { msg })}` });
      }
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        finalize({ ok: true, message: '' });
        return;
      }
      const msg = stderr.trim();
      const detail = signal !== null ? `${t('update.signal')} ${signal}` : `${t('update.exit_code')} ${String(code)}`;

      if (isNetworkError(msg)) {
        finalize({
          ok: false,
          message:
            `${label}${t('update.network_error')}\n` +
            t('update.network_hint_retry'),
        });
      } else {
        finalize({ ok: false, message: `${label} ${detail}：${msg}` });
      }
    });
  });
}

export async function handleUpdateCommand(host: SlashCommandHost): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError(t('update.idle_only'));
    return;
  }

  host.showStatus(t('update.checking'));

  // Refresh the cache first so we're checking against the latest release.
  await refreshUpdateCache().catch(() => {});
  const cache = await readUpdateCache().catch(() => null);
  const target = selectUpdateTarget(host.state.appState.version, cache?.latest ?? null);
  if (target === null) {
    host.showStatus(
      '✅ ' + t('update.already_latest', { version: host.state.appState.version }),
      host.state.theme.colors.success,
    );
    return;
  }

  host.showStatus(t('update.updating', { version: target.version }));

  host.showStatus(t('update.npm_install'));
  const result = await runInstallStep(
    npmLaunchPlan(installLatestArgs()),
    undefined,
    t('update.install_label'),
  );
  if (!result.ok) {
    host.showError(`❌ ${result.message}`);
    return;
  }

  host.showStatus(
    '✅ ' + t('update.done'),
    host.state.theme.colors.success,
  );
  host.setAppState({ hasNewVersion: false, latestVersion: null });
}
