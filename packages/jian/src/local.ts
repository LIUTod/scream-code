import { createReadStream } from 'node:fs';

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  realpath as fsRealpath,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'pathe';
import type { Readable, Writable } from 'node:stream';

import { detectEnvironmentFromNode, type Environment } from './environment';
import { JianFileExistsError, JianPathOutsideRootError, JianExecError } from './errors';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal';
import type { Jian } from './jian';
import type { JianProcess } from './process';
import type { StatResult } from './types';

/**
 * Environment variables that spawned processes are allowed to inherit from the
 * parent process. All other variables are stripped to prevent accidental secret
 * leakage (e.g. cloud tokens, API keys, SSH agent sockets) into agent-executed
 * commands. Explicit env values passed by callers can still add or override keys.
 */
const ALLOWED_INHERITED_ENV_KEYS: readonly string[] = [
  // Shell / execution
  'PATH',
  'PATHEXT',
  'SHELL',
  'ComSpec',
  // User / home
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Locale / terminal
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  // Temp dirs
  'TMPDIR',
  'TEMP',
  'TMP',
  // Windows / XDG dirs
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  // Git / SCM
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  // scream-specific
  'SCREAM_PID',
];


const isWindows: boolean = process.platform === 'win32';

/**
 * True if `candidate` is `base` itself or a descendant of `base`, compared on
 * path-component boundaries. Both paths must already be normalized. This is a
 * lexical check only; it does not resolve symlinks.
 */
function isWithinDirectory(candidate: string, base: string): boolean {
  const normalizedCandidate = normalize(candidate);
  const normalizedBase = normalize(base);
  const comparableCandidate = isWindows ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const comparableBase = isWindows ? normalizedBase.toLowerCase() : normalizedBase;
  if (comparableCandidate === comparableBase) return true;
  const prefix = comparableBase.endsWith('/') ? comparableBase : `${comparableBase}/`;
  return comparableCandidate.startsWith(prefix);
}

/**
 * Build a sanitized environment for child processes. Inherits only an explicit
 * allowlist of ambient variables, then applies caller-supplied overrides.
 */
function buildSafeEnv(explicit: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (explicit !== undefined) {
    for (const [key, value] of Object.entries(explicit)) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Build the `(dev, ino)` cycle-detection key used by `_globWalk`'s
 * visited set. Returns `null` when `ino` is 0, which Node returns on
 * filesystems that don't carry inodes (Windows FAT/exFAT, some SMB/NFS
 * mounts). A null key signals "no reliable identity for this dir" so
 * the caller skips visited tracking for that descent — cycle safety
 * is weakened on those filesystems, but normal walking works instead
 * of every directory colliding on the shared key `"<dev>:0"`.
 */
function cycleKey(s: { dev: number; ino: number }): string | null {
  if (s.ino === 0) return null;
  return `${String(s.dev)}:${String(s.ino)}`;
}
// NOTE: LocalProcess has no auto-kill on dispose. On POSIX with detached:true,
// a discarded reference leaves the child orphaned (reparented to init).
// Callers must explicitly kill() or wait() before dropping the reference.


class LocalProcess implements JianProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;

  constructor(child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Process must be created with stdin/stdout/stderr pipes.');
    }

    this._child = child;
    this.stdin = child.stdin;
    this.stdout = new BufferedReadable(child.stdout);
    this.stderr = new BufferedReadable(child.stderr);
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    // Reject if the process never actually started (spawn failed).
    // pid <= 0 indicates ChildProcess.pid was undefined, which happens
    // when spawn() fails to find/execute the command. Calling
    // process.kill(-1, ...) on POSIX would signal the entire process
    // group, potentially killing unrelated processes.
    if (this.pid <= 0) {
      return Promise.resolve();
    }

    // On Windows, `ChildProcess.kill()` only signals the shell parent, leaving
    // grandchildren alive. Use `taskkill /T` so the caller's graceful and force
    // kill phases apply to the whole process tree.
    if (isWindows) {
      const useForce = signal === 'SIGKILL';
      const taskkillArgs = useForce
        ? ['/T', '/F', '/PID', String(this.pid)]
        : ['/T', '/PID', String(this.pid)];
      return new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill', taskkillArgs, {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', (err) => {
          reject(new Error(`taskkill failed to start: ${err.message}`));
        });
        killer.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`taskkill exited with code ${code ?? 'null'}`));
        });
        killer.unref();
      });
    }

    // On POSIX, `detached:true` makes the child a process-group leader
    // (pgid === pid). A plain `ChildProcess.kill()` still only signals the
    // direct child, so a shell like `bash -c 'sleep 100 & sleep 100'` leaves
    // grandchildren orphaned. `process.kill(-pid, signal)` signals the group
    // (negative pid = process-group id under POSIX kill(2)).
    try {
      process.kill(-this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // ESRCH = group already gone (child exited + reaped between
      // `wait()` racing spawn + this call). Treat as successful kill.
      if (err.code === 'ESRCH') return Promise.resolve();
      // EPERM is typically a misconfiguration (e.g. non-detached
      // spawn earlier in the file); fall back to direct `.kill()` so
      // we at least signal the direct child instead of throwing.
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal ?? 'SIGTERM');
        } catch {
          /* best effort */
        }
        return Promise.resolve();
      }
      throw error;
    }
    return Promise.resolve();
  }
}

