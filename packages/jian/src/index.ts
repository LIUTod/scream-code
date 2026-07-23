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
