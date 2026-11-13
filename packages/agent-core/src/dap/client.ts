/**
 * Minimal Debug Adapter Protocol (DAP) client.
 *
 * Transport: one child process spawned through Jian, with the protocol
 * travelling over its stdio using the same `Content-Length` framing as LSP
 * (see `utils/content-length-framing.ts`). Requests are correlated by
 * `seq` / `request_seq`; events are queued so a `stopped` that arrives before
 * the caller starts waiting is never lost.
 *
 * Protocol notes that shape this client:
 *
 *   - The adapter answers `launch` only after `configurationDone`, so `launch`
 *     deliberately does NOT await its response. `configurationDone` waits for
 *     its own response and then gives the launch response a short grace so an
 *     invalid launch surfaces as an error instead of a silent "running".
 *   - `attach` answers once the debuggee is connected, so it is awaited.
 *   - Every request has a timeout (`requestTimeoutMs`, 10s by default) and an
 *     event wait has its own timeout, so a debugger that stops answering can
 *     never hang the tool forever.
 *   - The spawned process is registered with the session's process supervisor
 *     (the same owner-record bookkeeping LSP uses) and killed on `disconnect`/
 *     `dispose`, so no orphaned adapter survives a session.
 */

import type { Jian, JianProcess } from '@scream-code/jian';

import { LSP_OWNER_TOKEN_ENV, type LspProcessSupervisor } from '../lsp/process-supervisor';
import {
  createFrameParser,
  writeFrame,
  type FrameParser,
} from '../utils/content-length-framing';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Grace given to the `launch` response once `configurationDone` answered. */
const LAUNCH_RESPONSE_GRACE_MS = 2_000;
/** Bounded graceful stop before the adapter is hard-killed. */
const STOP_GRACE_MS = 3_000;
/** Unconsumed events kept for later waits; older ones are dropped. */
const MAX_QUEUED_EVENTS = 128;
/** Stderr tail kept for error messages (`no module named debugpy`, tracebacks). */
const STDERR_TAIL_BYTES = 4_096;

export interface DapEvent {
  readonly event: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface DapBreakpoint {
  readonly verified: boolean;
  readonly line?: number | undefined;
  readonly message?: string | undefined;
}

export interface DapStackFrame {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly sourcePath?: string | undefined;
  readonly sourceName?: string | undefined;
}

export interface DapScope {
  readonly name: string;
  readonly variablesReference: number;
  readonly expensive: boolean;
}

export interface DapVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string | undefined;
  readonly variablesReference: number;
}

export interface DapEvaluation {
  readonly result: string;
  readonly type?: string | undefined;
}

export interface DapLaunchSpec {
  readonly python: readonly string[];
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stopOnEntry: boolean;
  readonly justMyCode?: boolean | undefined;
}

