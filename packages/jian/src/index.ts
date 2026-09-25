export type { StatResult } from './types';
export type { JianProcess } from './process';
export type { Jian } from './jian';
export type {
  Environment,
  EnvironmentDeps,
  OsKind,
  ShellName,
} from './environment';
export { detectEnvironment, detectEnvironmentFromNode } from './environment';
export {
  JianError,
  JianValueError,
  JianFileExistsError,
  JianPathOutsideRootError,
  JianShellNotFoundError,
  JianExecError,
} from './errors';
export { LocalJian } from './local';
// The `cmd.exe /s /c` quoting for a batch shim, for callers that have to build
// the same line themselves (see `packages/jian/src/local.ts`): the CLI's `npm`
// launch plan spawns `npm.cmd` through `cmd.exe` on Windows and reuses this
// instead of carrying a second copy of the rules.
export { buildCmdCommandLine } from './local';
export {
  detachedForProcessTree,
  isWindowsPlatform,
  killProcessTree,
  type KillProcessTreeOptions,
} from './platform';
export {
  chdir,
  exec,
  execWithEnv,
  getCurrentJian,
  getcwd,
  gethome,
  glob,
  iterdir,
  mkdir,
  normpath,
  pathClass,
  readBytes,
  readLines,
  readText,
  realpath,
  runWithJian,
  setCurrentJian,
  stat,
  writeBytes,
  writeText,
} from './current';
