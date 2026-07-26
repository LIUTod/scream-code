/**
 * Scream Web UI server.
 *
 * Embeds a ScreamHarness instance and exposes it over HTTP + WebSocket.
 * The HTTP server serves a single-page chat UI; the WebSocket server
 * provides bidirectional communication (events out, prompts/approvals in).
 *
 * Phase 1 productization:
 * - In-memory event journal with monotonic seq/epoch for reconnect replay.
 * - Multi-connection broadcast (multiple browser tabs can watch the same session).
 * - Heartbeat/ping-pong to detect half-open connections.
 * - REST snapshot endpoint for fresh clients or resync.
 * - Abort button wired to session.cancel().
 *
 * Architecture: agent-core is fully UI-agnostic. This module is a third
 * consumer of the same SDK (alongside run-shell TUI and run-stream-json),
 * not a separate engine. Zero changes to agent-core or node-sdk.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

import {
  ScreamHarness,
  resolveScreamHome,
  log,
  type Session,
  type Event,
  type SessionStatus,
  type PermissionMode,
} from '@scream-code/scream-code-sdk';
import { setLocale } from '@scream-code/config';

import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { createScreamCodeHostIdentity } from '#/cli/version';

// ─── Types ────────────────────────────────────────────────────────────────

export interface WebServerOptions {
  readonly port: number;
  readonly workDir: string;
  readonly model?: string;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly open: boolean;
  readonly skillsDirs: string[];
}

interface JournalEntry {
  readonly seq: number;
  readonly epoch: number;
  readonly volatile: boolean;
  readonly payload: Event;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tools: ToolMessage[];
  isError?: boolean;
}

interface ToolMessage {
  toolCallId: string;
  name: string;
  args: unknown;
  output?: string;
  isError?: boolean;
}

interface ApprovalRequestMessage {
  readonly id: string;
  readonly toolName: string;
  readonly action?: string;
  readonly display?: unknown;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly workDir: string;
  readonly model: string;
  readonly permission: PermissionMode;
  readonly messages: ChatMessage[];
  readonly pendingApprovals: ApprovalRequestMessage[];
  readonly status: SessionStatus;
}

interface ConnectionState {
  ws: WebSocket;
  lastPongAt: number;
  subscribed: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 2 * HEARTBEAT_INTERVAL_MS;
const API_PREFIX = '/api/v1';

const contentTypes: Record<string, string> = {
  js: 'application/javascript',
  mjs: 'application/javascript',
  css: 'text/css',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
};

// Volatility classification

// ─── Volatility classification ────────────────────────────────────────────

function isVolatileEvent(event: Event): boolean {
  // High-frequency streaming deltas are volatile: replaying all of them on
  // reconnect is wasteful and often redundant. The snapshot already contains
  // the latest rendered state.
  switch (event.type) {
    case 'assistant.delta':
    case 'thinking.delta':
    case 'tool.call.delta':
    case 'tool.progress':
      return true;
    default:
      return false;
  }
}

// ─── WebSession ───────────────────────────────────────────────────────────

class WebSession {
  readonly sessionId: string;
  readonly workDir: string;
  readonly permission: PermissionMode;

  private readonly session: Session;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly journal: JournalEntry[] = [];
  private readonly userMessages: Array<{ readonly msg: ChatMessage; readonly beforeSeq: number }> = [];
  private nextSeq = 1;
  private epoch = 1;
  private cachedStatus: SessionStatus | null = null;

  private readonly pendingApprovals = new Map<
    string,
    (response: {
      decision: 'approved' | 'rejected';
      scope?: 'session';
      feedback?: string;
    }) => void
  >();

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;

  constructor(
    session: Session,
    readonly opts: {
      readonly workDir: string;
      readonly permission: PermissionMode;
      readonly yolo: boolean;
    },
  ) {
    this.session = session;
    this.sessionId = session.id;
    this.workDir = opts.workDir;
    this.permission = opts.permission;

    void this.refreshStatus();
    this.subscribeEvents();
    this.setupApprovalHandler();
    this.startHeartbeat();
  }

  // ── Event journal ──────────────────────────────────────────────────────

  private appendEvent(event: Event): JournalEntry {
    const entry: JournalEntry = {
      seq: this.nextSeq++,
      epoch: this.epoch,
      volatile: isVolatileEvent(event),
      payload: event,
    };
    this.journal.push(entry);
    return entry;
  }

  private subscribeEvents(): void {
    this.unsubscribe = this.session.onEvent((event) => {
      if (event.type === 'turn.started') {
        this.busy = true;
      } else if (event.type === 'turn.ended') {
        this.busy = false;
      }
      // Cache status-related events so snapshot stays cheap.
      if (event.type === 'session.meta.updated' || event.type === 'turn.ended') {
        void this.refreshStatus();
      }
      const entry = this.appendEvent(event);
      this.broadcast({ type: 'event', seq: entry.seq, epoch: entry.epoch, payload: event }, entry.volatile);
    });
  }

  private async refreshStatus(): Promise<void> {
    try {
      this.cachedStatus = await this.session.getStatus();
    } catch {
      // Ignore; snapshot will fall back to default.
    }
  }

  // ── Connections ────────────────────────────────────────────────────────

  addConnection(ws: WebSocket): void {
    const state: ConnectionState = {
      ws,
      lastPongAt: Date.now(),
      subscribed: false,
    };
    this.connections.set(ws, state);

    ws.on('pong', () => {
      state.lastPongAt = Date.now();
    });

    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, state, data);
    });

    ws.on('close', () => {
      this.removeConnection(ws);
    });

    ws.on('error', (err) => {
      log.warn('web: ws error', { sessionId: this.sessionId, error: String(err) });
      this.removeConnection(ws);
    });

    // Say hello and tell the client how to sync.
    this.send(ws, {
      type: 'server_hello',
      heartbeat_ms: HEARTBEAT_INTERVAL_MS,
      epoch: this.epoch,
      sessionId: this.sessionId,
      workDir: this.workDir,
    });
  }

  private removeConnection(ws: WebSocket): void {
    this.connections.delete(ws);
    // Do not reject pending approvals when a tab closes; other tabs may still
    // be watching the same session. Only reject if all tabs disconnect.
    if (this.connections.size === 0) {
      for (const [, resolve] of this.pendingApprovals) {
        resolve({ decision: 'rejected', feedback: 'Browser disconnected' });
      }
      this.pendingApprovals.clear();
    }
  }

  private broadcast(message: unknown, _volatile: boolean): void {
    const text = JSON.stringify(message);
    for (const [ws, state] of this.connections) {
      if (state.subscribed && ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      }
    }
  }

  private send(ws: WebSocket, message: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  // ── Message handling ───────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, state: ConnectionState, data: Buffer): void {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(data.toString()) as { type: string; [key: string]: unknown };
    } catch {
      return;
    }

    switch (msg.type) {
      case 'client_hello': {
        const lastSeq = typeof msg['lastSeq'] === 'number' ? (msg['lastSeq'] as number) : 0;
        const epoch = typeof msg['epoch'] === 'number' ? (msg['epoch'] as number) : 0;
        this.syncConnection(ws, lastSeq, epoch);
        state.subscribed = true;
        break;
      }
      case 'prompt': {
        const text = msg['text'] as string;
        const clientMessageId = msg['clientMessageId'] as string | undefined;
        if (!text || this.busy) {
          this.send(ws, { type: 'error', code: 'session.busy', message: 'Session is busy' });
          return;
        }
        this.userMessages.push({ msg: { role: 'user', content: text, tools: [] }, beforeSeq: this.nextSeq });
        // Broadcast user message so all connected tabs stay in sync.
        this.broadcast({ type: 'user_message', clientMessageId, text }, false);
        void this.session.prompt(text).catch((error: unknown) => {
          this.sendError(ws, error);
        });
        break;
      }
      case 'abort': {
        void this.session.cancel().catch((error: unknown) => {
          this.sendError(ws, error);
        });
        break;
      }
      case 'approval_response': {
        const id = msg['id'] as string;
        const decision = msg['decision'] as 'approved' | 'rejected';
        const handler = this.pendingApprovals.get(id);
        if (handler) {
          this.pendingApprovals.delete(id);
          handler({
            decision,
            scope: decision === 'approved' ? 'session' : undefined,
          });
          // Notify all connected tabs that this approval is resolved.
          this.broadcast({ type: 'approval_resolved', id }, false);
        }
        break;
      }
      case 'pong':
        state.lastPongAt = Date.now();
        break;
      default:
        break;
    }
  }

  private syncConnection(ws: WebSocket, lastSeq: number, epoch: number): void {
    // Brand-new clients send lastSeq=0/epoch=0; replay the whole durable journal.
    const isFreshClient = lastSeq === 0 && epoch === 0;
    if (!isFreshClient && epoch !== this.epoch) {
      this.send(ws, { type: 'resync_required', reason: 'epoch_changed' });
      return;
    }
    if (!isFreshClient && (lastSeq < 0 || lastSeq >= this.nextSeq)) {
      this.send(ws, { type: 'resync_required', reason: 'seq_out_of_range' });
      return;
    }

    // Replay durable events since lastSeq. Volatile events are not replayed;
    // the client should fetch the snapshot for the latest rendered state.
    const missing = this.journal.slice(lastSeq);
    for (const entry of missing) {
      if (!entry.volatile) {
        this.send(ws, { type: 'event', seq: entry.seq, epoch: entry.epoch, payload: entry.payload });
      }
    }
  }

  private sendError(ws: WebSocket, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.send(ws, { type: 'error', message });
  }

  // ── Approvals ──────────────────────────────────────────────────────────

  private setupApprovalHandler(): void {
    this.session.setApprovalHandler((request) => {
      if (this.opts.yolo) {
        return { decision: 'approved' };
      }
      if (this.connections.size === 0) {
        return { decision: 'rejected', feedback: 'No browser connected' };
      }
      return new Promise((resolve) => {
        const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.pendingApprovals.set(id, resolve);
        const payload: ApprovalRequestMessage = {
          id,
          toolName: request.toolName,
          action: request.action,
          display: request.display,
        };
        // Broadcast approval request to all connected tabs.
        this.broadcast(
          { type: 'approval_request', ...payload },
          false,
        );
      });
    });
    this.session.setQuestionHandler(() => null);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [ws, state] of this.connections) {
        if (now - state.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
          log.warn('web: heartbeat timeout, closing connection', { sessionId: this.sessionId });
          ws.terminate();
          continue;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ── Snapshot ───────────────────────────────────────────────────────────

  getSnapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      workDir: this.workDir,
      model: this.cachedStatus?.model ?? 'unknown',
      permission: this.permission,
      messages: this.buildMessages(),
      pendingApprovals: Array.from(this.pendingApprovals.entries()).map(([id, _]) => {
        // We don't store full approval metadata after broadcasting; for the
        // snapshot we return what we can reconstruct from pending handlers.
        return { id, toolName: 'pending', action: undefined, display: undefined };
      }),
      status: this.cachedStatus ?? {
        model: 'unknown',
        thinkingLevel: 'none',
        permission: this.permission,
        planMode: false,
        wolfpackMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      },
    };
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  private buildMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let currentAssistant: ChatMessage | null = null;
    let userIndex = 0;

    const flushUserMessagesBefore = (seq: number): void => {
      while (userIndex < this.userMessages.length) {
        const item = this.userMessages[userIndex];
        if (item === undefined || item.beforeSeq > seq) break;
        messages.push(item.msg);
        userIndex++;
      }
    };

    for (const entry of this.journal) {
      const event = entry.payload;
      flushUserMessagesBefore(entry.seq);
      switch (event.type) {
        case 'turn.started':
          currentAssistant = { role: 'assistant', content: '', tools: [] };
          messages.push(currentAssistant);
          break;
        case 'assistant.delta':
          if (currentAssistant) {
            currentAssistant.content += event.delta;
          }
          break;
        case 'tool.call.started': {
          if (currentAssistant) {
            currentAssistant.tools.push({
              toolCallId: event.toolCallId,
              name: event.name,
              args: event.args,
            });
          }
          break;
        }
        case 'tool.result': {
          if (currentAssistant) {
            const tool = currentAssistant.tools.find((t) => t.toolCallId === event.toolCallId);
            if (tool) {
              tool.output = String(event.output);
              tool.isError = event.isError;
            }
          }
          break;
        }
        case 'turn.ended':
          if (event.reason === 'failed' && currentAssistant) {
            currentAssistant.isError = true;
          }
          currentAssistant = null;
          break;
        default:
          break;
      }
    }

    for (let i = userIndex; i < this.userMessages.length; i++) {
      const item = this.userMessages[i];
      if (item !== undefined) messages.push(item.msg);
    }

    return messages;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [, resolve] of this.pendingApprovals) {
      resolve({ decision: 'rejected', feedback: 'Server shutting down' });
    }
    this.pendingApprovals.clear();
    this.unsubscribe?.();
    for (const [ws] of this.connections) {
      ws.terminate();
    }
    this.connections.clear();
    await this.session.close({ extractMemories: false });
  }
}

// ─── Server entrypoint ────────────────────────────────────────────────────

export async function runWebServer(opts: WebServerOptions): Promise<void> {
  const homeDir = resolveScreamHome();
  const workDir = opts.workDir;

  const harness = new ScreamHarness({
    homeDir,
    identity: createScreamCodeHostIdentity('dev'),
    uiMode: 'print',
    skillDirs: opts.skillsDirs,
  });

  // Load tui config for locale + subagent model bindings (same as stream-json).
  try {
    const tuiConfig = await loadTuiConfig();
    setLocale(tuiConfig.language);
    harness.setSubagentModelBindings(() => tuiConfig.subagentModels);
  } catch (error) {
    if (error instanceof TuiConfigParseError) {
      setLocale(error.fallback.language);
    } else {
      throw error;
    }
  }

  await harness.ensureConfigFile();
  const config = await harness.getConfig();

  const permission: PermissionMode = opts.yolo ? 'yolo' : opts.auto ? 'auto' : 'manual';
  const session = await harness.createSession({
    workDir,
    model: opts.model ?? config.defaultModel,
    permission,
  });

  log.info('web: session created', { sessionId: session.id, workDir });

  const webSession = new WebSession(session, { workDir, permission, yolo: opts.yolo });

  // ── HTTP server: serve the chat page and REST API ──────────────────────
  const baseDir = import.meta.dirname;
  const prodPublicDir = join(baseDir, '..', 'public');
  const devPublicDir = join(baseDir, 'frontend', 'dist');
  let publicDir = prodPublicDir;
  try {
    await access(join(devPublicDir, 'index.html'));
    publicDir = devPublicDir;
  } catch {
    // Fall back to prodPublicDir below.
  }
  const httpServer: HttpServer = createServer(async (req: IncomingMessage, res) => {
    const url = req.url ?? '/';

    // REST API
    const snapshotMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/snapshot$`).exec(url);
    if (snapshotMatch && req.method === 'GET') {
      const sessionId = snapshotMatch[1];
      if (sessionId !== webSession.sessionId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(webSession.getSnapshot()));
      return;
    }

    // Static assets from the Vite build output
    if (url === '/' || url === '/index.html') {
      try {
        const html = await readFile(join(publicDir, 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to load web UI. Did you run pnpm web:build?');
      }
      return;
    }

    // Serve other static assets (JS/CSS/fonts) from the build output.
    const safeUrl = url.replaceAll(/\?.*$/g, '').replaceAll(/\.{2,}/g, '');
    try {
      const filePath = join(publicDir, safeUrl);
      const ext = filePath.split('.').pop() ?? '';
      const contentType = contentTypes[ext] ?? 'application/octet-stream';
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  // ── WebSocket server ───────────────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket) => {
    webSession.addConnection(ws);
    log.info('web: client connected', { sessionId: webSession.sessionId, connections: webSession.connectionCount });
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      wss.close();
      await webSession.close();
      await harness.close();
    } catch {
      // Best-effort
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve();
      });
    });
  };

  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void cleanup().finally(() => process.exit(0));
  });

  // ── Start ──────────────────────────────────────────────────────────────
  httpServer.listen(opts.port, () => {
    const url = `http://localhost:${opts.port}`;
    // eslint-disable-next-line no-console
    console.log(
      `\n  Scream Web UI ready: ${url}\n` +
        `  Working directory: ${workDir}\n` +
        `  Session: ${session.id}\n` +
        `  Permission: ${opts.yolo ? 'yolo' : opts.auto ? 'auto' : 'manual'}\n`,
    );
    if (opts.open) {
      const openCmd =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${openCmd} ${url}`);
    }
  });
}
