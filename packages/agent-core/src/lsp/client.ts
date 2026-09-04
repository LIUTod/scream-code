import type { Jian, JianProcess } from '@scream-code/jian';
import { spawnSync } from 'node:child_process';

import { LSP_OWNER_TOKEN_ENV, type LspProcessSupervisor } from './process-supervisor';

export interface LspLocation {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export interface LspDiagnostic {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export interface LspTextEdit {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly newText: string;
}

export interface LspTextDocumentEdit {
  readonly textDocument: { readonly uri: string; readonly version?: number | null };
  readonly edits: LspTextEdit[];
}

export type LspDocumentChange = LspTextDocumentEdit;

export interface LspWorkspaceEdit {
  readonly changes?: Record<string, LspTextEdit[]>;
  readonly documentChanges?: LspDocumentChange[];
}

/** Result of `workspace/symbol`: one matched symbol with its location. */
export interface LspSymbol {
  readonly name: string;
  readonly kind: number;
  readonly location: LspLocation;
  readonly containerName?: string;
}

interface JsonRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const SEVERITY_LABELS = ['Error', 'Warning', 'Information', 'Hint'];
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Bounded grace for a graceful SIGTERM before SIGKILL escalation. */
const STOP_GRACE_MS = 5_000;

export class LspClient {
  private process: JianProcess | undefined;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private collectedDiagnostics = new Map<string, LspDiagnostic[]>();
  private openedDocuments = new Set<string>();
  private documentVersion = new Map<string, number>();
  private buffer = '';
  private bufferBytes = 0;
  private contentLength = -1;
  private started = false;
  private stopRequested = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly command: string[],
    private readonly workspaceRoot: string,
    private readonly jian: Jian,
    private readonly initializationOptions?: Record<string, unknown>,
    private readonly supervisor?: LspProcessSupervisor,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopRequested = false;
    // A previous stop() may have set a (resolved) stopPromise; a restarted
    // client must not short-circuit its next stop() on that stale promise,
    // or the fresh process would never be torn down.
    this.stopPromise = undefined;

    if (this.command.length === 0) {
      throw new Error('LSP command is empty');
    }

    const proc = await this.spawn();
    this.process = proc;
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.buffer += text;
      this.bufferBytes += Buffer.byteLength(text, 'utf8');
      this.processMessages();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      // Ignore stderr noise from language servers.
      void chunk;
    });

    // Register with the supervisor right after spawn so the exit hooks and
    // owner record cover the whole handshake window. Natural exit releases
    // the entry on its own. `command[0]` is safe: the empty-command guard ran
    // before spawn.
    if (this.supervisor !== undefined && proc.pid > 0) {
      this.supervisor.register(proc, this.workspaceRoot, this.command[0]!);
    }

    if (this.stopRequested) {
      // stop() raced the spawn — bail out and clean up instead of leaving a
      // tracked, uninitialized server running.
      try {
        await proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      this.supervisor?.unregister(proc.pid);
      this.process = undefined;
      throw new Error('LSP client stopped');
    }

    try {
      await this.request('initialize', {
        processId: process.pid,
        rootUri: pathToUri(this.workspaceRoot),
        capabilities: {
          textDocument: {
            synchronization: { willSave: false, willSaveWaitUntil: false, didSave: false },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: false,
              tagSupport: { valueSet: [1, 2] },
              codeDescriptionSupport: true,
              dataSupport: true,
            },
            rename: { prepareSupport: false },
          },
        },
        initializationOptions: this.initializationOptions,
      });
    } catch (error) {
      // Handshake failed — the server is unusable; kill it and release the
      // ownership entry so nothing lingers after start() throws.
      try {
        await proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      this.supervisor?.unregister(proc.pid);
      this.process = undefined;
      throw error;
    }
    this.notify('initialized', {});
  }

