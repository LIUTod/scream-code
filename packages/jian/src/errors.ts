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
 * Thrown by `detectEnvironment` on Windows when no Git Bash install can be
 * located. Carries the list of paths that were probed so callers can include
 * them in install hints.
 */
export class JianShellNotFoundError extends JianError {
  constructor(message: string) {
    super(message);
    this.name = 'JianShellNotFoundError';
  }
}
