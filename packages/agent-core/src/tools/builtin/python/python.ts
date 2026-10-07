import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { isParentInterject } from '../../../utils/abort';
import { toInputJsonSchema } from '../../support/input-schema';

/**
 * Channel markers of the kernel↔host protocol. Every marker carries the
 * instance nonce, so (a) two PythonTool instances can never cross-hit each
 * other's markers and (b) user code printing an old-style literal such as
 * `__SCREAM_PY_DONE__` can never finish a read early or poison the next scan —
 * only this instance's nonce-bearing marker counts.
 */
function kernelMarkers(nonce: string): {
  done: string;
  boot: string;
  sync: string;
  error: string;
} {
  return {
    done: `__SCREAM_PY_DONE_${nonce}__`,
    boot: `__SCREAM_BOOT_DONE_${nonce}__`,
    sync: `__SCREAM_SYNC_${nonce}__`,
    error: `__SCREAM_PY_ERROR_${nonce}__`,
  };
}

/** Every bridge reply/state file this tool family owns shares this tmpdir prefix. */
const REPLY_FILE_PREFIX = 'scream-rlm-';
/** A file this tool family owns is swept once it is older than this. */
const REPLY_FILE_MAX_AGE_MS = 24 * 60 * 60_000;

/** True when a pid is still alive (signal-0 probe; EPERM means it exists but
 * belongs to another user). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Who fired the abort that settled an interrupted call — mirrors BashTool:
 * a parent agent's interject must not be reported as a user stop. */
function interruptedBy(signal: AbortSignal | undefined): 'user' | 'the parent agent' {
  return signal !== undefined && isParentInterject(signal.reason) ? 'the parent agent' : 'user';
}

/**
 * True when the signal has fired (an absent signal never aborts).
 *
 * Deliberately a function, not an inline `signal?.aborted === true` check:
 * repeated inline checks on the same property trip TS2367, because the first
 * check narrows the property to `false` for the rest of the scope even though
 * an await in between can flip it.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Head/tail output cap for python tool results — mirrors the generic tool
 * result builder (50k chars, 20k tail) so a runaway print loop cannot balloon
 * the snapshot into memory/TUI exhaustion. */
const MAX_OUTPUT_CHARS = 50_000;
const TAIL_CHARS = 20_000;
const TRUNCATION_MARKER = '[...truncated]';
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS - TAIL_CHARS)}\n${TRUNCATION_MARKER}\n${output.slice(-TAIL_CHARS)}`;
}
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const KERNEL_START_TIMEOUT_MS = 30_000;
/** SIGINT grace when an interrupted call must return the kernel to its prompt
 * (timeout or abort) before the host decides it is hung and restarts it. */
const INTERRUPT_GRACE_MS = 1_500;

export const PythonInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'Python code to execute in the persistent kernel. Variables and plain data ' +
        'persist across calls, unlike Bash; imports, functions, and live objects are ' +
        'NOT restored if the kernel restarts, so re-run them after a restart. State ' +
        'is kept for the whole session while the /rlm mode is enabled.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS / 1000)
    .optional()
    .describe('Execution timeout in seconds (default 60, max 300).'),
});

export type PythonInput = z.infer<typeof PythonInputSchema>;

/** A host-side handler for a kernel bridge request (e.g. rlm.run). */
export type HostRequestHandler = (
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Named handlers the kernel can invoke via `host_request` (rlm.run, rlm.result, ...). */
export type HostRequestHandlers = Record<string, HostRequestHandler>;

export interface PythonToolOptions {
  /** Bridge handlers invoked when the kernel issues a `host_request`. */
  readonly hostHandlers?: HostRequestHandlers;
  /** Overrides the snapshot file location (tests only; production auto-generates). */
  readonly snapshotPath?: string;
  /** Overrides the serialized-snapshot byte cap (tests only; production uses
   * {@link PythonTool.SNAPSHOT_BYTE_LIMIT}). */
  readonly snapshotByteLimit?: number;
}

// Bootstrap defines the rlm()/rlm_wait() bridge helpers. The Python source is
// kept as a multi-line template for readability, but injected as a single
// base64-decoded exec() line — the interactive REPL never sees multi-line
// block input (which requires blank-line terminators between defs and would
// otherwise hang or raise).
//
// Placeholders substituted per instance: __SNAP_PATH__ (state file),
// __SNAP_LIMIT__ (byte cap) and __NONCE__ (reply-file/marker namespace).
const RLM_BOOTSTRAP_PY = `import json, os, sys, tempfile, time, itertools, pickle, threading
_RLM_ID = itertools.count(1)
_SNAP = __SNAP_PATH__
_SNAP_LIMIT = __SNAP_LIMIT__
_NONCE = "__NONCE__"
_WARNED = set()
_PENDING_WARNINGS = []

