import { spawn } from 'node:child_process';

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

/**
 * Resolve the npm executable name for the current platform.
 *
 * On Windows, `npm` is `npm.cmd` — a batch file Node can spawn directly
 * without `shell: true` (which would trigger DEP0190 when args are passed).
 */
function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderManualUpdateMessage(currentVersion: string, target: UpdateTarget): string {
  return (
    `Scream Code 有新版本可用 ` +
    `(${currentVersion} -> ${target.version})。\n` +
    `自动更新失败，请手动执行：\n` +
    `  npm install -g scream-code@latest\n`
  );
}

function renderInstallSuccessMessage(target: UpdateTarget): string {
  return `已更新至 ${target.version}。请重新启动 scream 以使用新版本。\n`;
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

async function installUpdate(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(npmExecutable(), ['install', '-g', 'scream-code@latest'], { stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('npm install 超时'));
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
      reject(new Error(`npm install 失败（exit ${code ?? signal}）`));
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

    const installCommand = 'npm install -g scream-code@latest';

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
        `警告：更新失败：${formatErrorMessage(error)}\n`,
      );
      return 'continue';
    }
  } catch {
    return 'continue';
  }
}
