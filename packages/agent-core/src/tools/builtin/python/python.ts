import { spawn, type ChildProcess } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const PY_DONE_MARKER = '__SCREAM_PY_DONE__';
const BOOT_DONE_MARKER = '__SCREAM_BOOT_DONE__';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const KERNEL_START_TIMEOUT_MS = 30_000;

export const PythonInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'Python code to execute in the persistent kernel. Variables, imports, and loaded ' +
        'data persist across calls, unlike Bash. State is kept for the whole session while ' +
        'the /rlm mode is enabled.',
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
}

// Bootstrap defines the rlm()/rlm_wait() bridge helpers. The Python source is
// kept as a multi-line template for readability, but injected as a single
// base64-decoded exec() line — the interactive REPL never sees multi-line
// block input (which requires blank-line terminators between defs and would
// otherwise hang or raise).
const RLM_BOOTSTRAP_PY = `import json, os, sys, tempfile, time, itertools, pickle
_RLM_ID = itertools.count(1)
_SNAP = __SNAP_PATH__

def _host_request(method, payload, timeout=120):
    rid = next(_RLM_ID)
    sys.stdout.write(json.dumps({"type": "host_request", "id": rid, "method": method, "payload": payload}) + "\\n")
    sys.stdout.flush()
    reply_file = os.path.join(tempfile.gettempdir(), "scream-rlm-" + str(os.getpid()) + "-" + str(rid) + ".json")
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
        with open(path, "wb") as f:
            pickle.dump(saved, f)
        return len(saved)
    except Exception:
        return 0

def _restore(path=_SNAP):
    if not os.path.exists(path):
        return 0
    try:
        with open(path, "rb") as f:
            saved = pickle.load(f)
    except Exception:
        return 0
    for k, v in saved.items():
        globals()[k] = v
    return len(saved)

_restore()
`;

/** Builds the single-line bootstrap exec for this tool instance, embedding
 * the snapshot path so each PythonTool has its own persistent state file. */
function buildRlmBootstrap(snapshotPath: string): string {
  const py = RLM_BOOTSTRAP_PY.replace('__SNAP_PATH__', JSON.stringify(snapshotPath));
  return `exec(__import__('base64').b64decode('${Buffer.from(py).toString('base64')}').decode())\nprint("__SCREAM_BOOT_DONE__")`;
}


/**
 * Executes Python code in a persistent interactive kernel (`python3 -u -i`
 * over a pipe). The kernel process is lazily started on first use and lives
 * for the lifetime of this tool instance (the /rlm session), so variables,
 * imports, and loaded data survive across calls — unlike the stateless Bash
 * tool. Runs under the normal permission mode like any other tool; the code
 * can read/write files, so it is gated exactly like a mutating tool.
 */
