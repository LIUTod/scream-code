import type { Jian, JianProcess } from '@scream-code/jian';

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
  private contentLength = -1;
  private started = false;

  constructor(
    private readonly command: string[],
    private readonly workspaceRoot: string,
    private readonly jian: Jian,
    private readonly initializationOptions?: Record<string, unknown>,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.command.length === 0) {
      throw new Error('LSP command is empty');
    }

    try {
      this.process = await this.jian.exec(...this.command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start language server ${this.command[0]}: ${message}`, {
        cause: error,
      });
    }

    this.process.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.processMessages();
    });

    this.process.stderr.on('data', (chunk: Buffer) => {
      // Ignore stderr noise from language servers.
      void chunk;
    });

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
    this.notify('initialized', {});
  }

  async stop(): Promise<void> {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('LSP client stopped'));
    }
    this.pending.clear();

    if (this.process === undefined) return;
    try {
      this.notify('shutdown', {});
      this.notify('exit', {});
      await this.process.kill('SIGTERM');
    } catch {
      // Already exited or not killable.
    }
    this.process = undefined;
    this.openedDocuments.clear();
    this.documentVersion.clear();
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
        if (match === null) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = Number(match[1]);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;
      const raw = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(raw) as JsonRpcMessage;
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
