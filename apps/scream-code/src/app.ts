/**
 * Scream Code entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, runs the
 * outer update preflight, then delegates to the requested UI runner.
 */

import './utils/suppress-sqlite-warning.js';

import {
  flushDiagnosticLogs,
  log,
  resolveGlobalLogPath,
  resolveScreamHome,
} from '@scream-code/scream-code-sdk';

import { createProgram } from './cli/commands';

import type { CLIOptions } from './cli/options';
import { OptionConflictError, validateOptions } from './cli/options';
import { runPrompt } from './cli/run-prompt';
import { runShell } from './cli/run-shell';
import { runChannelSetup } from './cli/channel-setup';
import { runStreamJson } from './cli/run-stream-json';
import { formatStartupError } from './cli/startup-error';
import { runPluginNodeEntry } from './cli/sub/plugin-run-node';
import { getVersion } from './cli/version';
import { initProcessName } from './utils/process/proctitle';

export async function handleMainCommand(opts: CLIOptions, version: string): Promise<void> {
  let validated: ReturnType<typeof validateOptions>;
  try {
    validated = validateOptions(opts);
  } catch (error) {
    if (error instanceof OptionConflictError) {
      process.stderr.write(`错误：${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  // Update check moved to TUI startup — no blocking prompt here.
  // The TUI shows a hint in the Welcome panel when a new version is
  // available, and the user can run /update manually.

  if (validated.uiMode === 'print') {
    await runPrompt(validated.options, version);
    return;
  }

  await runShell(validated.options, version);
}

export function main(): void {
  initProcessName();

  const version = getVersion();


  const program = createProgram(
    version,
    (opts) => {
      void handleMainCommand(opts, version).catch(async (error: unknown) => {
        const operation = opts.prompt !== undefined ? '运行提示' : '启动 shell';
        await logStartupFailure(operation, error);
        process.stderr.write(
          formatStartupError(error, {
            operation,
          }),
        );
        process.stderr.write(`查看日志：${resolveGlobalLogPath(resolveScreamHome())}\n`);
        process.exit(1);
      });
    },
    (entry, args) => {
      void runPluginNodeEntry(entry, args).catch(async (error: unknown) => {
        await logStartupFailure('运行插件节点入口', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    (opts) => {
      void runStreamJson(opts).catch(async (error: unknown) => {
        await logStartupFailure('运行 stream-json', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    () => {
      void runChannelSetup().catch(async (error: unknown) => {
        await logStartupFailure('运行 channel setup', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
  );

  program.parse(process.argv);
}

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  log.error('startup failed', { operation, error });
  try {
    await flushDiagnosticLogs();
  } catch {
    // Best-effort diagnostic flush only.
  }
}