export class PythonTool implements BuiltinTool<PythonInput> {
  readonly name = 'python' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PythonInputSchema);

  private kernel: ChildProcess | undefined;
  private kernelBusy = false;
  /** Accumulated stderr from the kernel (tracebacks land here). */
  private kernelStderr = '';
  /** Bytes of kernelStderr consumed by the last execution (race-safe drain). */
  private kernelStderrOffset = 0;
  /** Per-instance snapshot file so RLM state survives kernel restarts. */
  private readonly snapshotPath: string;
  private readonly hostHandlers: HostRequestHandlers | undefined;

  constructor(
    private readonly cwd: string,
    private readonly options: PythonToolOptions = {},
  ) {
    this.hostHandlers = options.hostHandlers;
    this.snapshotPath =
      options.snapshotPath ??
      join(
        tmpdir(),
        `scream-rlm-state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.pkl`,
      );
    this.description =
      'Execute Python code in a persistent kernel. Variables, imports, and loaded data ' +
      'persist across calls (unlike Bash) — ideal for data analysis and multi-step ' +
      'processing. Run shell commands with the Bash tool instead. In RLM mode the ' +
      'kernel also provides `rlm(task, name="subagent")` to spawn a subagent ' +
      '(returns a handle immediately) and `rlm_wait(handle, timeout)` to await its ' +
      'final summary. The kernel is a line-oriented REPL: multi-line blocks ' +
      '(def/for/if) written as separate lines can fail with SyntaxError, so ' +
      'write orchestration code as single-line statements (list comprehensions, ' +
      'single-line assignments) or ensure blocks are complete and terminated by ' +
      'a blank line. Code runs under the current permission mode; mutating ' +
      'operations follow the same approval rules as other tools.';
  }

  dispose(): void {
    // Cancel any in-flight rlm() subagents (host-side convention hook) before
    // killing the kernel, so children do not keep burning tokens with no
    // consumer after teardown.
    if (this.hostHandlers !== undefined) {
      void this.hostHandlers['__dispose__']?.({}).catch(() => {});
    }
    void this.kernel?.kill('SIGKILL');
    this.kernel = undefined;
    this.kernelBusy = false;
    this.kernelStderr = '';
    this.kernelStderrOffset = 0;
    // Remove this instance's snapshot file so RLM state does not accumulate
    // in the tmpdir across sessions.
    void unlink(this.snapshotPath).catch(() => {});
  }

  /** Lazily starts the persistent kernel. The banner and REPL prompts are
   * emitted on stderr (not stdout), so we drain stderr continuously and drop
   * the startup banner; stdout only carries print() output. */
  private async ensureKernel(): Promise<ChildProcess> {
    if (this.kernel !== undefined && this.kernel.exitCode === null) return this.kernel;
    this.kernelBusy = false;
    this.kernelStderr = '';
    this.kernelStderrOffset = 0;
    const proc = spawn('python3', ['-u', '-i'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.kernel = proc;
    // A missing python3 (ENOENT) or a kernel that dies instantly emits an
    // 'error' event; without a listener it would crash the agent process.
    // Attach the listener here so ensureKernel can detect the failure and
    // surface a real message instead of an unhandled 'error' event.
    let spawnError: Error | undefined;
    proc.on('error', (error) => {
      spawnError = error;
    });
    // When the process fails to spawn (e.g. python3 not installed), Node
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
      proc.stdin.write(`${buildRlmBootstrap(this.snapshotPath)}\n`);
      const boot = await this.readUntilMarker(proc.stdout, '__SCREAM_BOOT_DONE__', KERNEL_START_TIMEOUT_MS);
      if (!boot.found) {
        // Bootstrap failed (missing python3, SyntaxError in the injected
        // helpers, or a kernel that died on startup). Kill the process so a
        // broken kernel is never reused, and surface the captured error.
        void proc.kill('SIGKILL');
        this.kernel = undefined;
        throw new Error(
          `Python kernel failed to start: ${spawnError?.message ?? 'bootstrap did not complete'}`,
        );
      }
    }
    return proc;
  }

  private drainStderr(proc: ChildProcess): void {
    const decoder = new StringDecoder('utf8');
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.kernelStderr += decoder.write(chunk);
    });
  }

  /**
   * Reads stdout until `marker` appears (or the deadline passes). Uses the
   * 'data' event instead of an async iterator: a `for await` that returns
   * early destroys the stream, which breaks the next call on the same
   * persistent kernel. `'data'` keeps the stream alive across calls.
   */
  private async readUntilMarker(
    stream: Readable | null,
    marker: string,
    timeoutMs: number,
  ): Promise<{ lines: string[]; found: boolean }> {
    if (stream === null) return { lines: [], found: false };
    return new Promise((resolve) => {
      const lines: string[] = [];
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      const cleanup = () => {
        clearTimeout(timer);
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('close', onEnd);
        stream.off('error', onEnd);
      };
      const finish = (found: boolean) => {
        cleanup();
        resolve({ lines, found });
      };
      // The stream ending/closeing/erroring means the kernel process died
      // mid-call; settle immediately instead of making the caller wait out
      // the full timeout for a marker that will never arrive.
      const onEnd = () => finish(false);
      const onData = (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          if (line.includes(marker)) return finish(true);
          if (line.includes('"host_request"')) {
            void this.handleHostRequest(line, stream).catch(() => {
              /* best-effort: a failed bridge request must not break the loop */
            });
            continue;
          }
          lines.push(line);
        }
        if (buffer.includes(marker)) {
          lines.push(buffer);
          buffer = '';
          return finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('close', onEnd);
      stream.on('error', onEnd);
    });
  }

  /**
   * Handles a kernel `host_request` line: invokes the registered handler and
   * writes the reply to the kernel's expected reply file (the kernel polls
   * that file — replies must not go over stdin, which is used for code input
   * and would race with the REPL). Fire-and-forget from the read loop.
   */
  /** Writes a bridge reply to the kernel's expected reply file. Uses the
   * pid captured when the request was received: if the kernel is restarted
   * (timeout kill) while a bridge handler is still running, the late reply
   * must still land in the file the originating kernel is polling. */
  private writeHostReply(pid: number | undefined, id: number, body: Record<string, unknown>): void {
    if (pid === undefined) return;
    const file = join(tmpdir(), `scream-rlm-${pid}-${id}.json`);
    void writeFile(file, JSON.stringify({ type: 'host_reply', id, ...body }), 'utf8').catch(() => {
      /* best-effort: a failed reply write surfaces as a kernel timeout */
    });
  }

  private async handleHostRequest(line: string, stream: Readable | null): Promise<void> {
    // Capture the pid of the kernel that issued this request up front. The
    // reply must be written to the file that *this* kernel is polling; if
    // the kernel is restarted while the handler runs, `this.kernel` would
    // point at the new process and the reply would be lost.
    const replyPid = this.kernel?.pid;
    if (replyPid === undefined) return;
    let parsed: { id?: number; method?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line) as { id?: number; method?: string; payload?: Record<string, unknown> };
    } catch {
      return; // not a valid bridge line — ignore
    }
    const { id, method, payload } = parsed;
    if (typeof id !== 'number' || typeof method !== 'string' || payload === undefined) return;
    const handler = this.hostHandlers?.[method];
    if (handler === undefined) {
      this.writeHostReply(replyPid, id, { error: `no handler for ${method}` });
      return;
    }
    try {
      const result = await handler(payload);
      this.writeHostReply(replyPid, id, { result });
    } catch (error) {
      this.writeHostReply(replyPid, id, { error: error instanceof Error ? error.message : String(error) });
    }
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

  private async execution(args: PythonInput, _ctx: ExecutableToolContext): Promise<ExecutableToolResult> {
    if (this.kernelBusy) {
      return {
        output:
          'The Python kernel is busy executing a previous call. Wait for it to finish, or stop it with TaskStop.',
      };
    }
    this.kernelBusy = true;
    try {
      const proc = await this.ensureKernel();
      const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      // A blank line terminates any open multi-line block in the interactive
      // REPL, so the DONE marker always runs on its own statement. When RLM
      // state snapshots are active (hostHandlers present), the snapshot is
      // taken after the user code completes, so kernel restarts can restore it.
      const codeWithDone =
        this.hostHandlers !== undefined
          ? `${args.code}\n\nprint('${PY_DONE_MARKER}')\n_snapshot()\n`
          : `${args.code}\n\nprint('${PY_DONE_MARKER}')\n`;
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
      const { lines, found } = await this.readUntilMarker(proc.stdout, PY_DONE_MARKER, timeoutMs);
      const output = lines
        .filter(
          (line) =>
            !line.includes(PY_DONE_MARKER) &&
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
        // Record where the pre-interrupt stderr ended; the SIGINT itself may
        // emit a KeyboardInterrupt traceback right after, which should be
        // surfaced in the timeout message (not swallowed into the offset).
        const preInterruptOffset = this.kernelStderrOffset;
        // Graceful interrupt first: SIGINT (Ctrl-C equivalent) unwinds the
        // running statement and returns to the REPL prompt without killing
        // the kernel, so accumulated state survives. interruptKernel returns
        // true only when the process actually exited.
        const exited = await this.interruptKernel(proc, 1500);
        if (exited) {
          // The kernel process is gone. Restart on the next call.
          void proc.kill('SIGKILL');
          this.kernel = undefined;
          return {
            isError: true,
            output: `Python execution timed out after ${Math.round(timeoutMs / 1000)}s (kernel restarted).\n${merged}`,
          };
        }
        // Kernel still alive: SIGINT unwound the statement and the REPL is
        // back at the prompt with state intact. However, the interrupt may
        // leave residual queued output behind — the DONE marker written
        // before the timeout, an in-flight traceback — which would poison
        // the next execution's marker scan. Drain stdout until the REPL is
        // idle again (a fresh sync marker round-trip), then commit the
        // stderr offset so nothing stale leaks into the next call.
        if (!(await this.syncKernel(proc))) {
          // The kernel did not return to an idle prompt even after SIGINT —
          // it is genuinely hung. Restart it so the next call starts clean.
          void proc.kill('SIGKILL');
          this.kernel = undefined;
          return {
            isError: true,
            output: `Python execution timed out after ${Math.round(timeoutMs / 1000)}s (kernel restarted).\n${merged}`,
          };
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
        const timedOutMerged = [merged, interruptStderr].filter((part) => part.length > 0).join('\n');
        return {
          isError: true,
          output: `Python execution timed out after ${Math.round(timeoutMs / 1000)}s (kernel interrupted; state preserved).\n${timedOutMerged}`,
        };
      }
      const isError = merged.includes('Traceback') || merged.toLowerCase().includes('error:');
      return { isError, output: merged.length > 0 ? merged : '(no output)' };
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
   * `print('__SCREAM_SYNC__')` and waits for it to appear on stdout. Any
   * residual queued output (a DONE marker written before the timeout, a
   * partially-flushed traceback) is consumed by the same read loop, so the
   * next execution starts from a clean marker state. Returns true when the
   * marker came back — the REPL is idle and reusable.
   */
  private async syncKernel(proc: ChildProcess, timeoutMs = 3000): Promise<boolean> {
    const SYNC_MARKER = '__SCREAM_SYNC__';
    const writeOk = proc.stdin!.write(`print('${SYNC_MARKER}')\n`);
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
    const { found } = await this.readUntilMarker(proc.stdout, SYNC_MARKER, timeoutMs);
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