def _warn(msg):
    # Kernel-scoped, deduped warnings. They are queued here and flushed by the
    # host at the start of the NEXT call, so a warning about the state left by
    # this call never contaminates this call's own output.
    if msg in _WARNED:
        return
    _WARNED.add(msg)
    _PENDING_WARNINGS.append(msg)

def _flush_warnings():
    if _PENDING_WARNINGS:
        msgs = list(_PENDING_WARNINGS)
        del _PENDING_WARNINGS[:]
        for m in msgs:
            try:
                print("\\u26a0 RLM: " + m)
            except Exception:
                try:
                    print("RLM: " + m)
                except Exception:
                    pass

def _scream_background_error(fallback_hook, payload):
    # Background threads / unretrieved futures raise outside the exec wrapper,
    # so their tracebacks reach stderr without the wrapper's error marker.
    # Emit the marker here too, then delegate to the default hook so the
    # traceback still lands on stderr.
    try:
        print(_ERROR_MARKER)
    except Exception:
        pass
    fallback_hook(payload)

_ERROR_MARKER = "__SCREAM_PY_ERROR_" + _NONCE + "__"
_DEFAULT_THREAD_HOOK = getattr(threading, "__excepthook__", None)
if _DEFAULT_THREAD_HOOK is not None:
    threading.excepthook = lambda args: _scream_background_error(_DEFAULT_THREAD_HOOK, args)
_DEFAULT_UNRAISABLE_HOOK = getattr(sys, "__unraisablehook__", None)
if _DEFAULT_UNRAISABLE_HOOK is not None:
    sys.unraisablehook = lambda unraisable: _scream_background_error(_DEFAULT_UNRAISABLE_HOOK, unraisable)

def _host_request(method, payload, timeout=120):
    rid = next(_RLM_ID)
    sys.stdout.write(json.dumps({"type": "host_request", "id": rid, "method": method, "payload": payload}) + "\\n")
    sys.stdout.flush()
    reply_file = os.path.join(tempfile.gettempdir(), "scream-rlm-" + _NONCE + "-" + str(os.getpid()) + "-" + str(rid) + ".json")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(reply_file):
            try:
                with open(reply_file, "r", encoding="utf-8") as f:
                    reply = json.load(f)
                os.remove(reply_file)
            except Exception:
                time.sleep(0.1)
                continue
            if "error" in reply:
                raise RuntimeError(reply["error"])
            return reply.get("result")
        time.sleep(0.1)
    raise RuntimeError("host bridge timeout")

def rlm(task, name="subagent", **meta):
    payload = {"task": task, "name": name}
    payload.update(meta)
    return _host_request("rlm.run", payload)

def rlm_wait(handle, timeout=120):
    return _host_request("rlm.result", {"id": handle, "timeout": timeout}, timeout=timeout)

def _snapshot(path=_SNAP):
    saved = {}
    for k, v in list(globals().items()):
        if k.startswith("_") or callable(v) or isinstance(v, type(sys)):
            continue
        try:
            pickle.dumps(v)
            saved[k] = v
        except Exception:
            pass
    try:
        data = pickle.dumps(saved)
    except Exception:
        return 0
    if len(data) > _SNAP_LIMIT:
        _warn("state exceeds the " + str(_SNAP_LIMIT) + "-byte snapshot limit; it stays in the running kernel but will not survive a restart")
        return 0
    try:
        with open(path, "wb") as f:
            f.write(data)
        return len(saved)
    except Exception:
        return 0

def _restore(path=_SNAP):
    if not os.path.exists(path):
        return 0
    try:
        with open(path, "rb") as f:
            saved = pickle.load(f)
    except Exception as e:
        _warn("snapshot restore failed (" + type(e).__name__ + "); state from the previous kernel was not restored")
        return 0
    for k, v in saved.items():
        globals()[k] = v
    return len(saved)

