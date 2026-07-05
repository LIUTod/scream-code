import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCodes, ScreamError } from '@scream-code/scream-code-sdk';

import { validateOptions } from '#/cli/options';
import type { CLIOptions } from '#/cli/options';
import type * as OptionsModule from '#/cli/options';
import { runPrompt } from '#/cli/run-prompt';
import { runShell } from '#/cli/run-shell';
import { formatStartupError } from '#/cli/startup-error';
import { runUpdatePreflight } from '#/cli/update/preflight';
import { handleMainCommand, main } from '#/app';

const mocks = vi.hoisted(() => {
  const parse = vi.fn();
  return {
    parse,
    createProgram: vi.fn(() => ({ parse })),
    getVersion: vi.fn(() => '0.0.1-alpha.2'),
    validateOptions: vi.fn(),
    runUpdatePreflight: vi.fn(),
    runShell: vi.fn(),
    runPrompt: vi.fn(),
  };
});


vi.mock('../../src/cli/commands', () => ({
  createProgram: mocks.createProgram,
}));

vi.mock('../../src/cli/version', () => ({
  getVersion: mocks.getVersion,
}));

vi.mock('../../src/cli/options', async () => {
  const actual = await vi.importActual<typeof OptionsModule>('../../src/cli/options.js');
  return {
    ...actual,
    validateOptions: mocks.validateOptions,
  };
});

vi.mock('../../src/cli/update/preflight', () => ({
  runUpdatePreflight: mocks.runUpdatePreflight,
}));

vi.mock('../../src/cli/run-shell', () => ({
  runShell: mocks.runShell,
}));

vi.mock('../../src/cli/run-prompt', () => ({
  runPrompt: mocks.runPrompt,
}));

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

function defaultOpts(): CLIOptions {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    wolfpack: false,
    model: undefined,
    outputFormat: undefined,
    prompt: undefined,
    skillsDirs: [],
  };
}

async function runHandleMainCommand(opts: CLIOptions): Promise<number | null> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  try {
    await handleMainCommand(opts, '0.0.1-alpha.2');
    return null;
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  } finally {
    exitSpy.mockRestore();
  }
}

describe('main entry command handling', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts the shell without blocking on update preflight', async () => {
    const opts = defaultOpts();
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'shell' });
    mocks.runShell.mockResolvedValue(void 0);

    const exitCode = await runHandleMainCommand(opts);

    expect(exitCode).toBeNull();
    expect(validateOptions).toHaveBeenCalledWith(opts);
    // Update preflight is no longer called at startup — it was moved to
    // the TUI layer where it runs silently in the background.
    expect(runUpdatePreflight).not.toHaveBeenCalled();
    expect(runShell).toHaveBeenCalledWith(opts, '0.0.1-alpha.2');
  });

  it('runs prompt mode without interactive update preflight', async () => {
    const opts: CLIOptions = {
      ...defaultOpts(),
      prompt: 'explain the repo',
    };
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'print' });
    mocks.runPrompt.mockResolvedValue(void 0);

    const exitCode = await runHandleMainCommand(opts);

    expect(exitCode).toBeNull();
    expect(runUpdatePreflight).not.toHaveBeenCalled();
    expect(runPrompt).toHaveBeenCalledWith(opts, '0.0.1-alpha.2');
    expect(runShell).not.toHaveBeenCalled();
  });

  it('starts the shell without calling update preflight', async () => {
    const opts = defaultOpts();
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'shell' });
    mocks.runShell.mockResolvedValue(void 0);

    const exitCode = await runHandleMainCommand(opts);

    expect(exitCode).toBeNull();
    expect(runUpdatePreflight).not.toHaveBeenCalled();
    expect(runShell).toHaveBeenCalledWith(opts, '0.0.1-alpha.2');
  });


  it('formats Scream startup errors with structured fields', () => {
    const error = new ScreamError(
      ErrorCodes.SHELL_GIT_BASH_NOT_FOUND,
      'Git Bash was not found on this Windows host. Checked: C:\\Program Files\\Git\\bin\\bash.exe.',
    );
    const red = (text: string): string => `\u001B[31m${text}\u001B[39m`;

    expect(formatStartupError(error, { errorStyle: red })).toBe(
      [
        '\u001B[31m错误：Git Bash not found\u001B[39m',
        '',
        '\u001B[31m消息：\u001B[39m',
        '\u001B[31mGit Bash was not found on this Windows host. Checked: C:\\Program Files\\Git\\bin\\bash.exe.\u001B[39m',
        '',
      ].join('\n'),
    );
  });

  it('keeps generic startup errors on the legacy fallback path', () => {
    expect(formatStartupError(new Error('Provider not set'), { errorStyle: (text) => text })).toBe(
      '错误：start shell 失败：Provider not set\n',
    );
  });

  it('formats generic prompt mode errors without saying shell', () => {
    expect(
      formatStartupError(new Error('Provider not set'), {
        errorStyle: (text) => text,
        operation: 'run prompt',
      }),
    ).toBe('错误：run prompt 失败：Provider not set\n');
  });
});
