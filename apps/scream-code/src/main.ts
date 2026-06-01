/**
 * Scream Code entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, runs the
 * outer update preflight, then delegates to the requested UI runner.
 */

import {
  flushDiagnosticLogs,
  log,
  resolveGlobalLogPath,
  resolveScreamHome,
} from '@scream-cli/scream-code-sdk';
import { installCrashHandlers, track } from '@scream-cli/scream-telemetry';

import { createProgram } from './cli/commands';
import type { CLIOptions } from './cli/options';
import { OptionConflictError, validateOptions } from './cli/options';
import { runPrompt } from './cli/run-prompt';
import { runShell } from './cli/run-shell';
import { runChannelSetup } from './cli/channel-setup';
import { runStreamJson } from './cli/run-stream-json';
import { formatStartupError } from './cli/startup-error';
import { runPluginNodeEntry } from './cli/sub/plugin-run-node';
import { runUpdatePreflight } from './cli/update/preflight';
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

  const preflightResult = await runUpdatePreflight(
    version,
    validated.uiMode === 'print' ? { track, isTTY: false } : { track },
  );
  if (preflightResult === 'exit') {
    process.exit(0);
  }

  if (validated.uiMode === 'print') {
    await runPrompt(validated.options, version);
    return;
  }

  await runShell(validated.options, version);
}

/** `scream migrate` — permanently disabled. */
async function handleMigrateCommand(): Promise<void> {
  process.stdout.write('迁移功能已取消，不再支持从 scream-cli 导入数据。\n');
  process.exit(0);
}

export function main(): void {
  initProcessName();
  installCrashHandlers();

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
    () => {
      void handleMigrateCommand().catch(async (error: unknown) => {
        await logStartupFailure('运行迁移', error);
        process.stderr.write(formatStartupError(error, { operation: '运行迁移' }));
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

main();

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  log.error('startup failed', { operation, error });
  try {
    await flushDiagnosticLogs();
  } catch {
    // Best-effort diagnostic flush only.
  }
}
