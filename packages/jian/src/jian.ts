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
  /** Return the physical path, optionally resolving through the nearest existing ancestor. */
  realpath(path: string, options?: { allowMissing?: boolean }): Promise<string>;
  /** Return stat metadata for `path`. */
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult>;
  /** Yield entry names in the directory at `path`. */
  iterdir(path: string): AsyncGenerator<string>;
  /**
   * Yield paths matching `pattern` under `path`.
   *
   * `exclude` is a list of entry *basenames* to prune: an entry whose
   * readdir name is in the list is neither descended into nor yielded
   * (exact, case-sensitive match). It exists so callers can skip
   * well-known heavy trees — `.git`, `node_modules` — without paying a
   * `stat` per entry. Omitted (or empty) prunes nothing, and the walk
   * root itself is never tested, so an explicitly addressed root is
   * always walked.
   *
   * `signal` cooperatively cancels the walk: it is polled once per directory
   * and once per directory entry, and an aborted walk ends by returning like
   * an exhausted one — the consumer's `for await` finishes, no exception is
   * thrown. Omitted → unchanged behaviour, so callers that never abandon a
   * walk can ignore it.
   *
   * A single walk enters each *physical* directory at most twice (see
   * `MAX_PHYSICAL_REVISITS` in `local.ts`); a symlink farm therefore costs
   * O(physical tree) rather than O(number of alias paths).
   */
  glob(
    path: string,
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      allowedRoots?: readonly string[];
      exclude?: readonly string[];
      signal?: AbortSignal;
    },
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
  /**
   * Yield lines from the file at `path` one by one, applying the same `errors`
   * and leading-BOM handling as `readText`.
   */
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
  /**
   * Write text to `path` atomically (temp file + rename), returning the
   * number of characters written.
   *
   * Plain `writeText` truncates the target before the new bytes land, so a
   * process killed mid-write leaves a truncated file behind. The temp-file +
   * rename swap is all-or-nothing: after a crash the reader sees either the
   * old content or the new content, never a partial one. The temp file is
   * created next to the target so the rename never crosses filesystems.
   *
   * A failed write or rename may leave the uniquely named temp file behind;
   * it is inert and safe to ignore or clean up. Because the swap replaces
   * the target inode, a rewritten file's permissions follow the process
   * umask (the same trade-off the session store's atomic state swap makes),
   * and a symlink at the target is replaced rather than written through.
   */
  writeTextAtomic(path: string, data: string, options?: { encoding?: BufferEncoding }): Promise<number>;
  /** Create a directory at `path`. */
  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void>;

  // ── Process execution ───────────────────────────────────────────────

  /** Spawn a process with the given arguments. */
  exec(...args: string[]): Promise<JianProcess>;
  /** Spawn a process with explicit environment variables. */
  execWithEnv(args: string[], env?: Record<string, string>): Promise<JianProcess>;
}
