/**
 * Scream Web UI server.
 *
 * Embeds a ScreamHarness instance and exposes it over HTTP + WebSocket.
 * Spawned by `scream web` CLI subcommand via runWebServer.
 *
 * Multi-session productization:
 * - Multi-session management (SessionManager + Map<sessionId, WebSession>).
 * - Journal persistence to ~/.scream/web-sessions/<id>.jsonl.
 * - REST API: list/create/delete sessions, export to Markdown.
 * - WS routing by ?sessionId= query parameter.
 *
 * Architecture: agent-core is fully UI-agnostic. This module is a third
 * consumer of the same SDK (alongside run-shell TUI and run-stream-json),
 * not a separate engine. Zero changes to agent-core or node-sdk.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { readFile, writeFile, access, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

interface JournalEntry {
  readonly seq: number;
  readonly epoch: number;
  readonly volatile: boolean;
  readonly payload: Event;
}

interface PersistedUserMessage {
  readonly type: 'user_message';
  readonly text: string;
  readonly beforeSeq: number;
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
  readonly busy: boolean;
  readonly createdAt: number;
  readonly title: string;
}

interface SessionListItem {
  readonly sessionId: string;
  readonly workDir: string;
  readonly title: string;
  readonly createdAt: number;
  readonly messageCount: number;
  readonly active: boolean;
}

interface SessionMetadata {
  readonly sessionId: string;
  readonly workDir: string;
  readonly title: string;
  readonly createdAt: number;
  readonly model: string;
  readonly permission: PermissionMode;
}

interface ModelListItem {
  readonly alias: string;
  readonly provider: string;
  readonly model: string;
  readonly displayName?: string | undefined;
  readonly maxContextSize: number;
  readonly thinkingLevels?: readonly string[] | undefined;
}

interface ModelListResponse {
  readonly models: ModelListItem[];
  readonly defaultModel?: string | undefined;
  readonly defaultThinking: boolean;
  readonly thinkingEffort?: string | undefined;
}

/** Error carrying an HTTP status code for REST handlers. */
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
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

/** Thinking levels accepted by the /thinking endpoint (mirrors ThinkingEffort). */
const VALID_THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max']);

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

// ─── HTTP helpers ─────────────────────────────────────────────────────────