export interface DapClientOptions {
  readonly jian: Jian;
  /** Full adapter command line (executable + arguments). */
  readonly command: readonly string[];
  /** Recorded in the owner record of the spawned adapter process. */
  readonly workspaceRoot: string;
  readonly supervisor?: LspProcessSupervisor | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

/** The call was cancelled by the turn's abort signal. */
export class DapAbortedError extends Error {
  constructor() {
    super('Debug operation aborted');
    this.name = 'DapAbortedError';
  }
}

interface DapMessage {
  readonly type?: string | undefined;
  readonly command?: string | undefined;
  readonly request_seq?: number | undefined;
  readonly success?: boolean | undefined;
  readonly message?: string | undefined;
  readonly body?: unknown;
  readonly event?: string | undefined;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (body: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface EventWaiter {
  readonly names: ReadonlySet<string>;
  readonly deliver: (event: DapEvent) => void;
  readonly fail: (error: Error) => void;
}

/** `undefined`-safe record access for protocol bodies. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export class DapClient {
  private process: JianProcess | undefined;
  private nextSeq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly parser: FrameParser;
  private readonly listeners = new Set<(event: DapEvent) => void>();
  private readonly waiters = new Set<EventWaiter>();
  private queuedEvents: DapEvent[] = [];
  private stderrTail = '';
  private exitCode: number | null = null;
  private disposed = false;
  private launchResponse: Promise<void> | undefined;
  private launchError: Error | undefined;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: DapClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.parser = createFrameParser((message) => {
      this.handleMessage(message as DapMessage);
    });
  }

  /** OS process id of the adapter, once spawned (tests assert teardown on it). */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /** True once the adapter process has exited. */
  get hasExited(): boolean {
    return this.exitCode !== null;
  }

  /** Spawn the adapter. Idempotent. */
  async start(): Promise<void> {
    if (this.process !== undefined) return;
    if (this.disposed) throw new Error('Debug session is closed.');
    const { jian, command, supervisor } = this.options;
    const executable = command[0];
    if (executable === undefined) throw new Error('Debug adapter command is empty.');

    let proc: JianProcess;
    try {
      const argv = [...command];
      proc = await (supervisor === undefined
        ? jian.exec(...argv)
        : jian.execWithEnv(argv, { [LSP_OWNER_TOKEN_ENV]: supervisor.ownerId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start the debug adapter (${executable}): ${message}`, {
        cause: error,
      });
    }

    this.process = proc;
    proc.stdout.on('data', (chunk: Buffer) => {
      this.parser.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // Register before the handshake so the owner record and exit hooks cover
    // the whole session, exactly like the LSP client does.
    supervisor?.register(proc, this.options.workspaceRoot, executable);
    void proc
      .wait()
      .then((code) => {
        this.onAdapterExit(code);
      })
      .catch(() => {
        this.onAdapterExit(null);
      });
  }

  /** Register a raw event listener; returns the unsubscribe function. */
  onEvent(listener: (event: DapEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Handshake and session control ─────────────────────────────────

  async initialize(): Promise<Record<string, unknown>> {
    const body = await this.request('initialize', {
      clientID: 'scream-code',
      clientName: 'Scream Code',
      adapterID: 'debugpy',
      locale: 'en-US',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: false,
      supportsArgsCanBeInterpretedByShell: false,
    });
    return asRecord(body);
  }

  /**
   * Start a debuggee through the adapter. The response is NOT awaited here —
   * adapters answer only after `configurationDone`, so awaiting would
   * deadlock the breakpoint handshake. `configurationDone` surfaces a failed
   * launch instead.
   */
  launch(spec: DapLaunchSpec): void {
    const arguments_: Record<string, unknown> = {
      python: [...spec.python],
      program: spec.program,
      args: [...spec.args],
      cwd: spec.cwd,
      console: 'internalConsole',
      stopOnEntry: spec.stopOnEntry,
      justMyCode: spec.justMyCode ?? true,
    };
    this.launchError = undefined;
    this.launchResponse = this.request('launch', arguments_).then(
      () => {
        // Success: the debuggee is under way.
      },
      (error: unknown) => {
        this.launchError = error instanceof Error ? error : new Error(String(error));
      },
    );
  }

  /** Attach to a debuggee whose debug server listens on `127.0.0.1:<port>`. */
  async attach(port: number, timeoutMs = this.requestTimeoutMs): Promise<void> {
    await this.request('attach', { host: '127.0.0.1', port }, timeoutMs);
  }

  /**
   * Tell the adapter the configuration phase is over. Waits for its own
   * response and then briefly for the `launch` response, so an invalid launch
   * (missing program, bad argument) is reported instead of looking like a
   * debugger that simply kept running.
   */
  async configurationDone(): Promise<void> {
    await this.request('configurationDone', {});
    if (this.launchResponse !== undefined) {
      await Promise.race([this.launchResponse, sleep(LAUNCH_RESPONSE_GRACE_MS)]);
    }
    if (this.launchError !== undefined) {
      const error = this.launchError;
      this.launchError = undefined;
      throw error;
    }
  }

  async setBreakpoints(path: string, lines: readonly number[]): Promise<DapBreakpoint[]> {
    const body = asRecord(
      await this.request('setBreakpoints', {
        source: { path },
        breakpoints: lines.map((line) => ({ line })),
        sourceModified: false,
      }),
    );
    return asArray(body['breakpoints']).map((entry) => {
      const record = asRecord(entry);
      return {
        verified: record['verified'] === true,
        line: typeof record['line'] === 'number' ? record['line'] : undefined,
        message: stringField(record, 'message'),
      };
    });
  }

  async continue_(threadId: number): Promise<{ readonly allThreadsContinued: boolean }> {
    const body = asRecord(await this.request('continue', { threadId, singleThread: false }));
    return { allThreadsContinued: body['allThreadsContinued'] === true };
  }

  async stackTrace(threadId: number, levels = 20): Promise<DapStackFrame[]> {
    const body = asRecord(
      await this.request('stackTrace', { threadId, startFrame: 0, levels }),
    );
    return asArray(body['stackFrames']).map((entry) => {
      const record = asRecord(entry);
      const source = asRecord(record['source']);
      return {
        id: numberField(record, 'id', 0),
        name: stringField(record, 'name') ?? '<anonymous>',
        line: numberField(record, 'line', 0),
        column: numberField(record, 'column', 0),
        sourcePath: stringField(source, 'path'),
        sourceName: stringField(source, 'name'),
      };
    });
  }

  async scopes(frameId: number): Promise<DapScope[]> {
    const body = asRecord(await this.request('scopes', { frameId }));
    return asArray(body['scopes']).map((entry) => {
      const record = asRecord(entry);
      return {
        name: stringField(record, 'name') ?? '<scope>',
        variablesReference: numberField(record, 'variablesReference', 0),
        expensive: record['expensive'] === true,
      };
    });
  }

  async variables(variablesReference: number): Promise<DapVariable[]> {
    const body = asRecord(await this.request('variables', { variablesReference }));
    return asArray(body['variables']).map((entry) => {
      const record = asRecord(entry);
      return {
        name: stringField(record, 'name') ?? '<value>',
        value: stringField(record, 'value') ?? '',
        type: stringField(record, 'type'),
        variablesReference: numberField(record, 'variablesReference', 0),
      };
    });
  }

  async evaluate(expression: string, frameId?: number): Promise<DapEvaluation> {
    const arguments_: Record<string, unknown> = { expression, context: 'repl' };
    if (frameId !== undefined) arguments_['frameId'] = frameId;
    const body = asRecord(await this.request('evaluate', arguments_));
    return {
      result: stringField(body, 'result') ?? '',
      type: stringField(body, 'type'),
    };
  }

  /**
   * Wait for the next event named in `names`. Events that arrived earlier are
   * served first, so a `stopped` fired during the launch handshake is not
   * lost. Resolves `undefined` on timeout; rejects on abort or if the adapter
   * dies while waiting.
   */
  waitForEvent(
    names: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal | undefined,
  ): Promise<DapEvent | undefined> {
    const wanted = new Set(names);
    const queuedIndex = this.queuedEvents.findIndex((event) => wanted.has(event.event));
    if (queuedIndex !== -1) {
      const [event] = this.queuedEvents.splice(queuedIndex, 1);
      return Promise.resolve(event);
    }
    if (this.exitCode !== null) {
      return Promise.reject(this.adapterExitedError());
    }
    if (signal?.aborted === true) return Promise.reject(new DapAbortedError());

    return new Promise<DapEvent | undefined>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      let waiter: EventWaiter;
      const onAbort = (): void => {
        settle();
        reject(new DapAbortedError());
      };
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(waiter);
      };
      waiter = {
        names: wanted,
        deliver: (event) => {
          settle();
          resolve(event);
        },
        fail: (error) => {
          settle();
          reject(error);
        },
      };
      timer = setTimeout(() => {
        settle();
        resolve(undefined);
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  /** Close the session: `disconnect`, SIGTERM, then SIGKILL. Idempotent. */
  async disconnect(): Promise<void> {
    const proc = this.process;
    if (this.disposed) return;
    this.disposed = true;
    if (proc !== undefined) {
      try {
        await this.request('disconnect', { terminateDebuggee: true, restart: false }, STOP_GRACE_MS);
      } catch {
        // Adapter already gone or unresponsive; the kill below is the answer.
      }
    }
    this.rejectPending(new Error('Debug session closed.'));
    this.failWaiters(new Error('Debug session closed.'));
    await this.stopProcess();
  }

  /** Hard teardown without protocol niceties (abort path / test cleanup). */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.rejectPending(new Error('Debug session closed.'));
    this.failWaiters(new Error('Debug session closed.'));
    await this.stopProcess();
  }

  /** Last bytes the adapter wrote to stderr (surfaced in error messages). */
  get stderrOutput(): string {
    return this.stderrTail.trim();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private request(
    command: string,
    arguments_: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const proc = this.process;
    if (proc === undefined) return Promise.reject(new Error('Debug adapter is not running.'));
    const seq = ++this.nextSeq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP request '${command}' timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
      try {
        writeFrame(proc.stdin, { seq, type: 'request', command, arguments: arguments_ });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(message: DapMessage): void {
    if (message.type === 'response') {
      const requestSeq = message.request_seq;
      if (requestSeq === undefined) return;
      const pending = this.pending.get(requestSeq);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestSeq);
      if (message.success === false) {
        pending.reject(
          new Error(message.message ?? `DAP request '${pending.command}' failed.`),
        );
      } else {
        pending.resolve(message.body ?? {});
      }
      return;
    }

    if (message.type !== 'event') return;
    const event: DapEvent = {
      event: message.event ?? '',
      body: asRecord(message.body),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener must never break the protocol loop.
      }
    }
    for (const waiter of this.waiters) {
      if (waiter.names.has(event.event)) {
        waiter.deliver(event);
        return;
      }
    }
    this.queuedEvents.push(event);
    if (this.queuedEvents.length > MAX_QUEUED_EVENTS) {
      this.queuedEvents = this.queuedEvents.slice(-MAX_QUEUED_EVENTS);
    }
  }

  private onAdapterExit(code: number | null): void {
    this.exitCode = code ?? 0;
    const error = this.adapterExitedError();
    this.rejectPending(error);
    this.failWaiters(error);
  }

  private adapterExitedError(): Error {
    const tail = this.stderrTail.trim();
    const suffix = tail.length > 0 ? `\n${tail}` : '';
    return new Error(`Debug adapter exited (code ${String(this.exitCode ?? 0)}).${suffix}`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failWaiters(error: Error): void {
    // `fail()` removes the waiter from the set; deleting the current element
    // during iteration is safe in JS and keeps this allocation-free.
    for (const waiter of this.waiters) waiter.fail(error);
    this.waiters.clear();
  }

  private async stopProcess(): Promise<void> {
    this.parser.reset();
    const proc = this.process;
    this.process = undefined;
    if (proc === undefined || proc.pid <= 0) return;
    try {
      await proc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    try {
      await Promise.race([proc.wait(), sleep(STOP_GRACE_MS)]);
    } catch {
      // Ignore wait failures.
    }
    if (proc.exitCode === null) {
      try {
        await proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.options.supervisor?.unregister(proc.pid);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