/**
 * A JIAN implementation that directly interacts with the local filesystem.
 *
 * Note: LocalJian maintains its own per-instance working directory (`_cwd`)
 * rather than mutating `process.cwd()`. This lets multiple LocalJian instances
 * coexist with independent cwds (e.g. when switching contexts via
 * `runWithJian`) without cross-polluting each other's relative-path resolution.
 */
export class LocalJian implements Jian {
  readonly name: string = 'local';
  readonly osEnv: Environment;
  private _cwd: string;
  private readonly _rootDir: string | undefined;

  private constructor(osEnv: Environment, cwd?: string, rootDir?: string) {
    // After construction we never touch `process.cwd()` / `process.chdir()`
    // — all path resolution goes through `this._cwd`. The default seeds
    // from `process.cwd()` but callers can pin to anything via `withCwd`
    // (or supplying `cwd` directly).
    this._cwd = normalize(cwd ?? process.cwd());
    // Optional trust boundary for filesystem operations. When set, all file
    // paths resolved by this instance must stay within `_rootDir`. By default
    // no boundary is enforced so `LocalJian` remains a general-purpose local
    // filesystem abstraction; callers that need a sandbox (e.g. an agent
    // workspace) can supply `rootDir` or use `withCwd`, which narrows the
    // boundary to the new cwd.
    this._rootDir = rootDir === undefined ? undefined : normalize(rootDir);
    this.osEnv = osEnv;
  }

  /**
   * Construct a fresh `LocalJian` after probing the host environment.
   *
   * Each call returns a new instance with its own `_cwd`; concurrent
   * callers can therefore operate on independent working directories
   * without polluting one another.
   */
  static async create(cwd?: string, rootDir?: string): Promise<LocalJian> {
    const osEnv = await detectEnvironmentFromNode();
    return new LocalJian(osEnv, cwd, rootDir);
  }

  withCwd(cwd: string): LocalJian {
    // Preserve the same root trust boundary so a sandboxed instance cannot be
    // widened by simply changing the working directory. If the new cwd falls
    // outside the boundary, subsequent file operations will fail until the
    // caller supplies an in-root path.
    return new LocalJian(this.osEnv, cwd, this._rootDir);
  }

  private _resolvePath(path: string): string {
    const resolved = isAbsolute(path) ? normalize(path) : join(this._cwd, path);
    this._assertWithinRoot(resolved);
    return resolved;
  }

  private _assertWithinRoot(resolvedPath: string): void {
    if (this._rootDir === undefined) return;
    if (isWithinDirectory(resolvedPath, this._rootDir)) return;
    throw new JianPathOutsideRootError(
      `Path outside allowed root directory: ${resolvedPath}`,
      resolvedPath,
      this._rootDir,
    );
  }

