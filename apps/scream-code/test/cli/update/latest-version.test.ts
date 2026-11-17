import { describe, expect, it, vi } from 'vitest';

import { fetchLatestVersionFromNpm } from '#/cli/update/latest-version';

function mockExecFileOk(stdout: string): typeof import('node:child_process').execFile {
  const cb = (
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    callback(null, { stdout, stderr: '' });
  };
  return vi.fn(cb) as unknown as typeof import('node:child_process').execFile;
}

function mockExecFileFails(error: Error): typeof import('node:child_process').execFile {
  const cb = (
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    callback(error, { stdout: '', stderr: error.message });
  };
  return vi.fn(cb) as unknown as typeof import('node:child_process').execFile;
}

describe('fetchLatestVersionFromNpm', () => {
  it('returns the trimmed version from npm view output', async () => {
    const execFile = mockExecFileOk('0.5.0\n');
    await expect(fetchLatestVersionFromNpm(execFile)).resolves.toBe('0.5.0');
    expect(execFile).toHaveBeenCalledWith(
      'npm',
      ['view', 'scream-code', 'version'],
      expect.objectContaining({ timeout: expect.any(Number), maxBuffer: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('strips surrounding whitespace from npm output', async () => {
    await expect(fetchLatestVersionFromNpm(mockExecFileOk('  1.2.3\n'))).resolves.toBe('1.2.3');
  });

  it('throws when npm output is not valid semver', async () => {
    await expect(fetchLatestVersionFromNpm(mockExecFileOk('not-a-version'))).rejects.toThrow(/semver/);
  });

  it('throws when npm output is empty', async () => {
    await expect(fetchLatestVersionFromNpm(mockExecFileOk(''))).rejects.toThrow(/semver/);
  });

  it('propagates the underlying npm error', async () => {
    await expect(
      fetchLatestVersionFromNpm(mockExecFileFails(new Error('network down'))),
    ).rejects.toThrow(/network down/);
  });
});
