/**
 * Scream Code entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, runs the
 * outer update preflight, then delegates to the requested UI runner.
 */

import './utils/suppress-sqlite-warning.js';
import { setLocale, t } from '@scream-code/config';

import {
  flushDiagnosticLogs,
  log,
  resolveGlobalLogPath,
  resolveScreamHome,
} from '@scream-code/scream-code-sdk';

import { createProgram } from './cli/commands';

import type { CLIOptions } from './cli/options';
import { OptionConflictError, validateOptions } from './cli/options';
import { runLineCommand } from './cli/line-command';
import { runPrompt } from './cli/run-prompt';
import { runShell } from './cli/run-shell';
import { runStreamJson } from './cli/run-stream-json';
import { formatStartupError } from './cli/startup-error';
import { runPluginNodeEntry } from './cli/sub/plugin-run-node';
import { getVersion } from './cli/version';
import { loadSavedLanguageSync } from './tui/config';
import { initProcessName } from './utils/process/proctitle';

export async function handleMainCommand(opts: CLIOptions, version: string): Promise<void> {
  let validated: ReturnType<typeof validateOptions>;
  try {
    validated = validateOptions(opts);
  } catch (error) {
    if (error instanceof OptionConflictError) {
      process.stderr.write(`${t('cli.err.prefix', { message: error.message })}\n`);
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

  // The saved UI language must win over `LANG` for everything printed before a
  // session starts — `--help` and option errors are built before runShell /
  // runPrompt apply the loaded config.
  const savedLanguage = loadSavedLanguageSync();
  if (savedLanguage !== undefined) setLocale(savedLanguage);

  const version = getVersion();


  const program = createProgram(
    version,
    (opts) => {
      void handleMainCommand(opts, version).catch(async (error: unknown) => {
        const operation = opts.prompt !== undefined ? t('cli.op.run_prompt') : t('cli.op.start_shell');
        await logStartupFailure(operation, error);
        process.stderr.write(
          formatStartupError(error, {
            operation,
          }),
        );
        process.stderr.write(`${t('cli.err.see_log', { path: resolveGlobalLogPath(resolveScreamHome()) })}\n`);
        process.exit(1);
      });
    },
    (entry, args) => {
      void runPluginNodeEntry(entry, args).catch(async (error: unknown) => {
        await logStartupFailure('run plugin node entry', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    (opts) => {
      void runStreamJson(opts).catch(async (error: unknown) => {
        await logStartupFailure('run stream-json', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    (action) => {
      void runLineCommand(action).catch(async (error: unknown) => {
        await logStartupFailure('run line command', error);
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
