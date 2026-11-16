/**
 * `scream export` sub-command.
 *
 * CLI glue only: session lookup, previous-session confirmation, and output.
 * The actual ZIP/manifest export is owned by the SDK.
 */

import { createInterface } from 'node:readline/promises';
import { t } from '@scream-code/config';

import {
  ScreamHarness,
  resolveScreamHome,
  type ExportSessionInput,
  type ExportSessionResult,
  type SessionSummary,
  type ShellEnvironment,
} from '@scream-code/scream-code-sdk';
import type { Command } from 'commander';

import { detectInstallSource } from '#/cli/update/source';
import { createScreamCodeHostIdentity } from '#/cli/version';
import { detectShellEnvironment } from '#/utils/process/shell-env';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface PreviousSessionSummary {
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly title?: string | undefined;
}

export interface ExportDeps {
  readonly listSessions: (workDir: string) => Promise<readonly SessionSummary[]>;
  readonly exportSession: (input: ExportSessionInput) => Promise<ExportSessionResult>;
  readonly confirmPreviousSession: (summary: PreviousSessionSummary) => Promise<boolean>;
  readonly getInstallSource: () => Promise<string>;
  readonly getShellEnv: () => ShellEnvironment;
  readonly version: string;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface ExportOptions {
  readonly yes: boolean;
  readonly includeGlobalLog: boolean;
}

export async function handleExport(
  deps: ExportDeps,
  sessionId: string | undefined,
  output: string | undefined,
  opts: ExportOptions,
): Promise<void> {
  const requestedId = normalizeOptionalSessionId(sessionId);
  const previousSummary = requestedId === undefined ? await findPreviousSession(deps) : undefined;

  let resolvedId: string;
  if (requestedId !== undefined) {
    resolvedId = requestedId;
  } else {
    if (previousSummary === undefined) {
      deps.stderr.write(`${t('cli.export.none')}\n`);
      deps.exit(1);
    }
    resolvedId = previousSummary.id;
    if (!opts.yes) {
      const confirmed = await deps.confirmPreviousSession(toPreviousSessionSummary(previousSummary));
      if (!confirmed) {
        deps.stdout.write(`${t('cli.export.cancelled')}\n`);
        return;
      }
    }
  }

  try {
    const installSource = await deps.getInstallSource();
    const shellEnv = deps.getShellEnv();
    const result = await deps.exportSession({
      id: resolvedId,
      version: deps.version,
      installSource,
      shellEnv,
      ...(output === undefined ? {} : { outputPath: output }),
      ...(opts.includeGlobalLog ? { includeGlobalLog: true } : {}),
    });
    deps.stdout.write(`${result.zipPath}\n`);
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerExportCommand(parent: Command, deps?: Partial<ExportDeps>): void {
  parent
    .command('export')
    .description(t('cli.export.description'))
    .option('-o, --output <path>', t('cli.export.opt_output'))
    .option('-y, --yes', t('cli.export.opt_yes'))
    .option(
      '--no-include-global-log',
      t('cli.export.opt_no_log'),
    )
    .argument('[sessionId]', t('cli.export.arg_session'))
    .action(
      async (
        sessionId: string | undefined,
        options: { output?: string; yes?: boolean; includeGlobalLog?: boolean },
      ) => {
        await handleExport(createDefaultExportDeps(deps), sessionId, options.output, {
          yes: options.yes === true,
          includeGlobalLog: options.includeGlobalLog !== false,
        });
      },
    );
}

function createDefaultExportDeps(overrides: Partial<ExportDeps> = {}): ExportDeps {
  let harness: ScreamHarness | undefined;
  const identity = createScreamCodeHostIdentity();
  const getHarness = (): ScreamHarness => {
    harness ??= new ScreamHarness({
      homeDir: resolveScreamHome(),
      identity,
    });
    return harness;
  };
  return {
    listSessions:
      overrides.listSessions ??
      ((workDir: string) =>
        getHarness().listSessions({
          workDir,
        })),
    exportSession:
      overrides.exportSession ??
      (async (input: ExportSessionInput) => getHarness().exportSession(input)),
    version: overrides.version ?? identity.version,
    getInstallSource: overrides.getInstallSource ?? (() => Promise.resolve(detectInstallSource())),
    getShellEnv: overrides.getShellEnv ?? detectShellEnvironment,
    confirmPreviousSession: overrides.confirmPreviousSession ?? confirmPreviousSession,
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}

async function findPreviousSession(deps: Pick<ExportDeps, 'cwd' | 'listSessions'>): Promise<
  SessionSummary | undefined
> {
  const sessions = await deps.listSessions(deps.cwd());
  return sessions[0];
}

function toPreviousSessionSummary(summary: SessionSummary): PreviousSessionSummary {
  return {
    workDir: summary.workDir,
    sessionId: summary.id,
    sessionDir: summary.sessionDir,
    ...(summary.title === undefined ? {} : { title: summary.title }),
  };
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

async function confirmPreviousSession(summary: PreviousSessionSummary): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const title = summary.title === undefined ? summary.sessionId : `${summary.title} (${summary.sessionId})`;
    const answer = await rl.question(t('cli.export.confirm', { title }));
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
