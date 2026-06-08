import type { Environment } from './environment';
import type { JianProcess } from './process';
import type { StatResult } from './types';

/**
 * Scream Agent Operating System (JIAN) interface.
 *
 * This is the core abstraction that allows the agent to interact with
 * different execution environments (local, SSH, containers, etc.)
 * through a unified API.
 */
export interface Jian {
  /** Human-readable name for this environment (e.g. `"local"`, `"ssh:host"`). */
  readonly name: string;

  /**
   * OS / shell probe describing the target environment. Populated by the
   * concrete Jian implementation (e.g. `detectEnvironmentFromNode()` for
   * `LocalJian`).
   */
  readonly osEnv: Environment;

  // ── Path operations (sync) ──────────────────────────────────────────

  /** Return the path style used by this environment. */
  pathClass(): 'posix' | 'win32';
  /** Normalize the given path string (resolve `.` / `..` segments). */
  normpath(path: string): string;
  /** Return the home directory of the current user. */
  gethome(): string;
  /** Return the current working directory. */
  getcwd(): string;

  // ── Directory operations (async) ────────────────────────────────────

  /** Change the working directory to `path`. */
  chdir(path: string): Promise<void>;
  /** Return a new Jian with the given `cwd`. */
  withCwd(cwd: string): Jian;
  /** Return stat metadata for `path`. */
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult>;
  /** Yield entry names in the directory at `path`. */
  iterdir(path: string): AsyncGenerator<string>;
  /** Yield paths matching `pattern` under `path`. */
  glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string>;

  // ── File operations (async) ─────────────────────────────────────────

  /** Read up to `n` bytes from `path` (all bytes if `n` is omitted). */
  readBytes(path: string, n?: number): Promise<Buffer>;
  /**
   * Read the file at `path` as a string.
   *
   * `errors` controls how decode errors are handled — mirrors Python's
   * `open(..., errors=)` parameter:
   * - `'strict'` (default): throw on any invalid byte for the encoding
   * - `'replace'`: substitute each invalid byte with U+FFFD (REPLACEMENT CHARACTER)
   * - `'ignore'`: drop invalid bytes silently
   */
  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string>;
  /** Yield lines from the file at `path` one by one. */
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string>;
  /** Write raw bytes to `path`, returning the number of bytes written. */
  writeBytes(path: string, data: Buffer): Promise<number>;
  /** Write text to `path`, returning the number of characters written. */
  writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number>;
  /** Create a directory at `path`. */
  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void>;

  // ── Process execution ───────────────────────────────────────────────

  /** Spawn a process with the given arguments. */
  exec(...args: string[]): Promise<JianProcess>;
  /** Spawn a process with explicit environment variables. */
  execWithEnv(args: string[], env?: Record<string, string>): Promise<JianProcess>;
}
