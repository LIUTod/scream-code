import { installLatestArgs, globalPrefixForScream } from '#/cli/update/prefix';
import { afterEach, describe, expect, it } from 'vitest';

describe('globalPrefixForScream', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('resolves the prefix from a user-global install path', () => {
    process.argv = [
      'node',
      '/Users/tod/.npm-global/lib/node_modules/scream-code/dist/main.mjs',
    ];
    expect(globalPrefixForScream()).toBe('/Users/tod/.npm-global');
  });

  it('resolves the prefix from a system-global install path', () => {
    process.argv = [
      'node',
      '/usr/local/lib/node_modules/scream-code/dist/main.mjs',
    ];
    expect(globalPrefixForScream()).toBe('/usr/local');
  });

  it('returns undefined for an unrecognized layout', () => {
    process.argv = ['node', '/Users/tod/dev/scream-code/dist/main.mjs'];
    expect(globalPrefixForScream()).toBeUndefined();
  });

  it('returns undefined when there is no entry script', () => {
    process.argv = ['node'];
    expect(globalPrefixForScream()).toBeUndefined();
  });
});

describe('installLatestArgs', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('includes --prefix when the global prefix is resolvable', () => {
    process.argv = [
      'node',
      '/Users/tod/.npm-global/lib/node_modules/scream-code/dist/main.mjs',
    ];
    expect(installLatestArgs()).toEqual([
      'install',
      '-g',
      'scream-code@latest',
      '--prefix',
      '/Users/tod/.npm-global',
    ]);
  });

  it('omits --prefix for an unrecognized layout', () => {
    process.argv = ['node', '/Users/tod/dev/scream-code/dist/main.mjs'];
    expect(installLatestArgs()).toEqual(['install', '-g', 'scream-code@latest']);
  });
});
