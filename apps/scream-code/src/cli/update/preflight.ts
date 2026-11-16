import { spawn, type ChildProcess } from 'node:child_process';
import { t } from '@scream-code/config';

import { killProcessTree } from '@scream-code/jian';
import { npmLaunchPlan } from '#/utils/exec/npm';

import { globalPrefixForScream, installLatestArgs } from './prefix';
import { promptForInstallConfirmation, type InstallPromptOptions } from './prompt';
import { refreshUpdateCache } from './refresh';
import { selectUpdateTarget } from './select';
import {
  type UpdateDecision,
  type UpdatePreflightResult,
  type UpdateTarget,
} from './types';

export type { UpdatePreflightResult } from './types';

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
}

const INSTALL_TIMEOUT_MS = 300_000;

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderManualUpdateMessage(currentVersion: string, target: UpdateTarget): string {
  const prefix = globalPrefixForScream();
  const installCommand =
    prefix !== undefined
      ? `npm install -g --prefix ${prefix} scream-code@latest`
      : 'npm install -g scream-code@latest';
  return t('cli.update.manual', {
    current: currentVersion,
    target: target.version,
    command: installCommand,
  });
}

function renderInstallSuccessMessage(target: UpdateTarget): string {
  return t('cli.update.success', { version: target.version });
}

async function promptInstall(
  currentVersion: string,
  target: UpdateTarget,
  installCommand: string,
): Promise<boolean> {
  const options: InstallPromptOptions = {
    currentVersion,
    target,
    installCommand,
  };
  return promptForInstallConfirmation(options);
}

/**
 * Reap an install that hit its timeout.
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
async function reapTimedOutInstall(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
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

async function installUpdate(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const npm = npmLaunchPlan(installLatestArgs());
    const child = spawn(npm.command, [...npm.args], {
      stdio: 'inherit',
      windowsVerbatimArguments: npm.windowsVerbatimArguments,
    });
    const timer = setTimeout(() => {
      // The timeout is reported only after the teardown: a timeout that fired
      // while the install it describes is still running would be a lie.
      void reapTimedOutInstall(child, npm.platform).then(() => {
        reject(new Error(t('cli.update.timeout')));
      });
    }, INSTALL_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(t('cli.update.install_failed', { code: String(code ?? signal) })));
    });
  });
}

export function decideUpdateAction(
  target: UpdateTarget | null,
  isInteractive: boolean,
): UpdateDecision {
  if (target === null) return 'none';
  if (!isInteractive) return 'manual-command';
  return 'prompt-install';
}

export async function runUpdatePreflight(
  currentVersion: string,
  options: RunUpdatePreflightOptions = {},
): Promise<UpdatePreflightResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const cache = await refreshUpdateCache().catch(() => null);
    const latest = cache?.latest ?? null;
    const target = selectUpdateTarget(currentVersion, latest);

    const isInteractive =
      options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);

    const decision = decideUpdateAction(target, isInteractive);
    if (decision === 'none' || target === null) return 'continue';

    const prefix = globalPrefixForScream();
    const installCommand =
      prefix !== undefined
        ? `npm install -g --prefix ${prefix} scream-code@latest`
        : 'npm install -g scream-code@latest';

    if (decision === 'manual-command') {
      stdout.write(renderManualUpdateMessage(currentVersion, target));
      return 'continue';
    }

    const confirmed = await promptInstall(currentVersion, target, installCommand);
    if (!confirmed) return 'continue';

    try {
      await installUpdate();
      stdout.write(renderInstallSuccessMessage(target));
      return 'exit';
    } catch (error) {
      stderr.write(
        t('cli.update.failed_warning', { message: formatErrorMessage(error) }),
      );
      return 'continue';
    }
  } catch {
    return 'continue';
  }
}
