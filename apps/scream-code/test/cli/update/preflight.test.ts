import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readUpdateCache } from '#/cli/update/cache';
import { runUpdatePreflight } from '#/cli/update/preflight';
import { promptForInstallConfirmation } from '#/cli/update/prompt';
import type * as PromptModule from '#/cli/update/prompt';
import { refreshUpdateCache } from '#/cli/update/refresh';
import type * as RefreshModule from '#/cli/update/refresh';
import { emptyUpdateCache, type UpdateCache } from '#/cli/update/types';

const mocks = vi.hoisted(() => ({
  readUpdateCache: vi.fn(),
  promptForInstallConfirmation: vi.fn(),
  refreshUpdateCache: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/cli/update/cache', () => ({
  readUpdateCache: mocks.readUpdateCache,
}));

vi.mock('../../../src/cli/update/prompt', async () => {
  const actual = await vi.importActual<typeof PromptModule>('../../../src/cli/update/prompt.js');
  return {
    ...actual,
    promptForInstallConfirmation: mocks.promptForInstallConfirmation,
  };
});

vi.mock('../../../src/cli/update/refresh', async () => {
  const actual = await vi.importActual<typeof RefreshModule>('../../../src/cli/update/refresh.js');
  return {
    ...actual,
    refreshUpdateCache: mocks.refreshUpdateCache,
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcess>('node:child_process');
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

function cacheWith(version: string): UpdateCache {
  return {
    source: 'npm',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: version,
  };
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  options: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
    isTTY: boolean;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
      isTTY: true,
    },
  };
}

function mockSpawnExit(code: number, signal: NodeJS.Signals | null = null): void {
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => { child.emit('exit', code, signal); });
    return child;
  });
}

describe('runUpdatePreflight', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('continues on first launch with empty cache after refreshing latest version', async () => {
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(readUpdateCache).not.toHaveBeenCalled();
  });
  it('skips when non-interactive', async () => {
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.promptForInstallConfirmation.mockResolvedValue(false);
    const { stdout, options } = captureOutput();
    await expect(
      runUpdatePreflight('0.4.0', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    expect(stdout.join('')).toContain('npm install -g scream-code@latest');
    expect(promptForInstallConfirmation).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('interactive: prompts and runs npm install -g scream-code@latest', async () => {
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mockSpawnExit(0);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
    expect(mocks.promptForInstallConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        installCommand: 'npm install -g scream-code@latest',
      }),
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'scream-code@latest'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(stdout.join('')).toContain('已更新至 0.5.0');
  });

  it('declined install continues without spawn', async () => {
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.promptForInstallConfirmation.mockResolvedValue(false);
    const { options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('warns and continues when spawn exits non-zero, without claiming success', async () => {
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mockSpawnExit(1);
    const { stdout, stderr, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stderr.join('')).toContain('警告：更新失败');
    expect(stdout.join('')).not.toContain('已更新至');
  });
});
