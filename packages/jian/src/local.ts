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
  rename,
  stat,
  realpath as fsRealpath,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'pathe';
import { join as joinNativePath } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { detectEnvironmentFromNode, type Environment } from './environment';
import { JianFileExistsError, JianPathOutsideRootError, JianExecError } from './errors';
import {
  BufferedReadable,
  decodeTextWithErrors,
  decodeUtf16LeIgnore,
  decodeUtf8Ignore,
  globPatternToRegex,
  utfTextDecoderLabel,
} from './internal';
import type { Jian } from './jian';
import { detachedForProcessTree, isWindowsPlatform, killProcessTree } from './platform';
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


/**
 * True if `candidate` is `base` itself or a descendant of `base`, compared on
 * path-component boundaries. Both paths must already be normalized. This is a
 * lexical check only; it does not resolve symlinks.
 *
 * `platform` decides whether the comparison folds case: Windows paths are
 * case-insensitive, POSIX paths are not.
 */
function isWithinDirectory(candidate: string, base: string, platform: string): boolean {
  const normalizedCandidate = normalize(candidate);
  const normalizedBase = normalize(base);
  const windows = isWindowsPlatform(platform);
  const comparableCandidate = windows ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const comparableBase = windows ? normalizedBase.toLowerCase() : normalizedBase;
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

/**
 * How many times one *physical* directory (same `dev:ino` key `cycleKey`
 * produces) may be entered during a single `glob` traversal.
 *
 * 2 = the directory's own place in the tree (the canonical descent) plus one
 * legitimate symlink alias pointing at the same target — the alias-following
 * behaviour the existing symlink tests pin (T-C2 / T-C6 in
 * `test/local.test.ts`). The 3rd and every later entry is skipped.
 *
 * Why a global bound on top of the path-local cycle set: path-local
 * detection only stops a directory from appearing twice *on one descent
 * path*. A symlink farm — pnpm's `node_modules/.pnpm`, where packages alias
 * each other in a dense graph — still admits an exponential number of
 * distinct alias paths to the same physical directories, each of which is
 * re-`readdir`-ed and re-`stat`-ed. That is what turns one `**` walk into
 * hours of CPU and tens of thousands of stats per second. With this bound
 * the work is O(MAX_PHYSICAL_REVISITS × physical tree): a physical directory
 * is traversed at most this many times, however many paths spell it.
 *
 * Trees with no revisit are untouched: the first entry of every directory is
 * always allowed, so a plain walk behaves exactly as it did before.
 */
const MAX_PHYSICAL_REVISITS = 2;

/**
 * Whether a cooperative-cancellation checkpoint should stop the walk.
 *
 * Wrapped in a helper rather than inlined as `signal?.aborted === true` so
 * control-flow narrowing cannot pin `aborted` to `false` after the first
 * checkpoint in a function body: the flag flips asynchronously, and every
 * later checkpoint must still be able to observe `true`.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Record one entry of the physical directory `key` for the current traversal.
 * Returns false when that directory has already been entered
 * `MAX_PHYSICAL_REVISITS` times, i.e. when this descent must be skipped.
 */
function enterPhysical(key: string, entries: Map<string, number>): boolean {
  const entered = entries.get(key) ?? 0;
  if (entered >= MAX_PHYSICAL_REVISITS) return false;
  entries.set(key, entered + 1);
  return true;
}

// NOTE: LocalProcess has no auto-kill on dispose. On POSIX with detached:true,
// a discarded reference leaves the child orphaned (reparented to init).
// Callers must explicitly kill() or wait() before dropping the reference.

const DEFAULT_PATHEXT: readonly string[] = ['.COM', '.EXE', '.BAT', '.CMD'];

/** Extensions Windows can only run through `cmd.exe`, never by direct exec. */
const CMD_SCRIPT_EXTENSIONS: readonly string[] = ['.bat', '.cmd'];

/** How one command reaches the OS. @internal for tests — see {@link windowsSpawnPlan}. */
export interface SpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  /** Only ever true for the `cmd.exe` launch below; see `buildCmdCommandLine`. */
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Windows spawn plan for `command`.
 *
 * Windows does not resolve a bare name to a runnable file the way POSIX does: a
 * shell walks `PATH` + `PATHEXT` and lands on `npm.cmd`, while Node's `spawn`
 * does not, which is why `spawn('npm')` fails on a host where `npm.cmd` works
 * in every terminal. This reproduces that resolution and then launches the
 * result the way the OS requires:
 *
 *   - anything runnable as-is (`.exe` / `.com` / extensionless) → spawned directly.
 *   - `.cmd` / `.bat` → through `cmd.exe /d /s /c`. A batch file is a script for
 *     `cmd`, so there is no direct-exec route — Node refuses to spawn one
 *     anyway (it rejects `.bat`/`.cmd` without `shell: true`). Handing a fully
 *     quoted command line to `cmd.exe` keeps argument parsing under our
 *     control, which is exactly why `shell: true` is not used: that would let
 *     Node re-tokenize the whole line for us, including the parts we build.
 *
 * The command line is built by {@link quoteCmdToken}, so a command or argument
 * that cannot be quoted for a batch file (an embedded `"` or line break)
 * rejects the call instead of being passed through — see there for why no
 * escaping exists.
 *
 * @internal for tests
 */
export async function windowsSpawnPlan(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<SpawnPlan> {
  const resolved = await resolveWindowsExecutable(
    command,
    env['PATH'],
    pathextExtensions(env['PATHEXT']),
  );
  if (!isCmdScript(resolved)) {
    return { command: resolved, args, windowsVerbatimArguments: false };
  }
  const comspec = env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/s', '/c', buildCmdCommandLine(resolved, args)],
    windowsVerbatimArguments: true,
  };
}

/** `PATHEXT` entries verbatim (Windows compares extensions case-insensitively); its own default when unset/empty. */
function pathextExtensions(pathext: string | undefined): readonly string[] {
  const entries = (pathext ?? '')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return entries.length > 0 ? entries : DEFAULT_PATHEXT;
}

function isCmdScript(path: string): boolean {
  const lower = path.toLowerCase();
  return CMD_SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Find the runnable file `command` names, trying the literal name first and then
 * every `PATHEXT` suffix in order (the order a shell uses). A name containing a
 * separator is a path rather than a `PATH` lookup, but Windows still appends
 * `PATHEXT` candidates to it, so the candidate list is the same.
 *
 * Throws a readable `JianExecError` naming the command and every name that was
 * tried, because the bare `ENOENT` a raw `spawn` produces names neither the
 * suffixes nor the search roots.
 */
async function resolveWindowsExecutable(
  command: string,
  pathEnv: string | undefined,
  extensions: readonly string[],
): Promise<string> {
  const isPath = /[\\/]/.test(command);
  const searchDirs = isPath ? [''] : pathDirectories(pathEnv);
  const names = [command, ...extensions.map((extension) => `${command}${extension}`)];
  for (const dir of searchDirs) {
    for (const name of names) {
      // Joined with the *host* separator, not a hard-coded `\`: the separator
      // that makes the candidate a real path is the one this process's
      // filesystem understands, which is `\` on Windows and `/` in an
      // emulated-Windows test on another host.
      const candidate = joinNativePath(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
  }
  const roots = isPath ? 'the path given in the command' : `PATH (${pathEnv ?? ''})`;
  throw new JianExecError(
    `Command not found: ${command}. Searched ${roots} for ${names.join(', ')}.`,
    command,
    'ENOENT',
  );
}

function pathDirectories(pathEnv: string | undefined): readonly string[] {
  return (pathEnv ?? '')
    .split(';')
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Quote one token for a `cmd.exe /s /c` command line.
 *
 * Batch files are interpreted by `cmd`, so anything reaching a `.cmd` shim is
 * subject to cmd metacharacters. Wrapping a token that carries whitespace or a
 * metacharacter in double quotes keeps `&` / `|` / `<` / `>` from starting a
 * second command — which is the entire job of this helper, because `shell: true`
 * is deliberately not used and nothing else would quote these tokens.
 *
 * A token containing `"` is refused, not escaped. `\` is not an escape
 * character in `cmd`; `"` *toggles* the quoting state, so a `\"` closes the
 * quoted region early and leaves the rest of the token outside it — an `&` that
 * follows then reaches `cmd` as a real command separator and the remainder runs
 * as a second command at the caller's privilege. There is no quoted form of a
 * `"` that survives a batch shim, so the only safe answer is to fail closed.
 * CR/LF are refused for the same reason: they end the line `cmd.exe /c` parses,
 * turning the rest into further commands.
 *
 * `%VAR%` is expanded by `cmd` *inside* the quotes. That is inherent to invoking
 * a batch file and cannot be escaped away; not masking it is the honest form,
 * and the alternative would be refusing to run `npm`, `pnpm` and every other
 * shim shipped as a `.cmd`.
 *
 * An empty token is quoted too: it is still one argument slot, and collapsing it
 * to nothing would shift every argument that follows (`install -g ''` would
 * become `install -g`).
 */
function quoteCmdToken(token: string): string {
  if (/["\r\n]/.test(token)) {
    throw new JianExecError(
      `Cannot quote ${JSON.stringify(token)} for a batch file: cmd.exe has no escape character — a ` +
        'double quote toggles its quoting state instead of being escaped, so the rest of the token would ' +
        'fall outside the quotes and split into further commands. A double quote or a line break cannot ' +
        'be passed through a .cmd/.bat argument list.',
      token,
    );
  }
  if (token === '') return '""';
  return /[\s&|<>^()]/.test(token) ? `"${token}"` : token;
}

/**
 * The `cmd.exe /s /c` command line for a batch shim: `cmd.exe /s` strips exactly
 * one outer quote pair, then takes the rest verbatim, so the whole line is
 * wrapped and every token inside it is quoted by {@link quoteCmdToken}.
 *
 * Exported because a caller outside this package has to build the same line for
 * the same reason — the CLI's `npm` launch plan spawns `npm.cmd` through
 * `cmd.exe` on Windows, and a second copy of the quoting rules is exactly the
 * kind of drift that lets one call site become injectable while the other is
 * fixed. It throws a `JianExecError` for a token no batch file can carry.
 */
export function buildCmdCommandLine(command: string, args: readonly string[]): string {
  return `"${[command, ...args].map(quoteCmdToken).join(' ')}"`;
}

class LocalProcess implements JianProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private readonly _platform: string;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;

  constructor(child: ChildProcess, platform: string) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Process must be created with stdin/stdout/stderr pipes.');
    }

    this._child = child;
    this._platform = platform;
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

  async kill(signal?: NodeJS.Signals): Promise<void> {
    const deliver: NodeJS.Signals = signal ?? 'SIGTERM';
    // The whole tree has to go, not just this child: grandchildren survive a
    // plain `ChildProcess.kill()` on both platforms. `killProcessTree` is the
    // one place that knows the mechanism per platform — `taskkill /T` on
    // Windows, the process group on POSIX (which is why the child is spawned
    // `detached` there; see `detachedForProcessTree`).
    try {
      await killProcessTree(this.pid, { signal: deliver, platform: this._platform });
    } catch (error) {
      // EPERM means the group is not ours to signal. Fall back to the direct
      // child so the caller still gets best-effort teardown instead of a hard
      // failure.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      try {
        this._child.kill(deliver);
      } catch {
        /* best effort */
      }
    }
  }
}

// Guards two writeTextAtomic calls in the same process landing in the same
// millisecond and racing on an identical tmp path (rename() would then fail
// with ENOENT on the second mover). Same rationale as the session store's
// state-write counter.
let atomicWriteCounter = 0;

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
  /**
   * Spawn / kill / path-case dialect for this instance, derived from the probed
   * environment: `osKind` is `'Windows'` exactly when the probe saw win32.
   * Injected rather than read from `process.platform` so tests can drive the
   * Windows dialect from any host — same shape as `environment.ts`, which takes
   * an injected platform probe.
   */
  private readonly _platform: 'win32' | 'posix';

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
    this._platform = osEnv.osKind === 'Windows' ? 'win32' : 'posix';
    this.osEnv = osEnv;
  }

  /**
   * Construct a fresh `LocalJian` after probing the host environment.
   *
   * Each call returns a new instance with its own `_cwd`; concurrent
   * callers can therefore operate on independent working directories
   * without polluting one another.
   */
  static async create(cwd?: string, rootDir?: string, env?: Environment): Promise<LocalJian> {
    // Allow callers that already know the host environment (e.g. from a
    // disk cache) to skip the platform detection entirely — on Windows that
    // probe walks PATH and stat's dozens of candidates, which slows startup.
    const osEnv = env ?? (await detectEnvironmentFromNode());
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
    if (isWithinDirectory(resolvedPath, this._rootDir, this._platform)) return;
    throw new JianPathOutsideRootError(
      `Path outside allowed root directory: ${resolvedPath}`,
      resolvedPath,
      this._rootDir,
    );
  }

  /** Resolve path for sandboxed operations — lexical check + realpath. */
  private async _resolveSandboxedPath(path: string): Promise<string> {
    const lexical = isAbsolute(path) ? normalize(path) : join(this._cwd, path);
    if (!isWithinDirectory(lexical, this._rootDir!, this._platform)) {
      throw new JianPathOutsideRootError(
        `Path outside allowed root directory: ${lexical}`,
        lexical,
        this._rootDir!,
      );
    }
    const realPath = await fsRealpath(lexical);
    const realRoot = await fsRealpath(this._rootDir!);
    if (!isWithinDirectory(realPath, realRoot, this._platform)) {
      throw new JianPathOutsideRootError(
        `Path outside allowed root directory (via symlink): ${lexical}`,
        lexical,
        this._rootDir!,
      );
    }
    return realPath;
  }

  pathClass(): 'posix' | 'win32' {
    return this._platform;
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
      stCtime: isWindowsPlatform(this._platform) ? s.birthtimeMs / 1000 : s.ctimeMs / 1000,
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
    options?: {
      caseSensitive?: boolean;
      allowedRoots?: readonly string[];
      exclude?: readonly string[];
      /**
       * Cooperative cancellation. Checked once per directory and once per
       * directory entry while walking; an aborted walk returns like an
       * exhausted one (no exception reaches the consumer). Omitted →
       * unchanged behaviour.
       */
      signal?: AbortSignal;
    },
  ): AsyncGenerator<string> {
    const signal = options?.signal;
    // Aborted before the first step: return without touching the filesystem
    // at all. Later steps are covered by the checkpoints in `_globWalk`.
    if (isAborted(signal)) return;
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    // `exclude` is opt-in: an omitted or empty list prunes nothing, so the
    // default walk is byte-for-byte the walk it was before the option
    // existed. Materialized once per call (a Set built per directory would
    // defeat the purpose of pruning a hot directory like `node_modules`).
    const excludedEntries =
      options?.exclude === undefined || options.exclude.length === 0
        ? undefined
        : new Set(options.exclude);
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
    // Per-traversal entry counter keyed by physical directory identity — see
    // MAX_PHYSICAL_REVISITS. The walk root counts as its own first entry.
    const physicalEntries = new Map<string, number>();
    try {
      const rootStat = await stat(resolved);
      const rootKey = cycleKey(rootStat);
      if (rootKey !== null) {
        initVisited.add(rootKey);
        physicalEntries.set(rootKey, 1);
      }
    } catch {
      // base does not exist / not accessible — walker handles via its own catch
    }
    yield* this._globWalk(
      resolved,
      patternParts,
      caseSensitive,
      initVisited,
      physicalAllowedRoots,
      excludedEntries,
      signal,
      physicalEntries,
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
  //
  // `exclude` is a set of entry *basenames* (never paths) the walk must
  // neither descend into nor yield. Matching is exact and case-sensitive
  // against the directory-entry name — the option exists to skip
  // well-known heavy trees (`node_modules`, `.git`) cheaply, not to
  // implement a second pattern language. The walk root itself is never
  // tested against it, so an explicitly addressed root is always walked:
  // `glob(root + '/node_modules', '**/*.js', { exclude: ['node_modules'] })`
  // still returns matches. `undefined` (the default) prunes nothing.
  //
  // Revisit bound: the `visited` set above is path-local, which does not
  // keep a symlink farm bounded — see MAX_PHYSICAL_REVISITS. `physicalEntries`
  // is the per-traversal entry counter for the very same `dev:ino` key: a
  // directory whose key has been entered that many times already is skipped
  // before any of its own entries is read. Only *descents* count towards it;
  // the same-directory `**` re-evaluation above and plain match yields do
  // not consume budget.
  //
  // Cancellation: `signal` is checked once per directory and once per
  // directory entry, in both cases *before* the step that would cost a
  // `readdir`, a `stat` or a whole descent. An aborted walk returns like an
  // exhausted one, so the consumer's `for await` simply ends — no exception
  // is surfaced.
  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
    visited: Set<string>,
    physicalAllowedRoots: readonly string[] | undefined,
    exclude: ReadonlySet<string> | undefined,
    signal: AbortSignal | undefined,
    physicalEntries: Map<string, number>,
  ): AsyncGenerator<string> {
    if (isAborted(signal)) return;
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
          exclude,
          signal,
          physicalEntries,
        );
      } else {
        // Pattern ends with `**`: yield basePath itself (zero-dir match).
        yield basePath;
      }

      // Directory-granularity checkpoint: a frame that resumes after an
      // aborted descent must not pay for reading its own directory.
      if (isAborted(signal)) return;
      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        // Cancellation checkpoint, entry granularity — this is the check
        // that bounds an abandoned walk: when the signal fires, at most one
        // entry per directory level is still in flight, and the unwind
        // re-checks here on every level on its way out.
        if (isAborted(signal)) return;
        // Prune before `join`/`stat`: the point of the option is to avoid
        // paying a stat — and a whole recursive descent — for entries the
        // caller asked to skip.
        if (exclude?.has(entry) === true) continue;
        // Use join to avoid "//entry" when basePath is a filesystem root.
        const fullPath = join(basePath, entry);
        if (this._rootDir && !isWithinDirectory(fullPath, this._rootDir, this._platform)) continue;
        let entryStat;
        try {
          entryStat = await stat(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          const key = cycleKey(entryStat);
          if (key !== null && visited.has(key)) continue;
          if (key !== null && !enterPhysical(key, physicalEntries)) continue;
          yield* this._globWalk(
            fullPath,
            patternParts,
            caseSensitive,
            key !== null ? new Set([...visited, key]) : visited,
            physicalAllowedRoots,
            exclude,
            signal,
            physicalEntries,
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

      // Directory-granularity checkpoint — mirrors the `**` branch above.
      if (isAborted(signal)) return;
      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        // Cancellation checkpoint, entry granularity — mirrors the `**`
        // branch above.
        if (isAborted(signal)) return;
        // An excluded basename is skipped even when it matches the pattern:
        // the caller asked for the entry to be invisible to this walk, and
        // the tool layer keeps a name out of `exclude` when the pattern
        // addresses it explicitly.
        if (exclude?.has(entry) === true) {
          continue;
        }
        if (!regex.test(entry)) {
          continue;
        }

        // Use join to avoid "//entry" when basePath is a filesystem root.
        const fullPath = join(basePath, entry);
        if (this._rootDir && !isWithinDirectory(fullPath, this._rootDir, this._platform)) continue;
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
            if (key !== null && !enterPhysical(key, physicalEntries)) continue;
            yield* this._globWalk(
              fullPath,
              remainingParts,
              caseSensitive,
              key !== null ? new Set([...visited, key]) : visited,
              physicalAllowedRoots,
              exclude,
              signal,
              physicalEntries,
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
      return physicalAllowedRoots.some((root) =>
        isWithinDirectory(physicalPath, root, this._platform),
      );
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
    const errors = options?.errors ?? 'strict';
    const webLabel = utfTextDecoderLabel(encoding);
    if (webLabel !== undefined) {
      yield* this._readLinesWithTextDecoder(resolved, webLabel, errors);
      return;
    }
    // Non-UTF encodings (hex/base64/latin1/...) are lossless byte↔character
    // mappings that TextDecoder does not cover, so `errors` has no effect and
    // Node's stream decoder reads them exactly.
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

  /**
   * Streaming read of a UTF-family file. `strict` / `replace` go through a
   * `TextDecoder`: its state survives chunk boundaries, so a multi-byte
   * character split at a chunk boundary decodes correctly, a leading BOM is
   * removed exactly as the whole-file `readText` removes it, and `fatal`
   * rejects invalid input exactly as decoding the whole file under
   * `errors: 'strict'` does.
   *
   * `ignore` cannot use a `TextDecoder`: non-fatal decoding *replaces*
   * invalid input with U+FFFD, while `ignore` must drop it (and keep U+FFFD
   * characters the file already contains). That mode buffers raw bytes and
   * decodes line by line with the same byte-level decoders the whole-file
   * `readText` uses, so the two reads agree character for character.
   */
  private async *_readLinesWithTextDecoder(
    resolved: string,
    webLabel: string,
    errors: 'strict' | 'replace' | 'ignore',
  ): AsyncGenerator<string> {
    if (errors === 'ignore') {
      yield* this._readLinesIgnoreBytes(resolved, webLabel);
      return;
    }
    const decoder = new TextDecoder(webLabel, { fatal: errors === 'strict' });
    const stream = createReadStream(resolved, { highWaterMark: 64 * 1024 });
    let remainder = '';
    const splitChunk = (text: string): string[] => {
      const lines = (remainder + text).split('\n');
      remainder = lines.pop() ?? '';
      return lines;
    };
    try {
      for await (const chunk of stream) {
        for (const line of splitChunk(decoder.decode(chunk, { stream: true }))) {
          yield line + '\n';
        }
      }
      // Flush whatever the decoder still holds; a trailing incomplete sequence
      // rejects here under 'strict', just like the whole-file decode.
      for (const line of splitChunk(decoder.decode())) {
        yield line + '\n';
      }
    } finally {
      stream.destroy();
    }
    if (remainder !== '') {
      yield remainder;
    }
  }

  /**
   * `errors: 'ignore'` streaming read for UTF-8 / UTF-16LE.
   *
   * Raw bytes are buffered until a line terminator — `0x0a` for UTF-8, the
   * UTF-16LE code unit `U+000A` (`0a 00` at an even offset) for UTF-16LE —
   * and the completed line is decoded with `decodeUtf8Ignore` /
   * `decodeUtf16LeIgnore`. Splitting on those bytes can never cut a valid
   * sequence: neither encoding contains a line-feed byte inside a multi-byte
   * character or a surrogate pair, and decoding a line in isolation drops
   * exactly the bytes the whole-file decode drops. Memory is bounded by the
   * longest single line, like the `TextDecoder` path.
   */
  private async *_readLinesIgnoreBytes(resolved: string, webLabel: string): AsyncGenerator<string> {
    const utf16Le = webLabel === 'utf-16le';
    const decodeLine = utf16Le ? decodeUtf16LeIgnore : decodeUtf8Ignore;
    const stream = createReadStream(resolved, { highWaterMark: 64 * 1024 });
    /** Raw byte runs of the line currently being assembled, in order. */
    let pending: Buffer[] = [];
    /** UTF-16LE only: the odd byte a chunk ended on, rejoined with the next
     *  chunk so the line-feed scan only ever steps over whole code units. */
    let carry: Buffer | undefined;

    const concatPending = (tail: Buffer | undefined): Buffer =>
      tail === undefined || tail.length === 0
        ? Buffer.concat(pending)
        : Buffer.concat([...pending, tail]);
    const findLineBreak = (data: Buffer, from: number): number => {
      if (!utf16Le) return data.indexOf(0x0a, from);
      // Code-unit aligned scan: a 0x0a on an odd offset is the high byte of a
      // code unit, never the LF code unit's first byte.
      for (let i = from; i + 1 < data.length; i += 2) {
        if (data[i] === 0x0a && data[i + 1] === 0x00) return i;
      }
      return -1;
    };

    try {
      for await (const chunk of stream) {
        let data: Buffer =
          carry === undefined ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);
        carry = undefined;
        if (utf16Le && data.length % 2 === 1) {
          carry = data.subarray(data.length - 1);
          data = data.subarray(0, data.length - 1);
        }
        let start = 0;
        for (;;) {
          const at = findLineBreak(data, start);
          if (at === -1) break;
          const end = at + (utf16Le ? 2 : 1);
          yield decodeLine(concatPending(data.subarray(start, end)));
          pending = [];
          start = end;
        }
        if (start < data.length) pending.push(data.subarray(start));
      }
    } finally {
      stream.destroy();
    }

    const tail = concatPending(carry);
    if (tail.length > 0) yield decodeLine(tail);
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

  async writeTextAtomic(path: string, data: string, options?: { encoding?: BufferEncoding }): Promise<number> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    // Temp-file + rename makes the swap all-or-nothing: a process killed
    // mid-write leaves the previous content intact instead of a truncated
    // file (plain writeFile truncates before the new bytes land). The tmp
    // file sits next to the target so rename() never crosses filesystems.
    const tmpPath = `${resolved}.${process.pid}.${Date.now().toString(36)}.${(atomicWriteCounter++).toString(36)}.tmp`;
    await writeFile(tmpPath, data, encoding);
    await rename(tmpPath, resolved);
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
    const childEnv = buildSafeEnv(env);
    // Windows resolves `npm` to `npm.cmd` and needs `cmd.exe` for the batch
    // shims; every other platform spawns the name as given.
    const plan = isWindowsPlatform(this._platform)
      ? await windowsSpawnPlan(command, args.slice(1), childEnv)
      : { command, args: args.slice(1), windowsVerbatimArguments: false };
    const child = spawn(plan.command, plan.args, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A process group is what makes the tree killable as a tree; see
      // `detachedForProcessTree`.
      detached: detachedForProcessTree(this._platform),
      env: childEnv,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      // Windows-only no-op elsewhere: never flash a console window for a
      // command the user did not ask to see.
      windowsHide: true,
    });
    try {
      await waitForSpawn(child);
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new JianExecError(
          `Failed to spawn ${plan.command}: ${error.message}`,
          plan.command,
          (error as NodeJS.ErrnoException).code,
        );
      }
      throw error;
    }
    return new LocalProcess(child, this._platform);
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
