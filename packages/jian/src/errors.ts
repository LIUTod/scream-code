/**
 * Base error class for the jian package.
 */
export class JianError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JianError';
  }
}

/**
 * Equivalent to Python's ValueError — indicates an invalid argument was passed.
 */
export class JianValueError extends JianError {
  constructor(message: string) {
    super(message);
    this.name = 'JianValueError';
  }
}

/**
 * Equivalent to Python's FileExistsError — indicates a file or directory already exists.
 */
export class JianFileExistsError extends JianError {
  constructor(message: string) {
    super(message);
    this.name = 'JianFileExistsError';
  }
}

/**
 * Thrown by `detectEnvironment` on Windows when neither Git Bash nor
 * PowerShell can be located. Carries the list of paths that were probed so
 * callers can include them in install hints.
 */
export class JianShellNotFoundError extends JianError {
  constructor(message: string) {
    super(message);
    this.name = 'JianShellNotFoundError';
  }
}
/**
 * Thrown by `LocalJian` when a file operation would resolve outside the
 * instance's configured root directory. This is a last-line-of-defense guard;
 * higher-level path policies should still validate user-supplied paths first.
 */
export class JianPathOutsideRootError extends JianError {
  constructor(
    message: string,
    readonly path: string,
    readonly rootDir: string,
  ) {
    super(message);
    this.name = 'JianPathOutsideRootError';
  }
}

/** Thrown when process execution fails (spawn error, ENOENT, EACCES). */
export class JianExecError extends JianError {
  constructor(
    message: string,
    readonly command: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'JianExecError';
  }
}
