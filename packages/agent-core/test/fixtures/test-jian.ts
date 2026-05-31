import { LocalJian, type Environment } from '@scream-cli/jian';

export const TEST_OS_ENV: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

// `LocalJian`'s constructor is `private` at the TS level only — at runtime
// it's just a function. Skip the singleton/async detection path and build a
// fresh instance with a stub `osEnv` so test helpers can hand a real Jian
// directly to `RuntimeConfig`.
type LocalJianCtor = new (osEnv: Environment) => LocalJian;
export const testJian: LocalJian = new (LocalJian as unknown as LocalJianCtor)(TEST_OS_ENV);
