/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  rmCalls: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      mocks.rmCalls(...args);
      return actual.rm(...args);
    },
  };
});

import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

function shellPath(cmd: string): string {
  const match = cmd.match(/'([^']+)'$/);
  if (!match) throw new Error(`Could not parse temp path from: ${cmd}`);
  return match[1]!;
}

function cmdPath(commandLine: string): string {
  const match = commandLine.match(/"([^"]+)"{1,2}$/);
  if (!match) throw new Error(`Could not parse temp path from: ${commandLine}`);
  return match[1]!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('external-editor helpers', () => {
  it('prefers configured editor, then VISUAL, then EDITOR', () => {
    vi.stubEnv('VISUAL', 'nvim');
    vi.stubEnv('EDITOR', 'vim');

    expect(resolveEditorCommand('code --wait')).toBe('code --wait');
    expect(resolveEditorCommand(null)).toBe('nvim');
    vi.stubEnv('VISUAL', '');
    expect(resolveEditorCommand()).toBe('vim');
  });

  it('returns the edited contents on success and cleans up the temp directory', async () => {
    mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const child = new EventEmitter();
      void writeFile(shellPath(args[1]!), 'edited text', 'utf8').then(() => {
        child.emit('exit', 0);
      });
      return child as never;
    });

    await expect(editInExternalEditor('seed', 'code --wait')).resolves.toBe('edited text');
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', expect.stringMatching(/^code --wait /)],
      { stdio: 'inherit' },
    );
    expect(mocks.rmCalls).toHaveBeenCalled();
  });

  it('returns undefined when the editor exits non-zero', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 1));
      return child as never;
    });

    await expect(editInExternalEditor('seed', 'false')).resolves.toBeUndefined();
  });

  it('runs the editor through cmd.exe on Windows, without POSIX quoting', async () => {
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe');
    mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const child = new EventEmitter();
      void writeFile(cmdPath(args[3]!), 'edited on windows', 'utf8').then(() => {
        child.emit('exit', 0);
      });
      return child as never;
    });

    await expect(editInExternalEditor('seed', 'code --wait', 'win32')).resolves.toBe(
      'edited on windows',
    );

    const call = mocks.spawn.mock.calls[0]!;
    expect(call[0]).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(call[0]).not.toBe('/bin/sh');
    expect(call[1]!.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(call[2]).toEqual({ stdio: 'inherit', windowsVerbatimArguments: true });
    // cmd.exe only strips the outer quotes; the single quotes of the POSIX
    // branch are ordinary characters there and must not appear.
    expect(call[1]![3]).toMatch(/^"code --wait "/);
    expect(call[1]![3]).not.toContain("'");
  });

  it('falls back to bare cmd.exe when ComSpec is unset or empty', async () => {
    vi.stubEnv('ComSpec', '');
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 1));
      return child as never;
    });

    await expect(editInExternalEditor('seed', 'vim', 'win32')).resolves.toBeUndefined();
    expect(mocks.spawn.mock.calls[0]![0]).toBe('cmd.exe');
  });
});
