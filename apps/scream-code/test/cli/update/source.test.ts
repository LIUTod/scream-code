import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { detectInstallSource } from '#/cli/update/source';

describe('detectInstallSource', () => {
  it('returns source when the install directory contains a .git directory', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.scream-code',
        existsSync: (path: string) => path === '/home/user/.scream-code/.git',
      }),
    ).toBe('source');
  });

  it('returns source for the legacy ~/.scream-code path even when SCREAM_CODE_HOME points elsewhere', () => {
    const legacyGitDir = `${homedir()}/.scream-code/.git`;

    expect(
      detectInstallSource({
        getInstallDir: () => '/custom/path',
        existsSync: (path: string) => path === legacyGitDir,
      }),
    ).toBe('source');
  });

  it('returns unsupported when no .git directory is found', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.scream-code',
        existsSync: () => false,
      }),
    ).toBe('unsupported');
  });

  it('returns unsupported when only the install dir exists without .git', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.scream-code',
        existsSync: (path: string) => path === '/home/user/.scream-code',
      }),
    ).toBe('unsupported');
  });
});