  /** Resolve path for sandboxed operations — lexical check + realpath. */
  private async _resolveSandboxedPath(path: string): Promise<string> {
    const lexical = isAbsolute(path) ? normalize(path) : join(this._cwd, path);
    if (!isWithinDirectory(lexical, this._rootDir!)) {
      throw new JianPathOutsideRootError(
        `Path outside allowed root directory: ${lexical}`,
        lexical,
        this._rootDir!,
      );
    }
    const realPath = await fsRealpath(lexical);
    const realRoot = await fsRealpath(this._rootDir!);
    if (!isWithinDirectory(realPath, realRoot)) {
      throw new JianPathOutsideRootError(
        `Path outside allowed root directory (via symlink): ${lexical}`,
        lexical,
        this._rootDir!,
      );
    }
    return realPath;
  }

  pathClass(): 'posix' | 'win32' {
    return isWindows ? 'win32' : 'posix';
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return normalize(homedir());
  }

  getcwd(): string {
    return this._cwd;
  }

  /**
   * Change the working directory of this LocalJian instance.
   *
   * Unlike Python's `os.chdir`, this is instance-scoped and never touches
   * `process.cwd()`. Child processes spawned via {@link exec} inherit this
   * instance's `_cwd`; concurrent LocalJian instances each carry their own
   * independent cwd. If you need Python-compatible process-global cwd,
   * call `process.chdir(x)` directly.
   */
  async chdir(path: string): Promise<void> {
    const resolved = this._rootDir !== undefined
      ? await this._resolveSandboxedPath(path)
      : this._resolvePath(path);
    const s = await stat(resolved);
    if (!s.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this._cwd = resolved;
  }

  async realpath(path: string, options?: { allowMissing?: boolean }): Promise<string> {
    const lexical = this._resolvePath(path);
    try {
      return normalize(await fsRealpath(lexical));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!options?.allowMissing || (code !== 'ENOENT' && code !== 'ENOTDIR')) throw error;
    }

    const missingSegments: string[] = [];
    let ancestor = lexical;
    while (true) {
      try {
        await lstat(ancestor);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        missingSegments.push(basename(ancestor));
        ancestor = parent;
        continue;
      }

      // The ancestor exists. A failure here means it is inaccessible or a
      // dangling symlink, not a normal missing leaf, so fail closed.
      const physicalAncestor = normalize(await fsRealpath(ancestor));
      return normalize(join(physicalAncestor, ...missingSegments.toReversed()));
    }
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const followSymlinks = options?.followSymlinks ?? true;
    const resolved = this._rootDir !== undefined && followSymlinks
      ? await this._resolveSandboxedPath(path)
      : this._resolvePath(path);
    const s = followSymlinks ? await stat(resolved) : await lstat(resolved);
    return {
      stMode: s.mode,
      stIno: s.ino,
      stDev: s.dev,
      stNlink: s.nlink,
      stUid: s.uid,
      stGid: s.gid,
      stSize: s.size,
      stAtime: s.atimeMs / 1000,
      stMtime: s.mtimeMs / 1000,
      stCtime: isWindows ? s.birthtimeMs / 1000 : s.ctimeMs / 1000,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await readdir(resolved);
    for (const entry of entries) {
      // Use join so root paths like "/" or "C:\\" don't produce "//entry"
      // or "C:\\\\entry" — join normalizes trailing separators correctly.
      yield join(resolved, entry);
    }
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean; allowedRoots?: readonly string[] },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    const physicalAllowedRoots = options?.allowedRoots === undefined
      ? undefined
      : await Promise.all(options.allowedRoots.map((root) => this.realpath(root, { allowMissing: true })));
    if (!(await this._isWithinPhysicalRoots(resolved, physicalAllowedRoots))) return;
    // NOTE: patterns are split on '/' only. Windows users passing `**\\*.txt`
    // get a single segment — backslashes are treated literally. Use POSIX-style.
    const patternParts = pattern.split('/');
    // Seed `visited` with basePath's own inode so that a symlink inside
    // basePath that points back at basePath is caught on its first
    // encounter (not on the second level — the "+1 depth" off-by-one
    // that would otherwise leak if the caller globs directly from the
    // loop root). `stat` failure here is tolerated: `_globWalk` will
    // hit the same error via readdir and return empty.
    const initVisited = new Set<string>();
    try {
      const rootStat = await stat(resolved);
      const rootKey = cycleKey(rootStat);
      if (rootKey !== null) initVisited.add(rootKey);
    } catch {
      // base does not exist / not accessible — walker handles via its own catch
    }
    yield* this._globWalk(
      resolved,
      patternParts,
      caseSensitive,
      initVisited,
      physicalAllowedRoots,
    );
  }

