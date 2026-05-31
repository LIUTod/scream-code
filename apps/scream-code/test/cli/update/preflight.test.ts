import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readUpdateCache } from '#/cli/update/cache';
import { runUpdatePreflight } from '#/cli/update/preflight';
import { promptForInstallConfirmation } from '#/cli/update/prompt';
import type * as PromptModule from '#/cli/update/prompt';
import { refreshUpdateCache } from '#/cli/update/refresh';
import type * as RefreshModule from '#/cli/update/refresh';
import { detectInstallSource } from '#/cli/update/source';
import { emptyUpdateCache, type UpdateCache } from '#/cli/update/types';

const mocks = vi.hoisted(() => ({
  readUpdateCache: vi.fn(),
  detectInstallSource: vi.fn(),
  promptForInstallConfirmation: vi.fn(),
  refreshUpdateCache: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/cli/update/cache', () => ({
  readUpdateCache: mocks.readUpdateCache,
}));

vi.mock('../../../src/cli/update/source', () => ({
  detectInstallSource: mocks.detectInstallSource,
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
    source: 'cdn',
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

  it('continues on first launch with empty cache, still refreshes in background', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(readUpdateCache).toHaveBeenCalledTimes(1);
    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('skips when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();
    await expect(
      runUpdatePreflight('0.4.0', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('source install: prompts and runs git pull + pnpm install + pnpm -r build', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('source');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mockSpawnExit(0);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
    expect(mocks.promptForInstallConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        installCommand: 'cd ~/.scream-code && git pull && pnpm install && pnpm -r build',
        installSource: 'source',
      }),
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      1,
      'git',
      ['pull', 'origin', 'main'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['install'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      3,
      'pnpm',
      ['-r', 'build'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(stdout.join('')).toContain('已更新至 0.5.0');
  });

  it('unsupported: prints manual upgrade command, does not spawn', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('unsupported');
    const { stdout, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stdout.join('')).toContain('cd ~/.scream-code && ./install.sh --upgrade');
    expect(promptForInstallConfirmation).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('declined install continues without spawn', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('source');
    mocks.promptForInstallConfirmation.mockResolvedValue(false);
    const { options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('warns and continues when spawn exits non-zero, without claiming success', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('source');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mockSpawnExit(1);
    const { stdout, stderr, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stderr.join('')).toContain('警告：更新失败');
    // A failed install must never print the "Updated …" success line.
    expect(stdout.join('')).not.toContain('已更新至');
  });

  it('tracks update_prompted telemetry', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('source');
    mocks.promptForInstallConfirmation.mockResolvedValue(false);
    const { options } = captureOutput();
    const track = vi.fn();
    await runUpdatePreflight('0.4.0', { ...options, track });
    expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
      current: '0.4.0',
      latest: '0.5.0',
      decision: 'prompt-install',
      source: 'source',
    }));
  });
});