  /** Spawn the server, injecting the owner token when a supervisor is set. */
  private async spawn(): Promise<JianProcess> {
    try {
      if (this.supervisor !== undefined) {
        return await this.jian.execWithEnv(this.command, {
          [LSP_OWNER_TOKEN_ENV]: this.supervisor.ownerId,
        });
      }
      return await this.jian.exec(...this.command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start language server ${this.command[0]}: ${message}`, {
        cause: error,
      });
    }
  }

  async stop(): Promise<void> {
    // Idempotent and single-flight: concurrent closers share one teardown.
    this.stopRequested = true;
    if (this.stopPromise !== undefined) return this.stopPromise;

    this.stopPromise = (async () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('LSP client stopped'));
      }
      this.pending.clear();
      this.collectedDiagnostics.clear();
      this.openedDocuments.clear();
      this.documentVersion.clear();
      this.started = false;
      this.buffer = '';
      this.bufferBytes = 0;
      this.contentLength = -1;

      const proc = this.process;
      if (proc === undefined) return;
      try {
        await this.request('shutdown', {});
      } catch {
        // Server may have exited or be unresponsive; proceed to kill.
      }
      try {
        this.notify('exit', {});
      } catch {
        // Ignore notification failures.
      }
      try {
        await proc.kill('SIGTERM');
      } catch {
        // Already exited or not killable.
      }
      // Bounded grace, then hard-kill the process group: a server that
      // ignores SIGTERM must not keep running after close() returns.
      try {
        await Promise.race([proc.wait(), sleep(STOP_GRACE_MS)]);
      } catch {
        // Ignore wait failures.
      }
      if (proc.exitCode === null) {
        try {
          await proc.kill('SIGKILL');
        } catch {
          // Already exited.
        }
      }
      // Clear AFTER the protocol phase — send() short-circuits on undefined
      // and would silently drop the shutdown/exit messages above. Guard with
      // identity so a stale stop closure (start() already restarted this
      // client) cannot clobber the fresh process handle.
      if (this.process === proc) {
        this.process = undefined;
      }
      this.supervisor?.unregister(proc.pid);
    })();
    return this.stopPromise;
  }

  /** Synchronous group kill — used by exit-path hooks when async work is unsafe. */
  killSync(): void {
    const proc = this.process;
    this.process = undefined;
    this.stopRequested = true;
    if (proc === undefined || proc.pid <= 0) return;
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } catch {
        // Best effort only; nothing else to fall back to synchronously.
      }
      return;
    }
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.supervisor?.unregister(proc.pid);
  }

  didOpen(path: string, content: string, languageId: string): void {
    const uri = pathToUri(path);
    if (this.openedDocuments.has(uri)) {
      this.didChange(path, content);
      return;
    }
    this.openedDocuments.add(uri);
    this.documentVersion.set(uri, 1);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });
  }

  didChange(path: string, content: string): void {
    const uri = pathToUri(path);
    const version = (this.documentVersion.get(uri) ?? 1) + 1;
    this.documentVersion.set(uri, version);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  async references(
    path: string,
    line: number,
    character: number,
    includeDeclaration: boolean,
  ): Promise<LspLocation[]> {
    const result = (await this.request('textDocument/references', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character },
      context: { includeDeclaration },
    })) as LspLocation[] | null;
    return result ?? [];
  }

  async definition(path: string, line: number, character: number): Promise<LspLocation[]> {
    const result = (await this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character },
    })) as LspLocation | LspLocation[] | null;
    if (result === null) return [];
    return Array.isArray(result) ? result : [result];
  }

  /**
   * Search workspace symbols by (fuzzy) name via `workspace/symbol`. The
   * query semantics are server-defined: prefix, fuzzy, or token match.
   */
  async workspaceSymbols(query: string, timeoutMs = 30_000): Promise<LspSymbol[]> {
    interface RawSymbolInformation {
      readonly name: string;
      readonly kind: number;
      readonly containerName?: string;
      readonly location: LspLocation | { readonly uri: string };
    }
    const result = (await this.requestWithTimeout('workspace/symbol', { query }, timeoutMs)) as
      | RawSymbolInformation[]
      | null;
    if (result === null) return [];
    return result.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      containerName: symbol.containerName,
      // `SymbolInformation.location` is a full Location per spec, but some
      // servers answer with a bare uri; normalize so callers stay simple.
      location:
        'range' in symbol.location
          ? symbol.location
          : {
              uri: symbol.location.uri,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
    }));
  }

  async rename(
    path: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspWorkspaceEdit | null> {
    const result = (await this.request('textDocument/rename', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character },
      newName,
    })) as LspWorkspaceEdit | null;
    return result;
  }

  /**
   * Cheap workspace/symbol probe used to detect whether the server has
   * loaded a project. `workspace/symbol` servers commonly error with
   * "No Project" until at least one file was opened and ingested; the probe
   * distinguishes that state from a working (possibly empty) result.
   *
   * Uses a short dedicated timeout: before the project loads, tsserver may
   * not reply at all, and waiting out the default 120s request timeout here
   * would stall every caller for minutes.
   */
  async hasLoadedProject(query = 'index', timeoutMs = 2_000): Promise<boolean> {
    try {
      await this.requestWithTimeout('workspace/symbol', { query }, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** `request` with a caller-provided timeout (default is the class-wide one). */
  private requestWithTimeout(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async diagnostics(path: string, timeoutMs = 5000): Promise<LspDiagnostic[]> {
    const uri = pathToUri(path);
    this.collectedDiagnostics.delete(uri);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const collected = this.collectedDiagnostics.get(uri);
      if (collected !== undefined) {
        return collected;
      }
      await sleep(100);
    }

    return this.collectedDiagnostics.get(uri) ?? [];
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(message: Omit<JsonRpcMessage, 'jsonrpc'>): void {
    if (this.process === undefined) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
    const data = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    this.process.stdin.write(data);
  }

  private processMessages(): void {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = this.buffer.slice(0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        const headerEndChar = headerEnd + 4;
        const droppedHeader = this.buffer.slice(0, headerEndChar);
        this.bufferBytes -= Buffer.byteLength(droppedHeader, 'utf8');
        this.buffer = this.buffer.slice(headerEndChar);
        if (match === null) {
          continue;
        }
        this.contentLength = Number(match[1]);
      }

      if (this.bufferBytes < this.contentLength) return;
      const { text, consumedChars, consumedBytes } = sliceByBytes(this.buffer, this.contentLength);
      this.buffer = this.buffer.slice(consumedChars);
      this.bufferBytes -= consumedBytes;
      this.contentLength = -1;

      try {
        const message = JSON.parse(text) as JsonRpcMessage;
        this.handleMessage(message);
      } catch {
        // Ignore malformed messages.
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics' && message.params !== undefined) {
      const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.collectedDiagnostics.set(params.uri, params.diagnostics);
    }
  }
}

export function pathToUri(path: string): string {
  if (path.startsWith('file://')) return path;

  const windowsDriveMatch = /^([A-Za-z]):[\\/]/.exec(path);
  if (windowsDriveMatch !== null) {
    const drive = windowsDriveMatch[1]!.toUpperCase();
    const rest = path.slice(windowsDriveMatch[0].length).replaceAll('\\', '/');
    return `file:///${drive}:${rest.startsWith('/') ? rest : `/${rest}`}`;
  }

  const absolute = path.startsWith('/') ? path : `/${path}`;
  return `file://${absolute}`;
}

/**
 * Convert a `file://` URI back to a filesystem path. Tolerates
 * percent-encoded characters and lax servers that send raw paths.
 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let filePath = uri.slice('file://'.length);
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // Invalid percent-encoding — treat as a literal path.
  }
  if (process.platform === 'win32' && filePath.startsWith('/') && /^[A-Za-z]:/.test(filePath.slice(1))) {
    filePath = filePath.slice(1);
  }
  return filePath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function byteLengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Slice `targetBytes` worth of UTF-8 from the head of `text`.
 *
 * LSP `Content-Length` is a byte count, but JS strings are UTF-16 code units.
 * Slicing by `string.length` misaligns messages containing multi-byte chars
 * (Chinese diagnostics, emoji). This walks code points, summing UTF-8 bytes,
 * and never splits a multi-byte character mid-sequence so `JSON.parse` won't
 * choke on a half-character.
 */
function sliceByBytes(
  text: string,
  targetBytes: number,
): { readonly text: string; readonly consumedChars: number; readonly consumedBytes: number } {
  let chars = 0;
  let bytes = 0;
  while (chars < text.length && bytes < targetBytes) {
    const codePoint = text.codePointAt(chars);
    if (codePoint === undefined) break;
    const charLen = codePoint > 0xffff ? 2 : 1;
    const charBytes = byteLengthOfCodePoint(codePoint);
    if (bytes + charBytes > targetBytes) break;
    bytes += charBytes;
    chars += charLen;
  }
  return { text: text.slice(0, chars), consumedChars: chars, consumedBytes: bytes };
}

export function formatLocation(location: LspLocation): string {
  const uri = location.uri.startsWith('file://') ? location.uri.slice(7) : location.uri;
  const { start } = location.range;
  return `- ${uri}:${start.line + 1}:${start.character + 1}`;
}

export function formatDiagnostic(diagnostic: LspDiagnostic): string {
  const { start } = diagnostic.range;
  const severity =
    diagnostic.severity !== undefined ? SEVERITY_LABELS[diagnostic.severity - 1] ?? 'Unknown' : 'Diagnostic';
  return `- ${severity} at ${start.line + 1}:${start.character + 1}: ${diagnostic.message}`;
}