_restore()
`;

/** Builds the single-line bootstrap exec for this tool instance, embedding
 * the snapshot path, the snapshot byte cap, and the instance nonce that
 * namespaces reply files and channel markers. */
function buildRlmBootstrap(snapshotPath: string, nonce: string, snapshotByteLimit: number): string {
  const py = RLM_BOOTSTRAP_PY
    .replace('__SNAP_PATH__', JSON.stringify(snapshotPath))
    .replace('__SNAP_LIMIT__', String(snapshotByteLimit))
    .replace('__NONCE__', nonce);
  return `exec(__import__('base64').b64decode('${Buffer.from(py).toString('base64')}').decode())\nprint("${kernelMarkers(nonce).boot}")`;
}


/**
 * Executes Python code in a persistent interactive kernel (`python3 -u -i`
 * over a pipe). The kernel process is lazily started on first use and lives
 * for the lifetime of this tool instance (the /rlm session), so variables and
 * loaded data survive across calls — unlike the stateless Bash tool. Imports
 * and functions are not restored after a kernel restart (only plain data is,
 * from the snapshot). Runs under the normal permission mode like any other
 * tool; the code can read/write files, so it is gated exactly like a mutating
 * tool.
 */
export class PythonTool implements BuiltinTool<PythonInput> {
  /** Serialized-snapshot byte cap: state larger than this is not written to
   * disk (writing it would block the kernel and risk OOM); the next call
   * reports the skipped snapshot through a one-shot warning. */
  static readonly SNAPSHOT_BYTE_LIMIT = 32 * 1024 * 1024;

  readonly name = 'python' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PythonInputSchema);
  /** Working directory the kernel runs in. Readable so the tool registry can
   * reuse a live instance across rebuilds only while the cwd is unchanged. */
  readonly cwd: string;

  private kernel: ChildProcess | undefined;
  /** In-flight startKernel() promise — concurrent callers share one spawn
   * instead of racing two kernels into existence. */
  private kernelSpawn: Promise<ChildProcess> | undefined;
  private kernelBusy = false;
  /** Accumulated stderr from the kernel (tracebacks land here). */
  private kernelStderr = '';
  /** Bytes of kernelStderr consumed by the last execution (race-safe drain). */
  private kernelStderrOffset = 0;
  /** Per-instance snapshot file so RLM state survives kernel restarts. */
  private readonly snapshotPath: string;
  private readonly hostHandlers: HostRequestHandlers | undefined;
  private readonly snapshotByteLimit: number;
  /** Instance nonce: namespaces reply files and every channel marker. */
  private readonly nonce: string;
  private readonly doneMarker: string;
  private readonly bootDoneMarker: string;
  private readonly syncMarker: string;
  private readonly errorMarker: string;

  constructor(
    cwd: string,
    private readonly options: PythonToolOptions = {},
  ) {
    this.cwd = cwd;
    this.hostHandlers = options.hostHandlers;
    this.snapshotByteLimit = options.snapshotByteLimit ?? PythonTool.SNAPSHOT_BYTE_LIMIT;
    // 8 hex chars — inside the reply-file protocol's `[a-z0-9]{6,10}`.
    this.nonce = randomBytes(4).toString('hex');
    const markers = kernelMarkers(this.nonce);
    this.doneMarker = markers.done;
    this.bootDoneMarker = markers.boot;
    this.syncMarker = markers.sync;
    this.errorMarker = markers.error;
    this.snapshotPath =
      options.snapshotPath ??
      join(
        tmpdir(),
        `scream-rlm-state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.pkl`,
      );
    this.description =
      'Execute Python code in a persistent kernel. Variables and plain data persist ' +
      'across calls (unlike Bash) and are restored from a snapshot if the kernel ' +
      'restarts. Imports, functions, and live objects are NOT restored after a ' +
      'restart — re-run your imports if the kernel restarts. Ideal for data analysis ' +
      'and multi-step processing. This tool is available only when RLM mode is ' +
      'enabled (/rlm); when you can see it, prefer it over repeated Bash python3 ' +
      'invocations for any workflow that keeps state across steps (load → transform ' +
      '→ analyze → export). Run shell commands with the Bash tool instead. The ' +
      'kernel also provides `rlm(task, name="subagent")` to spawn a subagent ' +
      '(returns a handle immediately) and `rlm_wait(handle, timeout)` to await its ' +
      'final summary — use them to parallelize independent data sub-tasks inside ' +
      'the kernel. Each rlm() call starts a real subagent on a real task; nesting ' +
      'is unlimited by default, so set /rlm-max-depth before long workflows that ' +
      'spawn subagents from subagents. Multi-line code (def/for/if) is fully ' +
      'supported. Code runs under the current permission mode; mutating ' +
      'operations follow the same approval rules as other tools.';
  }

  dispose(): void {
    // Cancel any in-flight rlm() subagents (host-side convention hook) before
    // killing the kernel, so children do not keep burning tokens with no
    // consumer after teardown.
    if (this.hostHandlers !== undefined) {
      void this.hostHandlers['__dispose__']?.({}).catch(() => {});
    }
    // A kernel may be mid-start; kill it as soon as the spawn resolves so a
    // session close during boot cannot leak an orphan process.
    const pendingSpawn = this.kernelSpawn;
    if (pendingSpawn !== undefined) {
      void pendingSpawn
        .then((proc) => {
          proc.kill('SIGKILL');
        })
        .catch(() => {});
    }
    void this.kernel?.kill('SIGKILL');
    this.kernel = undefined;
    this.kernelBusy = false;
    this.kernelStderr = '';
    this.kernelStderrOffset = 0;
    // Remove this instance's snapshot file so RLM state does not accumulate
    // in the tmpdir across sessions.
    void unlink(this.snapshotPath).catch(() => {});
    // Drop every bridge reply file this instance owns (nonce-scoped).
    this.cleanupReplyFiles();
  }

  /** Removes every reply file this instance owns — names are prefixed with
   * this instance's nonce, so no other session's files are touched. */
  private cleanupReplyFiles(): void {
    void (async () => {
      try {
        const dir = tmpdir();
        const prefix = `${REPLY_FILE_PREFIX}${this.nonce}-`;
        const names = await readdir(dir);
        await Promise.all(
          names
            .filter((name) => name.startsWith(prefix))
            .map((name) => unlink(join(dir, name)).catch(() => {})),
        );
      } catch {
        /* best-effort: a failed tmpdir sweep must never break dispose */
      }
    })();
  }

  /**
   * Best-effort sweep of `scream-rlm-*` files left behind by dead sessions:
   * reply files carry the owning kernel's pid (`scream-rlm-<nonce>-<pid>-<rid>
   * .json`), and a file whose kernel is gone is dead weight regardless of age;
   * files older than 24h (including legacy layouts and stale state snapshots)
   * go too. Every failure is swallowed — this runs on the kernel-start path
   * and must never delay or break it.
   */
  private static async sweepStaleKernelFiles(): Promise<void> {
    try {
      const dir = tmpdir();
      const now = Date.now();
      const names = await readdir(dir);
      await Promise.all(
        names
          .filter((name) => name.startsWith(REPLY_FILE_PREFIX))
          .map(async (name) => {
            const full = join(dir, name);
            try {
              const info = await stat(full);
              const expired = now - info.mtimeMs > REPLY_FILE_MAX_AGE_MS;
              const pidMatch = /^scream-rlm-(?:[a-z0-9]{6,10}-)?(\d+)-\d+\.json$/.exec(name);
              const rawPid = pidMatch?.[1];
              const ownerGone = rawPid !== undefined && !isProcessAlive(Number(rawPid));
              if (expired || ownerGone) await unlink(full);
            } catch {
              /* best-effort: a file that vanished or resists inspection is skipped */
            }
          }),
      );
    } catch {
      /* best-effort: an unreadable tmpdir must not break kernel start */
    }
  }

  /** Lazily starts the persistent kernel. The banner and REPL prompts are
   * emitted on stderr (not stdout), so we drain stderr continuously and drop
   * the startup banner; stdout only carries print() output. */
  private async ensureKernel(signal?: AbortSignal): Promise<ChildProcess> {
    if (this.kernel !== undefined && this.kernel.exitCode === null) return this.kernel;
    // Concurrent callers during a first call must share one spawn: two racing
    // startKernel() calls would each create a kernel and only one would end up
    // in `this.kernel`, orphaning the other and splitting the state.
    if (this.kernelSpawn !== undefined) return this.kernelSpawn;
    const pending = this.startKernel(signal);
    this.kernelSpawn = pending;
    try {
      return await pending;
    } finally {
      if (this.kernelSpawn === pending) this.kernelSpawn = undefined;
    }
  }

  private async startKernel(signal?: AbortSignal): Promise<ChildProcess> {
    this.kernelStderr = '';
    this.kernelStderrOffset = 0;
    // Fire-and-forget: stale-file cleanup must never delay kernel start.
    void PythonTool.sweepStaleKernelFiles();
    const proc = await this.spawnKernel();
    this.kernel = proc;
    // A missing python (ENOENT) or a kernel that dies instantly emits an
    // 'error' event; without a listener it would crash the agent process.
    // Attach the listener here so startKernel can detect the failure and
    // surface a real message instead of an unhandled 'error' event.
    let spawnError: Error | undefined;
    proc.on('error', (error: Error) => {
      spawnError = error;
    });
    // When the process fails to spawn (e.g. python not installed), Node
    // emits 'error' on the stdio streams as well — without listeners those
    // become uncaught exceptions that crash the agent. Swallow them; the
    // readUntilMarker 'end'/'close'/'error' path settles the call.
    proc.stdin?.on('error', () => {});
    proc.stdout?.on('error', () => {});
    proc.stderr?.on('error', () => {});
    // Continuously drain stderr so a large traceback never blocks the kernel.
    this.drainStderr(proc);
    // Inject the rlm()/rlm_wait() bridge helpers when /rlm host handlers exist.
    // Wait for the BOOT_DONE marker so the exec() finished before any user
    // code is written — otherwise user code can be swallowed into the exec
    // multi-line string and cause a SyntaxError.
    if (this.hostHandlers !== undefined) {
      proc.stdin.write(`${buildRlmBootstrap(this.snapshotPath, this.nonce, this.snapshotByteLimit)}\n`);
      const boot = await this.readUntilMarker(proc.stdout, this.bootDoneMarker, KERNEL_START_TIMEOUT_MS, {
        signal,
      });
      if (!boot.found) {
        // Bootstrap failed (missing python, SyntaxError in the injected
        // helpers, or a kernel that died on startup). Kill the process so a
        // broken kernel is never reused, and surface the captured error.
        void proc.kill('SIGKILL');
        this.kernel = undefined;
        if (isAborted(signal)) {
          // The abort interrupted the boot wait; the caller reports it as an
          // interruption (the killed kernel is brand-new and stateless).
          throw new Error('Python kernel start interrupted');
        }
        throw new Error(
          `Python kernel failed to start: ${spawnError?.message ?? 'bootstrap did not complete'}`,
        );
      }
    }
    return proc;
  }

  /** Candidate python commands, platform-first order. Exposed for tests:
   * POSIX prefers `python3`, Windows prefers `python`. Both fall back to the
   * other on ENOENT so a machine with either interpreter works. */
  static pythonCandidates(platform: NodeJS.Platform = process.platform): string[] {
    return platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  }

  /**
   * Spawns the kernel, resolving the python command per platform.
   *
   * The command name differs across platforms: POSIX ships `python3`; Windows
   * commonly exposes only `python` (python3 may or may not exist as an alias).
   * We prefer the platform-default name first and fall back to the other on
   * ENOENT, so a Windows install with either `python` or `python3` works.
   */
  private async spawnKernel(): Promise<ChildProcessWithoutNullStreams> {
    const candidates = PythonTool.pythonCandidates();
    let lastError: Error | undefined;
    for (const command of candidates) {
      try {
        return await this.trySpawn(command);
      } catch (error) {
        lastError = error as Error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // ENOENT → command not found; try the next candidate.
      }
    }
    throw lastError ?? new Error(`No python interpreter found (tried: ${candidates.join(', ')})`);
  }

  private trySpawn(command: string): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, ['-u', '-i'], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Pin UTF-8 on the kernel's std streams: kernel warnings carry `⚠`,
        // and user code printing non-ASCII must not die with UnicodeEncodeError
        // under a C/POSIX locale.
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      // A missing command emits 'error' (ENOENT) asynchronously; reject so
      // spawnKernel can fall back to the next candidate. A successful spawn
      // resolves once the process is running.
      proc.once('error', (error) => {
        reject(error);
      });
      proc.once('spawn', () => {
        proc.off('error', reject);
        resolve(proc);
      });
    });
  }

  private drainStderr(proc: ChildProcess): void {
    const decoder = new StringDecoder('utf8');
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.kernelStderr += decoder.write(chunk);
    });
  }

  /**
   * Reads stdout until `marker` appears (or the deadline passes, the signal
   * aborts, or the stream ends). Uses the 'data' event instead of an async
   * iterator: a `for await` that returns early destroys the stream, which
   * breaks the next call on the same persistent kernel. `'data'` keeps the
   * stream alive across calls.
   *
   * `replyPid` identifies the kernel process that owns this stream: bridge
   * replies must land in the file that kernel polls, even if `this.kernel` has
   * since been replaced.
   */
  private async readUntilMarker(
    stream: Readable | null,
    marker: string,
    timeoutMs: number,
    opts: { signal?: AbortSignal | undefined; replyPid?: number | undefined } = {},
  ): Promise<{ lines: string[]; found: boolean }> {
    if (stream === null) return { lines: [], found: false };
    const { signal, replyPid } = opts;
    return new Promise((resolve) => {
      const lines: string[] = [];
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Single cleanup path: the timer and every listener (including the abort
      // hook) are removed in exactly one place, however the read finishes.
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('close', onEnd);
        stream.off('error', onEnd);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (found: boolean) => {
        cleanup();
        resolve({ lines, found });
      };
      // The stream ending/closeing/erroring means the kernel process died
      // mid-call; settle immediately instead of making the caller wait out
      // the full timeout for a marker that will never arrive.
      const onEnd = () => {
        finish(false);
      };
      const onAbort = () => {
        finish(false);
      };
      const onData = (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          if (line.includes(marker)) return finish(true);
          // Bridge requests are recognized by strict JSON parsing, never by
          // substring: user code printing `"host_request"` must reach the
          // output instead of being swallowed as a malformed bridge line.
          const trimmed = line.trimStart();
          if (trimmed.startsWith('{')) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              parsed = undefined;
            }
            if (
              parsed !== null &&
              typeof parsed === 'object' &&
              (parsed as { type?: unknown }).type === 'host_request'
            ) {
              void this.handleHostRequest(parsed as Record<string, unknown>, replyPid).catch(() => {
                /* best-effort: a failed bridge request must not break the loop */
              });
              continue;
            }
          }
          lines.push(line);
        }
        if (buffer.includes(marker)) {
          lines.push(buffer);
          buffer = '';
          return finish(true);
        }
      };
      timer = setTimeout(() => finish(false), timeoutMs);
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('close', onEnd);
      stream.on('error', onEnd);
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(false);
          return;
        }
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  /**
   * Handles a kernel `host_request` line: invokes the registered handler and
   * writes the reply to the kernel's expected reply file (the kernel polls
   * that file — replies must not go over stdin, which is used for code input
   * and would race with the REPL). Fire-and-forget from the read loop.
   *
   * `replyPid` is the pid captured from the kernel that issued the request: if
   * the kernel is restarted (timeout kill) while a bridge handler is still
   * running, the late reply must still land in the file the originating kernel
   * is polling.
   */
  private async handleHostRequest(
    parsed: Record<string, unknown>,
    replyPid: number | undefined,
  ): Promise<void> {
    const pid = replyPid ?? this.kernel?.pid;
    if (pid === undefined) return;
    const { id, method, payload } = parsed;
    if (typeof id !== 'number' || typeof method !== 'string' || payload === undefined) return;
    const handler = this.hostHandlers?.[method];
    if (handler === undefined) {
      this.writeHostReply(pid, id, { error: `no handler for ${method}` });
      return;
    }
    try {
      const result = await handler(payload as Record<string, unknown>);
      this.writeHostReply(pid, id, { result });
    } catch (error) {
      this.writeHostReply(pid, id, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Writes a bridge reply to the kernel's expected reply file, namespaced by
   * this instance's nonce so sessions can never collide. */
  private writeHostReply(pid: number, id: number, body: Record<string, unknown>): void {
    const file = join(tmpdir(), `${REPLY_FILE_PREFIX}${this.nonce}-${pid}-${id}.json`);
    void writeFile(file, JSON.stringify({ type: 'host_reply', id, ...body }), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    }).catch(() => {
      /* best-effort: a failed reply write surfaces as a kernel timeout */
    });
  }

  resolveExecution(args: PythonInput): ToolExecution {
    const preview = args.code.length > 50 ? `${args.code.slice(0, 50)}…` : args.code;
    return {
      description: `Python: ${preview}`,
      display: {
        kind: 'command',
        command: args.code,
        cwd: this.cwd,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(args: PythonInput, ctx: ExecutableToolContext): Promise<ExecutableToolResult> {
    // Defensive: tests and replay paths build partial contexts; an absent
    // signal simply never aborts.
    const signal: AbortSignal | undefined = ctx.signal;
    const interruptedResult = (): ExecutableToolResult => ({
      isError: true,
      output: `Interrupted by ${interruptedBy(signal)}; kernel state preserved.`,
    });
    if (isAborted(signal)) return interruptedResult();
    if (this.kernelBusy) {
      return {
        isError: true,
        output:
          'The Python kernel is busy executing a previous call. Wait for it to finish, or interrupt the running call.',
      };
    }
    this.kernelBusy = true;
    try {
      let proc: ChildProcess;
      try {
        proc = await this.ensureKernel(signal);
      } catch (error) {
        if (isAborted(signal)) return interruptedResult();
        throw error;
      }
      if (isAborted(signal)) return interruptedResult();
      const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      // User code runs through a double-layer base64 single-line exec —
      // the same mechanism the bootstrap uses. Multi-line blocks written
      // straight to stdin fail in pipe mode (python -i block parsing is
      // broken for pipes), which produced spurious SyntaxErrors/NameErrors
      // on def/for/if blocks.
      // The wrapper preserves REPL echo semantics:
      //   - a bare expression (x + 1, len(data)) → eval → its value prints
      //   - statements/multi-line → exec runs them in the kernel globals so
      //     names persist; if the final statement is a trailing expression
      //     (x = 42\nx + 1), the head is executed then the tail is eval'd
      //     and echoed — matching the old per-line REPL behaviour instead of
      //     silently swallowing the result.
      // The wrapper imports base64 itself (each exec is an isolated scope —
      // relying on the bootstrap's import would NameError) and passes
      // globals() so evaluated/executed names persist in the kernel.
      // The DONE marker and snapshot run on their own statements after it.
      const codeB64 = Buffer.from(args.code, 'utf8').toString('base64');
      const wrapperPy =
        'import ast as _ast, base64 as _b\n' +
        `__c = _b.b64decode('${codeB64}').decode()\n` +
        'try:\n' +
        '    try:\n' +
        '        __r = eval(__c, globals())\n' +
        '        if __r is not None:\n' +
        '            print(repr(__r))\n' +
        '    except SyntaxError:\n' +
        '        __tree = _ast.parse(__c)\n' +
        '        __tail = __tree.body[-1] if __tree.body else None\n' +
        '        if isinstance(__tail, _ast.Expr) and not any(\n' +
        '            isinstance(n, (_ast.ClassDef, _ast.FunctionDef, _ast.AsyncFunctionDef))\n' +
        '            for n in _ast.walk(__tail)):\n' +
        '            __lines = __c.split("\\n")\n' +
        '            __head = "\\n".join(__lines[: __tail.lineno - 1] + [__lines[__tail.lineno - 1][: __tail.col_offset]])\n' +
        '            if __head.strip():\n' +
        '                exec(__head, globals())\n' +
        '            __r = eval(_ast.unparse(__tail.value), globals())\n' +
        '            if __r is not None:\n' +
        '                print(repr(__r))\n' +
        '        else:\n' +
        '            exec(__c, globals())\n' +
        'except BaseException as __e:\n' +
        '    # Show the user\u2019s own source lines (the raw REPL traceback\n' +
        '    # only exposes the base64 wrapper line, which is useless for\n' +
        '    # debugging), then re-raise so the kernel prints the real stack.\n' +
        `    print('${this.errorMarker}')\n` +
        '    print("Traceback (most recent call last):")\n' +
        '    for __i, __ln in enumerate(__c.split("\\n"), 1):\n' +
        '        print(f"  File \\"<user_code>\\", line {__i}")\n' +
        '        print(f"    {__ln}")\n' +
        '    print(f"{type(__e).__name__}: {__e}")\n' +
        '    raise';
      const wrapperB64 = Buffer.from(wrapperPy, 'utf8').toString('base64');
      // Warnings queued by the previous call (skipped snapshot, failed
      // restore) are flushed first so they lead this call's output; the
      // error marker printed by the wrapper is the only isError signal.
      const codeWithDone =
        this.hostHandlers !== undefined
          ? `_flush_warnings()\nexec(__import__('base64').b64decode('${wrapperB64}').decode(), globals())\nprint('${this.doneMarker}')\n_snapshot()\n`
          : `exec(__import__('base64').b64decode('${wrapperB64}').decode(), globals())\nprint('${this.doneMarker}')\n`;
      const writeOk = proc.stdin!.write(codeWithDone);
      if (!writeOk) {
        await new Promise<void>((resolve) => {
          const onError = () => resolve();
          // If the kernel died before draining (EPIPE / closed stdin), the
          // 'drain' event would never fire and this promise would hang the
          // tool call forever — resolve on stdin close instead.
          proc.stdin!.once('close', onError);
          proc.stdin!.once('error', onError);
          proc.stdin!.once('drain', () => {
            proc.stdin!.off('close', onError);
            proc.stdin!.off('error', onError);
            resolve();
          });
        });
      }
      const { lines, found } = await this.readUntilMarker(proc.stdout, this.doneMarker, timeoutMs, {
        signal,
        replyPid: proc.pid,
      });
      // The error marker is the single source of truth for isError (printed by
      // the wrapper before it re-raises); it never reaches the output.
      const hadErrorMarker = lines.some((line) => line.includes(this.errorMarker));
      const output = lines
        .filter(
          (line) =>
            !line.includes(this.doneMarker) &&
            !line.includes(this.errorMarker) &&
            !line.trimStart().startsWith('>>> ') &&
            !line.trimStart().startsWith('... '),
        )
        .join('\n')
        .trim();
      // stderr arrives asynchronously; drain until it is quiet (bounded) so
      // tracebacks land in the snapshot for this execution instead of the
      // next one. Consuming by offset (not reset) keeps an older kernel's
      // late stderr from polluting a newer kernel's snapshot.
      await this.drainStderrQuiet(proc);
      const stderr = this.kernelStderr
        .slice(this.kernelStderrOffset)
        .split('\n')
        .filter(
          (line) =>
            !line.trimStart().startsWith('>>> ') &&
            !line.trimStart().startsWith('... ') &&
            !line.trimStart().startsWith('Python ') &&
            !line.trimStart().startsWith('Type "help"'),
        )
        .join('\n')
        .trim();
      this.kernelStderrOffset = this.kernelStderr.length;
      const merged = [output, stderr].filter((part) => part.length > 0).join('\n');
      if (!found) {
        // No DONE marker: either the deadline fired, the caller aborted, or
        // the kernel died. An abort reuses the same SIGINT route — the goal
        // is identical (unwind the statement, keep the kernel alive).
        const aborted = isAborted(signal);
        // Record where the pre-interrupt stderr ended; the SIGINT itself may
        // emit a KeyboardInterrupt traceback right after, which should be
        // surfaced in the message (not swallowed into the offset).
        const preInterruptOffset = this.kernelStderrOffset;
        // Graceful interrupt: SIGINT (Ctrl-C equivalent) unwinds the running
        // statement and returns to the REPL prompt without killing the
        // kernel, so accumulated state survives. On Windows this is skipped:
        // Node's kill('SIGINT') is only emulated there and does not reliably
        // deliver a real signal to a pipe-driven python child, so the grace
        // wait would burn the full 1.5s then restart anyway — just restart.
        const exited =
          process.platform === 'win32'
            ? true
            : await this.interruptKernel(proc, INTERRUPT_GRACE_MS);
        const restarted = (): ExecutableToolResult => ({
          isError: true,
          output: aborted
            ? `Interrupted by ${interruptedBy(signal)}; kernel restarted.${merged.length > 0 ? `\n${truncateOutput(merged)}` : ''}`
            : `Python execution timed out after ${Math.round(timeoutMs / 1000)}s (kernel restarted).\n${truncateOutput(merged)}`,
        });
        if (exited) {
          // The kernel process is gone. Restart on the next call.
          void proc.kill('SIGKILL');
          this.kernel = undefined;
          return restarted();
        }
        // Kernel still alive: SIGINT unwound the statement and the REPL is
        // back at the prompt with state intact. However, the interrupt may
        // leave residual queued output behind — the DONE marker written
        // before the interrupt, an in-flight traceback — which would poison
        // the next execution's marker scan. Drain stdout until the REPL is
        // idle again (a fresh sync marker round-trip), then commit the
        // stderr offset so nothing stale leaks into the next call. The sync
        // read deliberately ignores the abort signal: the kernel must reach
        // a clean idle state before this call returns.
        if (!(await this.syncKernel(proc))) {
          // The kernel did not return to an idle prompt even after SIGINT —
          // it is genuinely hung. Restart it so the next call starts clean.
          void proc.kill('SIGKILL');
          this.kernel = undefined;
          return restarted();
        }
        await this.drainStderrQuiet(proc);
        // Surface the KeyboardInterrupt traceback emitted by the SIGINT.
        const interruptStderr = this.kernelStderr
          .slice(preInterruptOffset)
          .split('\n')
          .filter(
            (line) =>
              !line.trimStart().startsWith('>>> ') &&
              !line.trimStart().startsWith('... ') &&
              !line.trimStart().startsWith('Python ') &&
              !line.trimStart().startsWith('Type "help"'),
          )
          .join('\n')
          .trim();
        this.kernelStderrOffset = this.kernelStderr.length;
        const tailMerged = [merged, interruptStderr].filter((part) => part.length > 0).join('\n');
        if (aborted) {
          return {
            isError: true,
            output: `Interrupted by ${interruptedBy(signal)}; kernel state preserved.${tailMerged.length > 0 ? `\n${truncateOutput(tailMerged)}` : ''}`,
          };
        }
        return {
          isError: true,
          output: `Python execution timed out after ${Math.round(timeoutMs / 1000)}s (kernel interrupted; state preserved).\n${truncateOutput(tailMerged)}`,
        };
      }
      const finalOutput = truncateOutput(merged);
      return { isError: hadErrorMarker, output: finalOutput.length > 0 ? finalOutput : '(no output)' };
    } finally {
      this.kernelBusy = false;
    }
  }

  /**
   * Sends SIGINT to the kernel and waits (up to `graceMs`) for it to exit.
   * Returns true when the process exited — meaning the kernel is gone and a
   * fresh one must be started; false when it is still alive after the signal,
   * which for `python3 -i` means the REPL interrupted the running statement
   * and is ready again with state intact.
   *
   * `proc.killed` is NOT used as an exit check: it flips true the first time
   * `kill()` is called, so on a second timeout it would falsely report the
   * process as exited. Only `exitCode`/`signalCode` reflect a real exit.
   */
  private interruptKernel(proc: ChildProcess, graceMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const exited = () => resolve(true);
      const onExit = () => {
        clearTimeout(timer);
        exited();
      };
      const timer = setTimeout(() => {
        proc.off('exit', onExit);
        resolve(false);
      }, graceMs);
      proc.once('exit', onExit);
      proc.kill('SIGINT');
    });
  }

  /**
   * Round-trips a sync marker through the (interrupted) kernel: writes
   * `print('<sync marker>')` and waits for it to appear on stdout. Any
   * residual queued output (a DONE marker written before the timeout, a
   * partially-flushed traceback) is consumed by the same read loop, so the
   * next execution starts from a clean marker state. Returns true when the
   * marker came back — the REPL is idle and reusable.
   */
  private async syncKernel(proc: ChildProcess, timeoutMs = 3000): Promise<boolean> {
    const writeOk = proc.stdin!.write(`print('${this.syncMarker}')\n`);
    if (!writeOk) {
      await new Promise<void>((resolve) => {
        const onError = () => resolve();
        proc.stdin!.once('close', onError);
        proc.stdin!.once('error', onError);
        proc.stdin!.once('drain', () => {
          proc.stdin!.off('close', onError);
          proc.stdin!.off('error', onError);
          resolve();
        });
      });
    }
    const { found } = await this.readUntilMarker(proc.stdout, this.syncMarker, timeoutMs);
    return found;
  }

  /** Waits (bounded) for stderr to go quiet so tracebacks settle before the
   * execution snapshot is committed. */
  private async drainStderrQuiet(proc: ChildProcess, quietMs = 40, capMs = 400): Promise<void> {
    const start = Date.now();
    let quietSince = Date.now();
    while (Date.now() - start < capMs) {
      const before = this.kernelStderr.length;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (this.kernelStderr.length === before) {
        if (Date.now() - quietSince >= quietMs) return;
      } else {
        quietSince = Date.now();
      }
    }
    void proc;
  }
}