/** Reads and parses a JSON request body (64 KiB cap). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
      if (data.length > 64 * 1024) {
        reject(new HttpError(413, 'Request body too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ─── Volatility classification ────────────────────────────────────────────

function isVolatileEvent(event: Event): boolean {
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

// ─── Persistence helpers ──────────────────────────────────────────────────

function getSessionsDir(homeDir: string): string {
  return join(homeDir, 'web-sessions');
}

function getJournalPath(homeDir: string, sessionId: string): string {
  return join(getSessionsDir(homeDir), `${sessionId}.jsonl`);
}

function getMetaPath(homeDir: string, sessionId: string): string {
  return join(getSessionsDir(homeDir), `${sessionId}.meta.json`);
}

async function ensureSessionsDir(homeDir: string): Promise<void> {
  const dir = getSessionsDir(homeDir);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function appendJournalLine(homeDir: string, sessionId: string, line: string): Promise<void> {
  try {
    await writeFile(getJournalPath(homeDir, sessionId), line + '\n', { flag: 'a' });
  } catch (error) {
    log.warn('web: failed to persist journal line', { sessionId, error: String(error) });
  }
}

async function saveMetadata(homeDir: string, meta: SessionMetadata): Promise<void> {
  try {
    await writeFile(getMetaPath(homeDir, meta.sessionId), JSON.stringify(meta, null, 2));
  } catch (error) {
    log.warn('web: failed to save metadata', { sessionId: meta.sessionId, error: String(error) });
  }
}

async function loadMetadata(homeDir: string, sessionId: string): Promise<SessionMetadata | null> {
  try {
    const data = await readFile(getMetaPath(homeDir, sessionId), 'utf-8');
    return JSON.parse(data) as SessionMetadata;
  } catch {
    return null;
  }
}

async function loadJournal(homeDir: string, sessionId: string): Promise<PersistedEntry[]> {
  try {
    const data = await readFile(getJournalPath(homeDir, sessionId), 'utf-8');
    const lines = data.split('\n').filter((l) => l.trim().length > 0);
    const results: PersistedEntry[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as PersistedEntry);
      } catch {
        // Skip corrupt lines instead of dropping entire session history.
        log.warn('web: skipping corrupt journal line', { sessionId });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function listPersistedSessions(homeDir: string): Promise<SessionMetadata[]> {
  const dir = getSessionsDir(homeDir);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
  const metas: SessionMetadata[] = [];
  for (const f of metaFiles) {
    const sessionId = f.replace('.meta.json', '');
    const meta = await loadMetadata(homeDir, sessionId);
    if (meta) metas.push(meta);
  }
  return metas.toSorted((a, b) => b.createdAt - a.createdAt);
}

async function deletePersistedSession(homeDir: string, sessionId: string): Promise<void> {
  try {
    await unlink(getJournalPath(homeDir, sessionId));
  } catch {
    // Ignore
  }
  try {
    await unlink(getMetaPath(homeDir, sessionId));
  } catch {
    // Ignore
  }
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New Session';
  const text = firstUser.content.trim();
  return text.length > 40 ? text.slice(0, 40) + '...' : text;
}

// ─── Git status ───────────────────────────────────────────────────────────

interface GitStatusResult {
  readonly isRepo: boolean;
  readonly branch?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly changed?: number;
  readonly adds?: number;
  readonly dels?: number;
  readonly diffStat?: string;
}

const execFileAsync = promisify(execFile);

async function git(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workDir, ...args], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function getGitStatus(workDir: string): Promise<GitStatusResult> {
  try {
    await git(workDir, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { isRepo: false };
  }

  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let changed = 0;
  try {
    const [branchOut, statusOut] = await Promise.all([
      git(workDir, ['branch', '--show-current']),
      git(workDir, ['status', '--porcelain', '-b']),
    ]);
    branch = branchOut.trim() || undefined;
    const statusLines = statusOut.split('\n').filter((l) => l.length > 0);
    const header = statusLines[0] ?? '';
    const aheadMatch = /ahead (\d+)/.exec(header);
    const behindMatch = /behind (\d+)/.exec(header);
    if (aheadMatch) ahead = Number(aheadMatch[1]);
    if (behindMatch) behind = Number(behindMatch[1]);
    changed = statusLines.filter((l) => !l.startsWith('##')).length;
  } catch {
    // Branch/status failure — fall through with what we have.
  }

  let adds: number | undefined;
  let dels: number | undefined;
  let diffStat: string | undefined;
  try {
    const [numstatOut, diffStatOut] = await Promise.all([
      git(workDir, ['diff', '--numstat', 'HEAD']),
      git(workDir, ['diff', '--stat', 'HEAD']),
    ]);
    adds = 0;
    dels = 0;
    for (const line of numstatOut.split('\n')) {
      const m = /^(\d+)\t(\d+)\t/.exec(line);
      if (m) {
        adds += Number(m[1]);
        dels += Number(m[2]);
      }
    }
    diffStat = diffStatOut.trim().split('\n').slice(0, 200).join('\n') || undefined;
  } catch {
    // No HEAD yet (fresh repo) — diff stats unavailable.
  }

  return { isRepo: true, branch, ahead, behind, changed, adds, dels, diffStat };
}

function exportToMarkdown(messages: ChatMessage[], title: string): string {
  let out = `# ${title}\n\n`;
  for (const msg of messages) {
    if (msg.role === 'user') {
      out += `## User\n\n${msg.content}\n\n`;
    } else {
      out += `## Assistant\n\n${msg.content || '(empty)'}\n\n`;
      for (const tool of msg.tools) {
        if (tool.name === 'thinking') continue;
        out += `### 🔧 ${tool.name}\n\n`;
        if (tool.args) out += '```json\n' + JSON.stringify(tool.args, null, 2) + '\n```\n\n';
        if (tool.output) out += '```\n' + tool.output + '\n```\n\n';
      }
    }
  }
  return out;
}

type PersistedEntry = (JournalEntry & { readonly type: 'journal' }) | PersistedUserMessage;

// ─── WebSession ───────────────────────────────────────────────────────────

class WebSession {
  readonly sessionId: string;
  readonly workDir: string;
  permission: PermissionMode;
  readonly createdAt: number;

  private session: Session | null;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly journal: JournalEntry[] = [];
  private readonly userMessages: Array<{ msg: ChatMessage; beforeSeq: number }> = [];
  private nextSeq = 1;
  private epoch = 1;
  private cachedStatus: SessionStatus | null = null;
  private title = 'New Session';

  private readonly pendingApprovals = new Map<
    string,
    {
      resolve: (response: {
        decision: 'approved' | 'rejected';
        scope?: 'session';
        feedback?: string;
      }) => void;
      toolName: string;
      action?: string;
      display?: unknown;
    }
  >();

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;
  private readonly homeDir: string | null;
  private readonly yolo: boolean;
  /** Fork hook supplied by SessionManager; absent in standalone mode. */
  private readonly onFork?: (sourceId: string) => Promise<{ sessionId: string; title: string } | null>;

  /** Whether the title was set manually via /title and should not be auto-derived. */
  private customTitle = false;

  constructor(
    session: Session | null,
    opts: {
      workDir: string;
      permission: PermissionMode;
      yolo: boolean;
      sessionId: string;
      createdAt: number;
      homeDir?: string;
      title?: string;
      onFork?: (sourceId: string) => Promise<{ sessionId: string; title: string } | null>;
    },
  ) {
    this.session = session;
    this.sessionId = opts.sessionId;
    this.workDir = opts.workDir;
    this.permission = opts.permission;
    this.yolo = opts.yolo;
    this.homeDir = opts.homeDir ?? null;
    this.createdAt = opts.createdAt;
    this.onFork = opts.onFork;
    if (opts.title) this.title = opts.title;

    if (session) {
      void this.refreshStatus();
      this.subscribeEvents();
      this.setupApprovalHandler();
    }
    this.startHeartbeat();
  }

  get isActive(): boolean {
    return this.session !== null;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  getTitle(): string {
    return this.title;
  }

  /** Return in-memory durable journal entries for fork copy (avoids file persistence race). */
  getDurableJournalEntries(): PersistedEntry[] {
    const entries: PersistedEntry[] = [];
    for (const e of this.journal) {
      if (!e.volatile) {
        entries.push({ type: 'journal', ...e });
      }
    }
    for (const um of this.userMessages) {
      entries.push({ type: 'user_message', text: um.msg.content, beforeSeq: um.beforeSeq });
    }
    return entries;
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private async persistEntry(entry: JournalEntry): Promise<void> {
    if (!this.homeDir) return;
    const line = JSON.stringify({ type: 'journal', ...entry });
    await appendJournalLine(this.homeDir, this.sessionId, line);
  }

  private async persistUserMessage(text: string, beforeSeq: number): Promise<void> {
    this.userMessages.push({ msg: { role: 'user', content: text, tools: [] }, beforeSeq });
    if (!this.homeDir) return;
    const line = JSON.stringify({ type: 'user_message', text, beforeSeq } satisfies PersistedUserMessage);
    await appendJournalLine(this.homeDir, this.sessionId, line);
  }

  loadFromPersisted(entries: PersistedEntry[]): void {
    for (const entry of entries) {
      if ('type' in entry && entry.type === 'user_message') {
        const um = entry as PersistedUserMessage;
        this.userMessages.push({ msg: { role: 'user', content: um.text, tools: [] }, beforeSeq: um.beforeSeq });
      } else {
        const je = entry as JournalEntry;
        this.journal.push(je);
        this.nextSeq = Math.max(this.nextSeq, je.seq + 1);
      }
    }
    // Derive title from loaded messages unless a custom title was set.
    const msgs = this.buildMessages();
    if (msgs.length > 0 && !this.customTitle) {
      this.title = deriveTitle(msgs);
    }
  }

  async updateTitle(): Promise<void> {
    if (this.customTitle) return;
    const msgs = this.buildMessages();
    const newTitle = deriveTitle(msgs);
    if (newTitle !== this.title) {
      this.title = newTitle;
      if (this.homeDir) {
        await saveMetadata(this.homeDir, this.getMetadata());
      }
    }
  }

  getMetadata(): SessionMetadata {
    return {
      sessionId: this.sessionId,
      workDir: this.workDir,
      title: this.title,
      createdAt: this.createdAt,
      model: this.cachedStatus?.model ?? 'unknown',
      permission: this.permission,
    };
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
    // Persist durable events only.
    if (!entry.volatile) {
      void this.persistEntry(entry);
    }
    return entry;
  }

  private subscribeEvents(): void {
    if (!this.session) return;
    this.unsubscribe = this.session.onEvent((event) => {
      if (event.type === 'turn.started') {
        this.busy = true;
      } else if (event.type === 'turn.ended') {
        this.busy = false;
        // Update title after each exchange.
        void this.updateTitle();
      }
      if (event.type === 'session.meta.updated' || event.type === 'turn.ended') {
        void this.refreshStatus();
      }
      const entry = this.appendEvent(event);
      this.broadcast({ type: 'event', seq: entry.seq, epoch: entry.epoch, payload: event }, entry.volatile);
    });
  }

  private async refreshStatus(): Promise<void> {
    if (!this.session) return;
    try {
      this.cachedStatus = await this.session.getStatus();
    } catch {
      // Ignore
    }
  }

  // ── Connections ────────────────────────────────────────────────────────

  addConnection(ws: WebSocket): void {
    const state: ConnectionState = { ws, lastPongAt: Date.now(), subscribed: false };
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

    this.send(ws, {
      type: 'server_hello',
      heartbeat_ms: HEARTBEAT_INTERVAL_MS,
      epoch: this.epoch,
      sessionId: this.sessionId,
      workDir: this.workDir,
      active: this.isActive,
      title: this.title,
    });
  }

  private removeConnection(ws: WebSocket): void {
    this.connections.delete(ws);
    if (this.connections.size === 0) {
      for (const [, approval] of this.pendingApprovals) {
        approval.resolve({ decision: 'rejected', feedback: 'Browser disconnected' });
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
        if (!this.session) {
          this.send(ws, { type: 'error', code: 'session.inactive', message: 'Session is archived (read-only)' });
          return;
        }
        if (!text || this.busy) {
          this.send(ws, { type: 'error', code: 'session.busy', message: 'Session is busy' });
          return;
        }
        void this.persistUserMessage(text, this.nextSeq);
        this.broadcast({ type: 'user_message', clientMessageId, text }, false);
        void this.session.prompt(text).catch((error: unknown) => {
          this.sendError(ws, error);
        });
        break;
      }
      case 'abort': {
        if (!this.session) return;
        void this.session.cancel().catch((error: unknown) => {
          this.sendError(ws, error);
        });
        break;
      }
      case 'command': {
        const command = msg['command'] as string;
        const args = typeof msg['args'] === 'string' ? (msg['args'] as string) : undefined;
        const pendingMsgId = typeof msg['pendingMsgId'] === 'string' ? (msg['pendingMsgId'] as string) : undefined;
        void this.handleCommand(ws, command, args, pendingMsgId);
        break;
      }
      case 'approval_response': {
        const id = msg['id'] as string;
        const decision = msg['decision'] as 'approved' | 'rejected';
        const approval = this.pendingApprovals.get(id);
        if (approval) {
          this.pendingApprovals.delete(id);
          const feedback = typeof msg['feedback'] === 'string' ? (msg['feedback'] as string) : undefined;
          const scope = msg['scope'] === 'session' ? 'session' : undefined;
          approval.resolve({ decision, scope: decision === 'approved' ? scope : undefined, feedback });
          this.broadcast({ type: 'approval_resolved', id }, false);
        }
        break;
      }
      case 'ping':
        this.send(ws, { type: 'pong' });
        state.lastPongAt = Date.now();
        break;
      case 'pong':
        state.lastPongAt = Date.now();
        break;
      default:
        break;
    }
  }

  private syncConnection(ws: WebSocket, lastSeq: number, epoch: number): void {
    const isFreshClient = lastSeq === 0 && epoch === 0;
    if (!isFreshClient && epoch !== this.epoch) {
      this.send(ws, { type: 'resync_required', reason: 'epoch_changed' });
      return;
    }
    if (!isFreshClient && (lastSeq < 0 || lastSeq >= this.nextSeq)) {
      this.send(ws, { type: 'resync_required', reason: 'seq_out_of_range' });
      return;
    }
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

  // ── Slash commands ───────────────────────────────────────────────────────

  private async handleCommand(ws: WebSocket, command: string, args?: string, pendingMsgId?: string): Promise<void> {
    const ok = (message: string): void => {
      this.broadcast({ type: 'command_result', command, ok: true, message, pendingMsgId }, false);
    };
    const fail = (message: string): void => {
      this.broadcast({ type: 'command_result', command, ok: false, message, pendingMsgId }, false);
    };
    const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

    if (!this.session) {
      fail('会话已归档（只读），无法执行该命令。');
      return;
    }

    switch (command) {
      case 'compact': {
        if (this.busy) {
          fail('会话忙碌中，无法压缩，请稍后再试。');
          return;
        }
        ok('正在压缩会话上下文…');
        try {
          await this.session.compact();
          await this.refreshStatus();
          ok('会话上下文已压缩。');
        } catch (error) {
          fail(`压缩失败：${errMsg(error)}`);
        }
        return;
      }
      case 'auto':
      case 'yes': {
        const mode: PermissionMode = command === 'auto' ? 'auto' : 'yolo';
        try {
          await this.session.setPermission(mode);
          this.permission = mode;
          await this.refreshStatus();
          ok(`权限模式已切换为 ${mode}`);
        } catch (error) {
          fail(`切换权限失败：${errMsg(error)}`);
        }
        return;
      }
      case 'plan': {
        if (this.busy) {
          fail('会话忙碌中，无法切换计划模式，请稍后再试。');
          return;
        }
        try {
          if (this.cachedStatus === null) await this.refreshStatus();
          const next = !this.cachedStatus?.planMode;
          await this.session.setPlanMode(next);
          await this.refreshStatus();
          ok(`计划模式已${next ? '开启' : '关闭'}`);
        } catch (error) {
          fail(`切换计划模式失败：${errMsg(error)}`);
        }
        return;
      }
      case 'fork': {
        if (this.busy) {
          fail('会话忙碌中，无法 fork，请稍后再试。');
          return;
        }
        if (!this.onFork) {
          fail('当前运行环境不支持 fork。');
          return;
        }
        try {
          // Pass the live agent session.id, not the web sessionId,
          // so fork copies the current agent state (not a stale archived one).
          const result = await this.onFork(this.session.id);
          if (!result) {
            fail('Fork 失败：无法复制当前会话。');
            return;
          }
          ok(`会话已 fork，新会话 ID：${result.sessionId}`);
        } catch (error) {
          fail(`Fork 失败：${errMsg(error)}`);
        }
        return;
      }
      case 'title': {
        const title = args?.trim();
        if (!title) {
          fail('请提供新标题，用法：/title 新标题');
          return;
        }
        this.title = title;
        this.customTitle = true;
        if (this.homeDir) {
          await saveMetadata(this.homeDir, this.getMetadata());
        }
        ok('会话标题已更新');
        return;
      }
      case 'btw': {
        const question = args?.trim();
        if (!question) {
          fail('请提供侧问内容，用法：/btw 你的问题');
          return;
        }
        ok('正在思考侧问题…');
        try {
          const answer = await this.session.sideQuestion(question);
          ok(answer || '（无回复）');
        } catch (error) {
          fail(`侧问失败：${errMsg(error)}`);
        }
        return;
      }
      default:
        fail(`未知命令：/${command}`);
    }
  }

  // ── Approvals ──────────────────────────────────────────────────────────

  private setupApprovalHandler(): void {
    if (!this.session) return;
    this.session.setApprovalHandler((request) => {
      if (this.yolo) {
        return { decision: 'approved' };
      }
      if (this.connections.size === 0) {
        return { decision: 'rejected', feedback: 'No browser connected' };
      }
      return new Promise((resolve) => {
        const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.pendingApprovals.set(id, {
          resolve,
          toolName: request.toolName,
          action: request.action,
          display: request.display,
        });
        const payload: ApprovalRequestMessage = {
          id,
          toolName: request.toolName,
          action: request.action,
          display: request.display,
        };
        this.broadcast({ type: 'approval_request', ...payload }, false);
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
          log.warn('web: heartbeat timeout', { sessionId: this.sessionId });
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
      permission: this.cachedStatus?.permission ?? this.permission,
      messages: this.buildMessages(),
      pendingApprovals: Array.from(this.pendingApprovals.entries()).map(([id, approval]) => ({
        id,
        toolName: approval.toolName,
        action: approval.action,
        display: approval.display,
      })),
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
      busy: this.busy,
      createdAt: this.createdAt,
      title: this.title,
    };
  }

  getListItem(): SessionListItem {
    return {
      sessionId: this.sessionId,
      workDir: this.workDir,
      title: this.title,
      createdAt: this.createdAt,
      messageCount: this.buildMessages().length,
      active: this.isActive,
    };
  }

  /** Latest cached session status (may be null before the first refresh). */
  getStatus(): SessionStatus | null {
    return this.cachedStatus;
  }

  /** Switch the underlying agent session's model, then sync status + metadata. */
  async switchModel(alias: string): Promise<void> {
    if (!this.session) throw new HttpError(409, '会话已归档（只读），无法切换模型。');
    await this.session.setModel(alias);
    await this.refreshStatus();
    this.broadcast({ type: 'status', status: this.cachedStatus }, false);
    if (this.homeDir) {
      await saveMetadata(this.homeDir, this.getMetadata());
    }
  }

  /** Switch the underlying agent session's thinking level, then sync status. */
  async switchThinking(level: string): Promise<void> {
    if (!this.session) throw new HttpError(409, '会话已归档（只读），无法切换思考强度。');
    await this.session.setThinking(level);
    await this.refreshStatus();
    this.broadcast({ type: 'status', status: this.cachedStatus }, false);
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

  getExportMarkdown(): string {
    return exportToMarkdown(this.buildMessages(), this.title);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [, approval] of this.pendingApprovals) {
      approval.resolve({ decision: 'rejected', feedback: 'Server shutting down' });
    }
    this.pendingApprovals.clear();
    this.unsubscribe?.();
    for (const [ws] of this.connections) {
      ws.terminate();
    }
    this.connections.clear();
    if (this.session) {
      await this.session.close({ extractMemories: false });
      this.session = null;
    }
  }

  async delete(): Promise<void> {
    await this.close();
    if (this.homeDir) {
      await deletePersistedSession(this.homeDir, this.sessionId);
    }
  }
}

// ─── SessionManager ───────────────────────────────────────────────────────

class SessionManager {
  private readonly sessions = new Map<string, WebSession>();
  private readonly harness: ScreamHarness;
  private readonly homeDir: string;
  private readonly workDir: string;
  private readonly model: string;
  private readonly permission: PermissionMode;
  private readonly yolo: boolean;

  constructor(opts: {
    harness: ScreamHarness;
    homeDir: string;
    workDir: string;
    model: string;
    permission: PermissionMode;
    yolo: boolean;
  }) {
    this.harness = opts.harness;
    this.homeDir = opts.homeDir;
    this.workDir = opts.workDir;
    this.model = opts.model;
    this.permission = opts.permission;
    this.yolo = opts.yolo;
  }

  async init(): Promise<void> {
    await ensureSessionsDir(this.homeDir);
    // Load persisted sessions as archived (read-only) WebSessions.
    const metas = await listPersistedSessions(this.homeDir);
    for (const meta of metas) {
      const entries = await loadJournal(this.homeDir, meta.sessionId);
      const ws = new WebSession(null, {
        sessionId: meta.sessionId,
        workDir: meta.workDir,
        permission: meta.permission,
        yolo: this.yolo,
        homeDir: this.homeDir,
        createdAt: meta.createdAt,
        title: meta.title,
      });
      ws.loadFromPersisted(entries);
      this.sessions.set(meta.sessionId, ws);
    }
    log.info('web: loaded persisted sessions', { count: this.sessions.size });
  }

  async createSession(): Promise<WebSession> {
    const session = await this.harness.createSession({
      workDir: this.workDir,
      model: this.model,
      permission: this.permission,
    });
    const sessionId = session.id;
    const createdAt = Date.now();
    const webSession = new WebSession(session, {
      sessionId,
      workDir: this.workDir,
      permission: this.permission,
      yolo: this.yolo,
      homeDir: this.homeDir,
      createdAt,
      onFork: (id) => this.forkSession(id),
    });
    await saveMetadata(this.homeDir, webSession.getMetadata());
    this.sessions.set(sessionId, webSession);
    log.info('web: session created', { sessionId, workDir: this.workDir });
    return webSession;
  }

  async activateSession(sessionId: string): Promise<WebSession | null> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      // Unknown sessionId: reject to prevent zombie session creation.
      return null;
    }
    if (existing.isActive) return existing;
    // Reactivate an archived session by creating a new agent session.
    const session = await this.harness.createSession({
      workDir: existing.workDir,
      model: this.model,
      permission: this.permission,
    });
    // The new agent session has a different ID; we keep the original web sessionId
    // for persistence continuity but swap the underlying agent session.
    const meta = existing?.getMetadata() ?? {
      sessionId,
      workDir: this.workDir,
      title: 'Reactivated Session',
      createdAt: Date.now(),
      model: this.model,
      permission: this.permission,
    };
    // Close old web session's connections but keep journal.
    if (existing) {
      await existing.close();
    }
    const reactivated = new WebSession(session, {
      sessionId,
      workDir: meta.workDir,
      permission: meta.permission,
      yolo: this.yolo,
      homeDir: this.homeDir,
      createdAt: meta.createdAt,
      title: meta.title,
      onFork: (id) => this.forkSession(id),
    });
    // Reload persisted journal into the reactivated session.
    const entries = await loadJournal(this.homeDir, sessionId);
    reactivated.loadFromPersisted(entries);
    this.sessions.set(sessionId, reactivated);
    await saveMetadata(this.homeDir, reactivated.getMetadata());
    log.info('web: session reactivated', { sessionId });
    return reactivated;
  }

  get(sessionId: string): WebSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Fork an active session: harness.forkSession copies the agent state into a
   * new session, and we additionally copy the source's durable journal so the
   * forked web session displays the same prior conversation.
   */
  async forkSession(sourceId: string): Promise<{ sessionId: string; title: string } | null> {
    const source = this.sessions.get(sourceId);
    if (!source || !source.isActive || source.isBusy) return null;
    try {
      const session = await this.harness.forkSession({ id: sourceId });
      const newId = session.id;
      const createdAt = Date.now();
      const title = `${source.getTitle()} (fork)`;
      const webSession = new WebSession(session, {
        sessionId: newId,
        workDir: this.workDir,
        permission: source.getMetadata().permission,
        yolo: this.yolo,
        homeDir: this.homeDir,
        createdAt,
        title,
        onFork: (id) => this.forkSession(id),
      });
      // Copy durable journal + user messages from the source's in-memory state
      // (not from disk, to avoid race with fire-and-forget persistence).
      const entries = source.getDurableJournalEntries();
      if (entries.length > 0) {
        const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await writeFile(getJournalPath(this.homeDir, newId), lines);
      }
      webSession.loadFromPersisted(entries);
      await saveMetadata(this.homeDir, webSession.getMetadata());
      this.sessions.set(newId, webSession);
      log.info('web: session forked', { sourceId, newId });
      return { sessionId: newId, title };
    } catch (error) {
      log.warn('web: fork failed', { sourceId, error: String(error) });
      return null;
    }
  }

  list(): SessionListItem[] {
    return Array.from(this.sessions.values())
      .map((s) => s.getListItem())
      .toSorted((a, b) => b.createdAt - a.createdAt);
  }

  async delete(sessionId: string): Promise<boolean> {
    const ws = this.sessions.get(sessionId);
    if (!ws) return false;
    await ws.delete();
    this.sessions.delete(sessionId);
    return true;
  }

  /** List available model aliases from the harness config (reloaded). */
  async listModels(): Promise<ModelListResponse> {
    const config = await this.harness.getConfig({ reload: true });
    const models: ModelListItem[] = Object.entries(config.models ?? {}).map(([alias, m]) => ({
      alias,
      provider: m.provider,
      model: m.model,
      displayName: m.displayName,
      maxContextSize: m.maxContextSize,
      thinkingLevels: m.thinkingLevels,
    }));
    return {
      models,
      defaultModel: config.defaultModel,
      defaultThinking: config.defaultThinking ?? false,
      thinkingEffort: config.thinking?.effort,
    };
  }

  /**
   * Switch a session's model (mirrors the TUI `/model` flow): validates the
   * alias, guards against context overflow (Storm Breaker), applies it to the
   * live session, and persists it as the default model.
   */
  async switchModel(sessionId: string, alias: string): Promise<WebSession> {
    const ws = this.sessions.get(sessionId);
    if (!ws) throw new HttpError(404, 'Session not found');
    if (!ws.isActive) throw new HttpError(409, '会话已归档（只读），无法切换模型。');
    if (ws.isBusy) throw new HttpError(409, '会话忙碌中，无法切换模型 — 请先停止当前回合。');

    const config = await this.harness.getConfig({ reload: true });
    const target = config.models?.[alias];
    if (!target) throw new HttpError(400, `未知模型别名：${alias}`);

    // Storm Breaker guard (TUI parity): refuse to switch to a model whose
    // context window is smaller than the session's current token count.
    const status = ws.getStatus();
    const currentTokens = status?.contextTokens ?? 0;
    if (status?.model !== alias && target.maxContextSize < currentTokens) {
      throw new HttpError(
        409,
        `无法切换到模型「${alias}」：当前会话上下文 ${currentTokens} tokens 已超出该模型上限 ${target.maxContextSize}。` +
          '建议先执行 /compact 压缩上下文，或选择上下文窗口更大的模型。',
      );
    }

    await ws.switchModel(alias);

    // Persist as the default model (TUI persistModelSelection parity).
    if (config.defaultModel !== alias) {
      try {
        await this.harness.setConfig({ defaultModel: alias });
      } catch (error) {
        log.warn('web: failed to persist default model', { error: String(error) });
      }
    }
    return ws;
  }

  /**
   * Switch a session's thinking level (TUI changeThinkingLevel parity). The
   * thinking default is persisted only when the session's model is already
   * the default model.
   */
  async switchThinking(sessionId: string, level: string): Promise<WebSession> {
    const ws = this.sessions.get(sessionId);
    if (!ws) throw new HttpError(404, 'Session not found');
    if (!ws.isActive) throw new HttpError(409, '会话已归档（只读），无法切换思考强度。');
    if (!VALID_THINKING_LEVELS.has(level)) throw new HttpError(400, `未知思考强度：${level}`);
    if (ws.isBusy) throw new HttpError(409, '会话忙碌中，无法切换思考强度 — 请先停止当前回合。');

    await ws.switchThinking(level);

    try {
      const config = await this.harness.getConfig({ reload: true });
      if (config.defaultModel === ws.getStatus()?.model) {
        const effectiveThinking = level !== 'off';
        await this.harness.setConfig({
          defaultThinking: effectiveThinking,
          thinking: {
            ...config.thinking,
            mode: effectiveThinking ? 'on' : 'off',
            ...(effectiveThinking ? { effort: level } : {}),
          },
        });
      }
    } catch (error) {
      log.warn('web: failed to persist thinking default', { error: String(error) });
    }
    return ws;
  }

  async closeAll(): Promise<void> {
    for (const [, ws] of this.sessions) {
      await ws.close();
    }
    this.sessions.clear();
  }
}

// ─── Web server for an existing session ────────────────────────────────────

export interface WebServerHandle {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export async function startWebServerForSession(session: Session, opts: {
  readonly port: number;
  readonly workDir: string;
  readonly yolo: boolean;
  readonly open: boolean;
}): Promise<WebServerHandle> {
  const permission = opts.yolo ? 'yolo' : 'manual';
  const webSession = new WebSession(session, {
    sessionId: session.id,
    workDir: opts.workDir,
    permission,
    yolo: opts.yolo,
    createdAt: Date.now(),
  });

  const baseDir = import.meta.dirname;
  const prodPublicDir = join(baseDir, 'public');
  const devPublicDir = join(baseDir, 'frontend', 'dist');
  let publicDir = prodPublicDir;
  try {
    await access(join(devPublicDir, 'index.html'));
    publicDir = devPublicDir;
  } catch {
    // Fall back to prodPublicDir.
  }

  const httpServer: HttpServer = createServer(async (req: IncomingMessage, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    const snapshotMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/snapshot$`).exec(url);
    if (snapshotMatch && method === 'GET') {
      const sid = snapshotMatch[1]!;
      if (sid !== webSession.sessionId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(webSession.getSnapshot()));
      return;
    }

    // Git status for the status bar
    if (url === `${API_PREFIX}/git/status` && method === 'GET') {
      const gs = await getGitStatus(opts.workDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gs));
      return;
    }

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

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket) => {
    webSession.addConnection(ws);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, '127.0.0.1', resolve);
  });

  const url = `http://localhost:${opts.port}`;

  if (opts.open) {
    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} ${url}`);
  }

  const close = async (): Promise<void> => {
    wss.close();
    await webSession.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  return { url, close };
}

// ─── Standalone CLI entry: scream web ─────────────────────────────────────

export interface WebServerOptions {
  readonly port: number;
  readonly workDir: string;
  readonly model?: string;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly open: boolean;
  readonly skillsDirs: string[];
}

export async function runWebServer(opts: WebServerOptions): Promise<void> {
  const homeDir = resolveScreamHome();
  const workDir = opts.workDir;

  const harness = new ScreamHarness({
    homeDir,
    identity: createScreamCodeHostIdentity('dev'),
    uiMode: 'print',
    skillDirs: opts.skillsDirs,
  });

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
  const model = opts.model ?? config.defaultModel ?? 'default';

  const manager = new SessionManager({ harness, homeDir, workDir, model, permission, yolo: opts.yolo });
  await manager.init();

  // Create an initial active session if none exist.
  if (!manager.list().some((s) => s.active)) {
    await manager.createSession();
  }

  // ── HTTP server ────────────────────────────────────────────────────────
  const baseDir = import.meta.dirname;
  const prodPublicDir = join(baseDir, 'public');
  const devPublicDir = join(baseDir, 'frontend', 'dist');
  let publicDir = prodPublicDir;
  try {
    await access(join(devPublicDir, 'index.html'));
    publicDir = devPublicDir;
  } catch {
    // Fall back to prodPublicDir.
  }

  const httpServer: HttpServer = createServer(async (req: IncomingMessage, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // ── REST API ──────────────────────────────────────────────────────────

    // List sessions
    if (url === `${API_PREFIX}/sessions` && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manager.list()));
      return;
    }

    // Create session
    if (url === `${API_PREFIX}/sessions` && method === 'POST') {
      try {
        const ws = await manager.createSession();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ws.getListItem()));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 500, message: String(error) }));
      }
      return;
    }

    // Snapshot
    const snapshotMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/snapshot$`).exec(url);
    if (snapshotMatch && method === 'GET') {
      const sessionId = snapshotMatch[1]!;
      const ws = manager.get(sessionId);
      if (!ws) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ws.getSnapshot()));
      return;
    }

    // Git status for the status bar
    if (url === `${API_PREFIX}/git/status` && method === 'GET') {
      const gs = await getGitStatus(workDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gs));
      return;
    }

    // List available models (from harness config, reloaded)
    if (url === `${API_PREFIX}/models` && method === 'GET') {
      try {
        const models = await manager.listModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 500, message: String(error) }));
      }
      return;
    }

    // Switch model
    const modelMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/model$`).exec(url);
    if (modelMatch && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const alias = typeof body['model'] === 'string' ? body['model'].trim() : '';
        if (!alias) throw new HttpError(400, '缺少 model 字段');
        const ws = await manager.switchModel(modelMatch[1]!, alias);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: ws.getSnapshot().status }));
      } catch (error) {
        const code = error instanceof HttpError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code, message }));
      }
      return;
    }

    // Switch thinking level
    const thinkingMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/thinking$`).exec(url);
    if (thinkingMatch && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const level = typeof body['level'] === 'string' ? body['level'].trim() : '';
        if (!level) throw new HttpError(400, '缺少 level 字段');
        const ws = await manager.switchThinking(thinkingMatch[1]!, level);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: ws.getSnapshot().status }));
      } catch (error) {
        const code = error instanceof HttpError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code, message }));
      }
      return;
    }

    // Export to Markdown
    const exportMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/export$`).exec(url);
    if (exportMatch && method === 'GET') {
      const sessionId = exportMatch[1]!;
      const ws = manager.get(sessionId);
      if (!ws) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      const markdown = ws.getExportMarkdown();
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${sessionId}.md"`,
      });
      res.end(markdown);
      return;
    }

    // Activate (reactivate archived session)
    const activateMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/activate$`).exec(url);
    if (activateMatch && method === 'POST') {
      const sessionId = activateMatch[1]!;
      try {
        const ws = await manager.activateSession(sessionId);
        if (!ws) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ws.getListItem()));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 500, message: String(error) }));
      }
      return;
    }

    // Delete session
    const deleteMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)$`).exec(url);
    if (deleteMatch && method === 'DELETE') {
      const sessionId = deleteMatch[1]!;
      const deleted = await manager.delete(sessionId);
      if (!deleted) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Static assets ─────────────────────────────────────────────────────

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

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');

    if (sessionId) {
      const webSession = manager.get(sessionId);
      if (webSession) {
        if (webSession.isActive) {
          webSession.addConnection(ws);
          log.info('web: client connected', { sessionId, connections: webSession.connectionCount });
          return;
        }
        // Archived session: reactivate before connecting.
        void manager.activateSession(sessionId).then((reactivated) => {
          if (reactivated) {
            reactivated.addConnection(ws);
          } else {
            ws.close(1008, 'Session not found');
          }
        });
        return;
      }
      // Session not found in memory; try to activate from persisted.
      void manager.activateSession(sessionId).then((reactivated) => {
        if (reactivated) {
          reactivated.addConnection(ws);
        } else {
          ws.close(1008, 'Session not found');
        }
      });
      return;
    }

    // No sessionId specified; connect to the first active session.
    const firstActive = manager.list().find((s) => s.active);
    if (firstActive) {
      const webSession = manager.get(firstActive.sessionId);
      if (webSession) {
        webSession.addConnection(ws);
        return;
      }
    }
    ws.close(1008, 'No active session available');
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, '127.0.0.1', resolve);
  });

  const url = `http://localhost:${opts.port}`;

  if (opts.open) {
    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} ${url}`);
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      wss.close();
      await manager.closeAll();
      await harness.close();
    } catch {
      // Best-effort
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void cleanup().finally(() => process.exit(0));
  });

  // eslint-disable-next-line no-console
  console.log(
    `\n  Scream Web UI ready: ${url}\n` +
      `  Working directory: ${workDir}\n` +
      `  Sessions: ${manager.list().length} (${manager.list().filter((s) => s.active).length} active)\n` +
      `  Permission: ${opts.yolo ? 'yolo' : opts.auto ? 'auto' : 'manual'}\n`,
  );
}