  // `visited` holds the `(stDev, stIno)` keys of directories on the
  // current descent path. Before recursing into a subdirectory, we
  // check its key against `visited`; if present we skip it (cycle
  // detected) and otherwise recurse with a fresh Set containing the
  // additional key. The per-recurse copy gives the check path-local
  // semantics: two legitimate symlinks to the same target in separate
  // branches both traverse, which is more permissive than Python stdlib
  // while still cycle-safe.
  // Same-directory self-recursion (e.g. `**` matching zero dirs with
  // pattern tail) passes `visited` unchanged — no descent, no cycle
  // risk.
  //
  // Windows note: Node's `fs.Stats.ino` returns `0` on filesystems
  // that don't support inodes (FAT/exFAT, some SMB/NFS mounts). If we
  // keyed on `ino=0`, every directory on such a drive would share the
  // key `"<dev>:0"` and the first would "visit" all others. The
  // module-level `cycleKey` helper returns `null` in that case, which
  // causes the call sites to skip visited tracking for that descent
  // — cycle safety is lost on those filesystems, but normal walking
  // works.
  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
    visited: Set<string>,
    physicalAllowedRoots: readonly string[] | undefined,
  ): AsyncGenerator<string> {
    if (!(await this._isWithinPhysicalRoots(basePath, physicalAllowedRoots))) return;
    if (patternParts.length === 0) {
      return;
    }

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      // `**` matches zero or more directory components.
      //
      // There are exactly two cases to handle:
      //   (a) `**` matches zero directories → continue at basePath with the
      //       remaining pattern parts (or yield basePath itself when `**`
      //       is the final segment).
      //   (b) `**` matches one or more directories → recurse into each
      //       subdirectory, keeping `**` (i.e. the full patternParts) at
      //       the front. The "zero directories" case is then re-evaluated
      //       at the subdirectory level by that recursive call.
      //
      // We must NOT additionally recurse with `remainingParts` on
      // subdirectories — that would double-count every match at depth ≥ 1
      // because case (a) inside the child recursion already yields those
      // results.
      if (remainingParts.length > 0) {
        yield* this._globWalk(
          basePath,
          remainingParts,
          caseSensitive,
          visited,
          physicalAllowedRoots,
        );
      } else {
        // Pattern ends with `**`: yield basePath itself (zero-dir match).
        yield basePath;
      }

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        // Use join to avoid "//entry" when basePath is a filesystem root.
        const fullPath = join(basePath, entry);
        if (this._rootDir && !isWithinDirectory(fullPath, this._rootDir)) continue;
        let entryStat;
        try {
          entryStat = await stat(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          const key = cycleKey(entryStat);
          if (key !== null && visited.has(key)) continue;
          yield* this._globWalk(
            fullPath,
            patternParts,
            caseSensitive,
            key !== null ? new Set([...visited, key]) : visited,
            physicalAllowedRoots,
          );
        } else if (
          remainingParts.length === 0 &&
          (await this._isWithinPhysicalRoots(fullPath, physicalAllowedRoots))
        ) {
          // Pattern ends with `**`: non-directory entries match too
          // (since `**` matches "anything").
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!regex.test(entry)) {
          continue;
        }

        // Use join to avoid "//entry" when basePath is a filesystem root.
        const fullPath = join(basePath, entry);
        if (this._rootDir && !isWithinDirectory(fullPath, this._rootDir)) continue;
        if (remainingParts.length === 0) {
          if (await this._isWithinPhysicalRoots(fullPath, physicalAllowedRoots)) {
            yield fullPath;
          }
        } else {
          let entryStat;
          try {
            entryStat = await stat(fullPath);
          } catch {
            continue;
          }
          if (entryStat.isDirectory()) {
            const key = cycleKey(entryStat);
            if (key !== null && visited.has(key)) continue;
            yield* this._globWalk(
              fullPath,
              remainingParts,
              caseSensitive,
              key !== null ? new Set([...visited, key]) : visited,
              physicalAllowedRoots,
            );
          }
        }
      }
    }
  }

  private async _isWithinPhysicalRoots(
    path: string,
    physicalAllowedRoots: readonly string[] | undefined,
  ): Promise<boolean> {
    if (physicalAllowedRoots === undefined) return true;
    try {
      const physicalPath = normalize(await fsRealpath(path));
      return physicalAllowedRoots.some((root) => isWithinDirectory(physicalPath, root));
    } catch {
      return false;
    }
  }

  async readBytes(path: string, n?: number): Promise<Buffer> {
    const resolved = this._resolvePath(path);
    if (n === undefined) {
      return Buffer.from(await readFile(resolved));
    }
    const fh = await open(resolved, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await readFile(resolved);
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const stream = createReadStream(resolved, { encoding, highWaterMark: 64 * 1024 });
    let remainder = '';
    try {
      for await (const chunk of stream) {
        const lines = (remainder + (chunk as string)).split('\n');
        remainder = lines.pop() ?? '';
        for (const line of lines) {
          yield line + '\n';
        }
      }
    } finally {
      stream.destroy();
    }
    if (remainder !== '') {
      yield remainder;
    }
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    const resolved = this._resolvePath(path);
    await writeFile(resolved, data);
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const mode = options?.mode ?? 'w';
    if (mode === 'a') {
      await appendFile(resolved, data, encoding);
    } else {
      await writeFile(resolved, data, encoding);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;

    if (parents) {
      // `fs.mkdir(..., { recursive: true })` silently succeeds when the
      // target already exists — it does NOT raise EEXIST. To honor the
      // `existOk: false` semantics, we must probe for existence ourselves
      // before delegating to the recursive mkdir.
      // NOTE: there is a TOCTOU between the existence probe and the recursive
      // mkdir. A concurrent creator that makes the directory in between causes
      // mkdir to succeed silently, violating existOk:false.
      if (!existOk) {
        try {
          const s = await stat(resolved);
          if (s.isDirectory()) {
            throw new JianFileExistsError(`${resolved} already exists`);
          }
          // Path exists but is not a directory — let `mkdir` surface the
          // appropriate error (EEXIST/ENOTDIR) below.
        } catch (error: unknown) {
          if (error instanceof JianFileExistsError) throw error;
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') throw error;
          // ENOENT: target doesn't exist yet — proceed to mkdir.
        }
      }
      await mkdir(resolved, { recursive: true });
      return;
    }

    // Non-recursive: fs.mkdir naturally throws EEXIST on collision.
    try {
      await mkdir(resolved);
    } catch (error: unknown) {
      if (
        existOk &&
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        // `existOk` only applies when the conflicting path is itself a
        // directory. If a regular file (or other non-directory) already
        // occupies the path, silently returning would be a lie — the
        // requested directory still does not exist. Surface the conflict
        // explicitly so callers cannot mistake "file collision" for
        // "directory already present".
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          throw new JianFileExistsError(`${resolved} already exists but is not a directory`);
        }
        return;
      }
      throw error;
    }
  }

  async exec(...args: string[]): Promise<JianProcess> {
    return this.execWithEnv(args, undefined);
  }

  async execWithEnv(args: string[], env?: Record<string, string>): Promise<JianProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error(
        'LocalJian.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    const restArgs = args.slice(1);
    const child = spawn(command, restArgs, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      env: buildSafeEnv(env),
    });
    try {
      await waitForSpawn(child);
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new JianExecError(
          `Failed to spawn ${command}: ${error.message}`,
          command,
          (error as NodeJS.ErrnoException).code,
        );
      }
      throw error;
    }
    return new LocalProcess(child);
  }
}

// Wait for a freshly spawned ChildProcess to either emit 'spawn' (success) or
// 'error' (ENOENT / EACCES / etc.). Until this resolves, callers should not
// assume the child is running — they may otherwise write to the stdin of a
// process that never existed.
function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
