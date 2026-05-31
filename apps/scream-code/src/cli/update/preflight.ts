import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TelemetryProperties } from '@scream-cli/scream-telemetry';

import { readUpdateCache } from './cache';
import { promptForInstallConfirmation, type InstallPromptOptions } from './prompt';
import { refreshUpdateCache } from './refresh';
import { selectUpdateTarget } from './select';
import { detectInstallSource } from './source';
import {
  type InstallSource,
  type UpdateDecision,
  type UpdatePreflightResult,
  type UpdateTarget,
} from './types';

export type { UpdatePreflightResult } from './types';

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
  readonly track?: (event: string, properties?: TelemetryProperties) => void;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderManualUpdateMessage(currentVersion: string, target: UpdateTarget): string {
  return (
    `Scream Code 有新版本可用 ` +
    `(${currentVersion} -> ${target.version})。\n` +
    `自动更新失败，请手动执行：\n` +
    `  cd ~/.scream-code && ./install.sh --upgrade\n`
  );
}

function renderInstallSuccessMessage(target: UpdateTarget): string {
  return `已更新至 ${target.version}。请重新启动 scream 以使用新版本。\n`;
}

function refreshInBackground(): void {
  void refreshUpdateCache().catch(() => {});
}

function trackUpdatePrompted(
  track: RunUpdatePreflightOptions['track'],
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  decision: UpdateDecision,
): void {
  try {
    track?.('update_prompted', {
      current: currentVersion,
      latest: target.version,
      current_version: currentVersion,
      target_version: target.version,
      source,
      decision,
    });
  } catch {
    // Telemetry must never affect update prompting.
  }
}

async function promptInstall(
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  installCommand: string,
): Promise<boolean> {
  const options: InstallPromptOptions = {
    currentVersion,
    target,
    installSource: source,
    installCommand,
  };
  return promptForInstallConfirmation(options);
}

async function installUpdate(installDir: string): Promise<void> {
  const commands = [
    { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: installDir },
    { cmd: 'pnpm', args: ['install'], cwd: installDir },
    { cmd: 'pnpm', args: ['-r', 'build'], cwd: installDir },
  ];

  for (const { cmd, args, cwd } of commands) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = signal !== null ? `信号 ${signal}` : `退出码 ${String(code)}`;
        reject(new Error(`${cmd} 以 ${detail} 退出`));
      });
    });
  }
}

export function decideUpdateAction(
  target: UpdateTarget | null,
  isInteractive: boolean,
): UpdateDecision {
  if (target === null || !isInteractive) return 'none';
  return 'prompt-install';
}

export async function runUpdatePreflight(
  currentVersion: string,
  options: RunUpdatePreflightOptions = {},
): Promise<UpdatePreflightResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const cache = await readUpdateCache().catch(() => null);
    const latest = cache?.latest ?? null;
    const target = selectUpdateTarget(currentVersion, latest);
    refreshInBackground();

    const isInteractive =
      options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
    const source: InstallSource =
      target === null || !isInteractive ? 'unsupported' : detectInstallSource();

    const decision = decideUpdateAction(target, isInteractive);
    if (decision === 'none' || target === null) return 'continue';

    const installCommand = 'cd ~/.scream-code && git pull && pnpm install && pnpm -r build';
    trackUpdatePrompted(options.track, currentVersion, target, source, decision);

    if (source === 'unsupported') {
      stdout.write(renderManualUpdateMessage(currentVersion, target));
      return 'continue';
    }

    const confirmed = await promptInstall(currentVersion, target, source, installCommand);
    if (!confirmed) return 'continue';

    const installDir = join(homedir(), '.scream-code');

    try {
      await installUpdate(installDir);
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
