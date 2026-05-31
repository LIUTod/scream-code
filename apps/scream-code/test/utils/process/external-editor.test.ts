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
});
