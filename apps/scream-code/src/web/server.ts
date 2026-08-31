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

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile, access, mkdir, readdir, unlink, stat, realpath, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';

import {
  ScreamHarness,
  resolveScreamHome,
  log,
  ErrorCodes,
  isScreamError,
  type Session,
  type Event,
  type SessionStatus,
  type PermissionMode,
  type GoalSnapshotData,
  type TodoItem,
} from '@scream-code/scream-code-sdk';
import { setLocale } from '@scream-code/config';

import { loadTuiConfig, saveTuiConfig, TuiConfigParseError, type TuiLikePreferences, TuiLikePreferencesSchema } from '#/tui/config';
import { buildRoleAdditionalText } from '#/tui/commands/like';
import { getDataDir } from '#/utils/paths';
import { createScreamCodeHostIdentity } from '#/cli/version';
import { refineGoal } from '#/utils/goal-refiner';
import { GatewayAuth, gatewayVerdict, isLoopbackAddress } from '#/web/auth';
import { createFixedWindowLimiter } from '#/web/rateLimit';
import { getLanAddresses } from '#/web/lan';
import { FileGate, FileAccessError } from '#/web/files';
import { toString as qrToString } from 'qrcode';

// ─── Types ────────────────────────────────────────────────────────────────

/** Server-owned journal event kinds (not part of the core event union). */
type WebJournalEvent = { type: 'web.message.finalized'; message: ChatMessage };

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
  readonly clientMessageId?: string;
}

interface ChatMessage {  role: 'user' | 'assistant';
  content: string;
  clientMessageId?: string;
  tools: ToolMessage[];
  isError?: boolean;
  /** Real wall-clock time of the turn start (ms epoch). Persisted via finalized snapshots. */
  ts?: number;
  /** Model that produced this assistant turn (shown in the message header). */
  model?: string;
  /** Journal seq of the event that created this message (used for older-history pagination). */
  seq?: number;
  /** True when this assistant turn predates durable message snapshots: body/thinking cannot be rebuilt after a server restart. */
  degraded?: boolean;
  /** Per-turn runtime stats (round/step/timing/tokens) for the web UI. */
  turnStats?: {
    turn: number;
    step: number;
    status: 'running' | 'done';
    firstTokenMs: number | null;
    llmMs: number | null;
    toolMs: number | null;
    tokens: number | null;
    tokensPerSec: number | null;
  };
}

interface ToolMessage {
  toolCallId: string;
  name: string;
  args: unknown;
  output?: string;
  isError?: boolean;
  /** Set when the thinking entry was truncated in a snapshot (full text on demand). */
  truncated?: boolean;
}

/** Thinking bodies longer than this are delivered as a tail excerpt + on-demand full text. */
const TRUNCATE_THINKING_LEN = 8 * 1024;

function truncateThinking(messages: ChatMessage[]): void {
  for (const m of messages) {
    for (const t of m.tools) {
      if (t.name === 'thinking' && typeof t.output === 'string' && t.output.length > TRUNCATE_THINKING_LEN) {
        t.output = `…（前 ${t.output.length - 2048} 字符已省略）\n${t.output.slice(-2048)}`;
        t.truncated = true;
      }
    }
  }
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
  readonly seq: number;
  readonly epoch: number;
  readonly model: string;
  readonly permission: PermissionMode;
  readonly messages: ChatMessage[];
  readonly olderAvailable?: boolean;
  readonly oldestSeq?: number;
  readonly pendingApprovals: ApprovalRequestMessage[];
  readonly status: SessionStatus;
  readonly busy: boolean;
  readonly createdAt: number;
  readonly title: string;
  readonly goal: GoalSnapshotData | null;
  readonly todos: readonly TodoItem[];
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
  readonly coreSessionId?: string;
  readonly workDir: string;
  readonly title: string;
  readonly createdAt: number;
  readonly model: string;
  readonly permission: PermissionMode;
}

type GoalBudgetUnit = 'turns' | 'tokens' | 'milliseconds' | 'seconds' | 'minutes' | 'hours';

interface GoalBudgetInput {
  readonly value: number;
  readonly unit: GoalBudgetUnit;
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
    readonly code?: string,
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
function cloneSnapshot<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const TUI_CONFIG_PATH = join(getDataDir(), 'tui.toml');

/** Load the user's /like preferences (shared with the TUI via tui.toml). */
async function loadLikePreferences(): Promise<TuiLikePreferences> {
  const config = await loadTuiConfig(TUI_CONFIG_PATH);
  return config.like ?? {};
}

/** Persist like preferences to tui.toml + user-prefs.md, rolling both back on failure. */
async function saveLikePreferences(prefs: TuiLikePreferences): Promise<void> {
  const current = await loadTuiConfig(TUI_CONFIG_PATH);
  const prefsPath = join(getDataDir(), 'user-prefs.md');
  try {
    await saveTuiConfig({ ...current, like: prefs }, TUI_CONFIG_PATH);
    await writeFile(prefsPath, buildRoleAdditionalText(prefs), 'utf-8');
  } catch (error) {
    // writeFile is non-atomic: roll BOTH stores back so they never diverge.
    try {
      await saveTuiConfig(current, TUI_CONFIG_PATH);
    } catch {
      // best-effort rollback
    }
    try {
      await writeFile(prefsPath, buildRoleAdditionalText(current.like ?? {}), 'utf-8');
    } catch {
      // best-effort rollback
    }
    throw error;
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        rejected = true;
        data = '';
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (rejected) return;
      if (!data) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(data);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, 'JSON body must be an object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `Missing or empty ${field} field`, 'request.invalid');
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${field} must be a non-empty string`, 'request.invalid');
  }
  return value.trim();
}

function optionalBoolean(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean`, 'request.invalid');
  return value;
}

function parseGoalBudgets(body: Record<string, unknown>): readonly GoalBudgetInput[] {
  const raw = body['budgets'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'budgets must be an array', 'request.invalid');

  const validUnits = new Set<GoalBudgetUnit>(['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours']);
  const seen = new Set<'turns' | 'tokens' | 'time'>();
  return raw.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, 'Each budget must be an object', 'request.invalid');
    }
    const value = (item as Record<string, unknown>)['value'];
    const unit = (item as Record<string, unknown>)['unit'];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new HttpError(400, 'Budget value must be a positive safe integer', 'request.invalid');
    }
    if (typeof unit !== 'string' || !validUnits.has(unit as GoalBudgetUnit)) {
      throw new HttpError(400, 'Budget unit must be turns, tokens, milliseconds, seconds, minutes, or hours', 'request.invalid');
    }
    const typedUnit = unit as GoalBudgetUnit;
    const dimension = typedUnit === 'turns' || typedUnit === 'tokens' ? typedUnit : 'time';
    if (seen.has(dimension)) {
      throw new HttpError(400, `Duplicate budget dimension: ${dimension}`, 'request.invalid');
    }
    seen.add(dimension);
    return { value, unit: typedUnit };
  });
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (isScreamError(error)) {
    switch (error.code) {
      case ErrorCodes.GOAL_OBJECTIVE_EMPTY:
      case ErrorCodes.GOAL_OBJECTIVE_TOO_LONG:
      case ErrorCodes.REQUEST_INVALID:
      case ErrorCodes.SESSION_PERMISSION_MODE_INVALID:
      case ErrorCodes.SESSION_PLAN_MODE_INVALID:
      case ErrorCodes.SESSION_WOLFPACK_MODE_INVALID:
      case ErrorCodes.SESSION_MODEL_EMPTY:
      case ErrorCodes.SESSION_THINKING_EMPTY:
      case ErrorCodes.SKILL_NAME_EMPTY:
      case ErrorCodes.BACKGROUND_TASK_ID_EMPTY:
        return new HttpError(400, error.message, error.code);
      case ErrorCodes.GOAL_NOT_FOUND:
      case ErrorCodes.SESSION_NOT_FOUND:
        return new HttpError(404, error.message, error.code);
      case ErrorCodes.GOAL_ALREADY_EXISTS:
      case ErrorCodes.GOAL_NOT_RESUMABLE:
      case ErrorCodes.GOAL_STATUS_INVALID:
      case ErrorCodes.TURN_AGENT_BUSY:
        return new HttpError(409, error.message, error.code);
      default:
        return new HttpError(500, error.message, error.code);
    }
  }
  // The file gate throws FileAccessError with its own status (403 for escapes,
  // 404 for missing). Without this it was reported as a 500.
  if (error instanceof FileAccessError) return new HttpError(error.statusCode, error.message);
  return new HttpError(500, errorMessage(error));
}

function sendHttpError(res: ServerResponse, error: unknown): void {  const mapped = toHttpError(error);
  sendJson(res, mapped.statusCode, {
    code: mapped.code ?? mapped.statusCode,
    message: mapped.message,
  });
}

// ─── File gate routes (read-only) ──────────────────────────────────────────

async function handleFilesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  apiPrefix: string,
  gate: FileGate,
): Promise<boolean> {
  if (method !== 'GET') return false;
  const [pathOnly, queryPart] = url.split('?');
  const query = new URLSearchParams(queryPart ?? '');
  const fail = (error: unknown): void => {
    const code = error instanceof FileAccessError ? error.statusCode : 500;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) }));
  };

  if (pathOnly === `${apiPrefix}/files/root`) {
    sendJson(res, 200, { roots: gate.getRoots() });
    return true;
  }
  if (pathOnly === `${apiPrefix}/files/list`) {
    try {
      sendJson(res, 200, { path: query.get('path') ?? '', entries: await gate.list(query.get('path') ?? '') });
    } catch (error) {
      fail(error);
    }
    return true;
  }
  if (pathOnly === `${apiPrefix}/files/read`) {
    try {
      sendJson(res, 200, await gate.read(query.get('path') ?? ''));
    } catch (error) {
      fail(error);
    }
    return true;
  }
  if (pathOnly === `${apiPrefix}/files/raw`) {
    try {
      const abs = await gate.resolve(query.get('path') ?? '');
      const data = await readFile(abs);
      res.writeHead(200, { 'Content-Type': gate.contentType(abs), 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (error) {
      fail(error);
    }
    return true;
  }
  return false;
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

let metaWriteSeq = 0;

async function saveMetadata(homeDir: string, meta: SessionMetadata): Promise<void> {
  try {
    // Write to a temp file and rename into place. Plain writeFile truncates
    // the target before the new bytes land, so a concurrent reader
    // (listPersistedSessions on server restart) could observe a half-written
    // JSON document and silently drop the session. rename() is atomic.
    const path = getMetaPath(homeDir, meta.sessionId);
    const tmp = `${path}.${process.pid}.${metaWriteSeq++}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, path);
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
  readonly files?: GitFileChange[];
}

interface GitFileChange {
  /**
   * Path relative to the **repository root** — the only base `git` itself
   * speaks, so it is what `/git/diff` must be called with. The old code handed
   * the UI work-dir-relative paths and then re-prefixed them inside
   * `getGitFileDiff`, which made every nested file resolve outside the repo and
   * return an empty patch.
   */
  path: string;
  /** Shorter path relative to the session work dir, for display only. */
  displayPath: string;
  status: string;
  /** Added lines for this file (line count for untracked files). */
  adds?: number;
  /** Removed lines for this file. */
  dels?: number;
  untracked?: boolean;
}

const execFileAsync = promisify(execFile);

/** Raw porcelain rows: repo-root-relative path + XY status. `getGitStatus`
 *  enriches these into full `GitFileChange` records. */
function parsePorcelainFiles(lines: string[]): Array<{ path: string; status: string }> {
  const files: Array<{ path: string; status: string }> = [];
  for (const line of lines) {
    if (line.startsWith('##')) continue;
    const status = line.slice(0, 2).replaceAll(' ', '');
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ').pop()!;
    if (p.startsWith('"') && p.endsWith('"')) {
      try {
        p = JSON.parse(p);
      } catch {
        // keep quoted form
      }
    }
    files.push({ path: p, status });
  }
  return files;
}

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
  let gitFiles: GitFileChange[] = [];
  try {
    const [branchOut, statusOut, repoTopOut] = await Promise.all([
      git(workDir, ['branch', '--show-current']),
      git(workDir, ['status', '--porcelain', '-b']),
      git(workDir, ['rev-parse', '--show-toplevel']).catch(() => workDir),
    ]);
    branch = branchOut.trim() || undefined;
    const repoTop = repoTopOut.trim() || workDir;
    // porcelain paths are relative to the repo top. `path` keeps that canonical
    // base (it is what `/git/diff` expects); `displayPath` strips the workdir
    // prefix purely so the UI can show a short path.
    const prefix = repoTop !== workDir ? `${relative(repoTop, workDir).replaceAll('\\', '/')}/` : '';
    const fixPath = (p: string): string => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    const statusLines = statusOut.split('\n').filter((l) => l.length > 0);
    const header = statusLines[0] ?? '';
    const aheadMatch = /ahead (\d+)/.exec(header);
    const behindMatch = /behind (\d+)/.exec(header);
    if (aheadMatch) ahead = Number(aheadMatch[1]);
    if (behindMatch) behind = Number(behindMatch[1]);
    changed = statusLines.filter((l) => !l.startsWith('##')).length;
    const statusFiles = parsePorcelainFiles(statusLines).map((f) => ({
      path: f.path,
      displayPath: fixPath(f.path),
      status: f.status,
    }));
    if (statusFiles.length > 0) {
      gitFiles = statusFiles;
    }
  } catch {
    // Branch/status failure — fall through with what we have.
  }

  let adds: number | undefined;
  let dels: number | undefined;
  let diffStat: string | undefined;
  /** Repo-root-relative → per-file line counts, from `git diff --numstat`. */
  const perFile = new Map<string, { adds: number; dels: number }>();
  try {
    const [numstatOut, diffStatOut] = await Promise.all([
      git(workDir, ['diff', '--numstat', 'HEAD']),
      git(workDir, ['diff', '--stat', 'HEAD']),
    ]);
    adds = 0;
    dels = 0;
    for (const line of numstatOut.split('\n')) {
      const parts = line.split('\t');
      const m = parts.length >= 3 ? /^(\d+)\t(\d+)\t/.exec(line) : null;
      if (!m) continue;
      adds += Number(m[1]);
      dels += Number(m[2]);
      perFile.set(normalizeNumstatPath(parts.slice(2).join('\t')), { adds: Number(m[1]), dels: Number(m[2]) });
    }
    diffStat = diffStatOut.trim().split('\n').slice(0, 200).join('\n') || undefined;
  } catch {
    // No HEAD yet (fresh repo) — diff stats unavailable.
  }

  // Untracked files have no numstat row at all; mark them so the UI can label
  // the row instead of showing a misleading `0`.
  const untracked = new Set<string>();
  try {
    const others = await git(workDir, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const p of others.split('\0')) if (p.trim() !== '') untracked.add(p.replaceAll('\\', '/'));
  } catch {
    // treat as none
  }
  gitFiles = gitFiles.map((file) => {
    const stats = perFile.get(file.path);
    const isUntracked = untracked.has(file.path) || file.status.includes('?');
    return {
      ...file,
      status: isUntracked ? '?' : file.status,
      ...(isUntracked ? { untracked: true } : {}),
      ...(stats ? { adds: stats.adds, dels: stats.dels } : {}),
    };
  });

  return { isRepo: true, branch, ahead, behind, changed, adds, dels, diffStat, files: gitFiles.length > 0 ? gitFiles : undefined };
}

/**
 * numstat keys for renames come back as `a/{old => new}/b.ts` or
 * `old => new`; resolve them to the post-rename path so they match porcelain.
 */
function normalizeNumstatPath(raw: string): string {
  let p = raw.trim().replaceAll('\\', '/');
  const brace = /\{([^{}]*) => ([^{}]*)\}/.exec(p);
  if (brace) p = p.replace(brace[0], `${brace[1]}${brace[2]}`);
  if (p.includes(' => ')) p = p.split(' => ').pop()!.trim();
  return p.replaceAll('//', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Cap for the inlined content of an untracked file. */
const MAX_INLINE_DIFF_BYTES = 512 * 1024;

/**
 * Single-file patch. `repoPath` is **repository-root relative** — the same base
 * `git status` reports, so the UI can hand it straight back.
 *
 * Two cases used to return an empty patch and look like "点了没反应":
 * nested files (the old code re-prefixed workdir-relative paths with `../..`,
 * resolving them outside the repo) and untracked files (`git diff` has nothing
 * to say about them). The second case now gets a synthesised added-file patch.
 */
async function getGitFileDiff(workDir: string, repoPath: string): Promise<{ path: string; patch: string } | null> {
  const rel = normalizeNumstatPath(repoPath);
  if (rel === '') throw new FileAccessError(403, '路径不能为空');
  let repoTop = '';
  try {
    repoTop = (await git(workDir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
  if (!repoTop) throw new FileAccessError(403, '不在 git 仓库内');
  const abs = resolve(repoTop, rel);
  const inside = relative(repoTop, abs);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new FileAccessError(403, '路径不属于该仓库');
  }
  // Run from the repo top so the pathspec and the reported paths share one base.
  const patch = await git(repoTop, ['diff', '--no-color', '--', rel]).catch(() => '');
  if (patch.trim()) return { path: rel, patch };

  const isUntracked = (await git(repoTop, ['ls-files', '--others', '--exclude-standard', '--', rel]).catch(() => '')).trim() !== '';
  if (!isUntracked) return { path: rel, patch: '' };
  const header = `--- /dev/null\n+++ b/${rel}\n`;
  try {
    // Reading from disk needs the same realpath containment `files.ts` applies:
    // a symlink committed inside the repo must not let this endpoint read a file
    // that lives outside the working tree.
    const [realRoot, realAbs] = await Promise.all([realpath(repoTop), realpath(abs)]);
    const relCheck = relative(realRoot, realAbs);
    if (relCheck === '' || relCheck.startsWith('..') || isAbsolute(relCheck)) {
      throw new FileAccessError(403, '路径不属于该仓库');
    }
    const info = await stat(realAbs);
    if (!info.isFile()) return { path: rel, patch: `${header}@@ -0,0 +1 @@\n+（非普通文件）\n` };
    if (info.size > MAX_INLINE_DIFF_BYTES) {
      return { path: rel, patch: `${header}@@ -0,0 +1 @@\n+（文件超过 ${Math.round(MAX_INLINE_DIFF_BYTES / 1024)}KB，未内联显示）\n` };
    }
    const content = await readFile(realAbs, 'utf8');
    if (content.includes('\u0000')) return { path: rel, patch: `${header}@@ -0,0 +1 @@\n+（二进制文件）\n` };
    const lines = content.replaceAll('\r\n', '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return { path: rel, patch: `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n` };
  } catch {
    return { path: rel, patch: `${header}@@ -0,0 +1 @@\n+（读取失败）\n` };
  }
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
  private cachedGoal: GoalSnapshotData | null = null;
  private cachedTodos: readonly TodoItem[] = [];
  private goalEventRevision = 0;
  private todoEventRevision = 0;
  private goalMutationTail: Promise<void> = Promise.resolve();
  private pendingGoalMutations = 0;
  private readonly coreSessionId: string;
  readonly ready: Promise<void>;
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

  /**
   * Live assistant message under construction. Mirrors the same state machine
   * used by buildMessages() so turn.ended can persist a complete durable
   * snapshot (`web.message.finalized`) — the only source that survives a
   * server restart (deltas are volatile by design).
   */
  private liveAssistant: ChatMessage | null = null;
  private liveTurnCount = 0;
  /** pendingMsgId awaiting compaction completion/cancellation event. */
  private pendingCompactionMsgId: string | null = null;
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
      coreSessionId?: string;
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
    this.coreSessionId = session?.id ?? opts.coreSessionId ?? opts.sessionId;
    this.onFork = opts.onFork;
    if (opts.title) this.title = opts.title;

    if (session) {
      // Subscribe before the initial reads. Revision checks below prevent an
      // in-flight RPC result from overwriting a newer event snapshot.
      this.subscribeEvents();
      this.setupApprovalHandler();
      this.ready = this.initializeCoreState();
    } else {
      this.ready = Promise.resolve();
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
      entries.push({
        type: 'user_message',
        text: um.msg.content,
        beforeSeq: um.beforeSeq,
        clientMessageId: um.msg.clientMessageId,
      });
    }
    return entries;
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private async persistEntry(entry: JournalEntry): Promise<void> {
    if (!this.homeDir) return;
    const line = JSON.stringify({ type: 'journal', ...entry });
    await appendJournalLine(this.homeDir, this.sessionId, line);
  }

  private async persistUserMessage(text: string, beforeSeq: number, clientMessageId?: string): Promise<void> {
    this.userMessages.push({ msg: { role: 'user', content: text, clientMessageId, tools: [] }, beforeSeq });
    if (!this.homeDir) return;
    const line = JSON.stringify({ type: 'user_message', text, beforeSeq, clientMessageId } satisfies PersistedUserMessage);
    await appendJournalLine(this.homeDir, this.sessionId, line);
  }

  /** In-flight fire-and-forget persistence writes, drained by close(). */
  private readonly pendingWrites = new Set<Promise<void>>();

  /** Register a background persistence promise so close() can await it. */
  private trackPending(promise: Promise<void>): void {
    const tracked: Promise<void> = promise
      .catch(() => {})
      .then(() => {
        this.pendingWrites.delete(tracked);
      });
    this.pendingWrites.add(tracked);
  }

  loadFromPersisted(entries: PersistedEntry[]): void {
    for (const entry of entries) {
      if ('type' in entry && entry.type === 'user_message') {
        const um = entry as PersistedUserMessage;
        this.userMessages.push({
          msg: { role: 'user', content: um.text, clientMessageId: um.clientMessageId, tools: [] },
          beforeSeq: um.beforeSeq,
        });
      } else {
        const je = entry as JournalEntry;
        this.journal.push(je);
        this.nextSeq = Math.max(this.nextSeq, je.seq + 1);
        if (this.session === null && je.payload.agentId === 'main' && je.payload.type === 'goal.updated') {
          this.cachedGoal = cloneSnapshot(je.payload.snapshot);
        } else if (this.session === null && je.payload.agentId === 'main' && je.payload.type === 'todo.updated') {
          this.cachedTodos = cloneSnapshot(je.payload.todos);
        }
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
      coreSessionId: this.coreSessionId,
      workDir: this.workDir,
      title: this.title,
      createdAt: this.createdAt,
      model: this.cachedStatus?.model ?? 'unknown',
      permission: this.permission,
    };
  }

  // ── Event journal ──────────────────────────────────────────────────────

  private appendEvent(event: Event): JournalEntry {
    const payload = event.type === 'goal.updated' || event.type === 'todo.updated'
      ? cloneSnapshot(event)
      : event;
    const entry: JournalEntry = {
      seq: this.nextSeq++,
      epoch: this.epoch,
      volatile: isVolatileEvent(payload),
      payload,
    };
    this.journal.push(entry);
    // Persist durable events only.
    if (!entry.volatile) {
      this.trackPending(this.persistEntry(entry));
    }
    return entry;
  }

  /**
   * Append + persist a durable journal entry WITHOUT broadcasting it to
   * clients. Used for server-owned reconstruction material (finalized
   * assistant snapshots) that clients never consume as live events.
   */
  private appendDurableSilent(payload: Record<string, unknown>): JournalEntry {
    const entry: JournalEntry = {
      seq: this.nextSeq++,
      epoch: this.epoch,
      volatile: false,
      payload: payload as unknown as Event,
    };
    this.journal.push(entry);
    this.trackPending(this.persistEntry(entry));
    return entry;
  }

  private subscribeEvents(): void {
    if (!this.session) return;
    this.unsubscribe = this.session.onEvent((event) => {
      // Goal/Todo state belongs to the interactive main agent. Other event
      // families retain their existing subagent visibility.
      if ((event.type === 'goal.updated' || event.type === 'todo.updated') && event.agentId !== 'main') return;

      if (event.type === 'turn.started') {
        this.busy = true;
        this.liveTurnCount += 1;
        this.liveAssistant = {
          role: 'assistant',
          content: '',
          tools: [],
          ts: Date.now(),
          model: this.cachedStatus?.model,
          turnStats: {
            turn: this.liveTurnCount,
            step: 0,
            status: 'running',
            firstTokenMs: null,
            llmMs: null,
            toolMs: null,
            tokens: null,
            tokensPerSec: null,
          },
        };
      } else if (event.type === 'turn.ended') {
        this.busy = false;
        // Persist the complete assistant snapshot BEFORE turn.ended so the
        // journal replay sees finalized → turn.ended in order.
        const live = this.liveAssistant;
        if (event.reason === 'failed' && live) live.isError = true;
        if (live) {
          const base = live.turnStats ?? {
            turn: this.liveTurnCount,
            step: 0,
            firstTokenMs: null,
            llmMs: null,
            toolMs: null,
            tokens: null,
            tokensPerSec: null,
          };
          live.turnStats = { ...base, status: 'done' } as NonNullable<ChatMessage['turnStats']>;
          this.appendDurableSilent({ type: 'web.message.finalized', message: live });
        }
        this.liveAssistant = null;
        // Update title after each exchange.
        this.trackPending(this.updateTitle());
      } else if (event.type === 'assistant.delta') {
        const live = this.liveAssistant;
        if (live) live.content += event.delta;
      } else if (event.type === 'thinking.delta') {
        const live = this.liveAssistant;
        if (live) {
          const t = live.tools.find((x) => x.name === 'thinking');
          if (t) t.output = (t.output ?? '') + event.delta;
          else live.tools.push({ toolCallId: 'thinking', name: 'thinking', args: {}, output: event.delta });
        }
      } else if (event.type === 'tool.call.started') {
        const live = this.liveAssistant;
        if (live) {
          live.tools.push({ toolCallId: event.toolCallId, name: event.name, args: event.args });
          if (live.turnStats) live.turnStats.step += 1;
        }
      } else if (event.type === 'tool.result') {
        const live = this.liveAssistant;
        if (live) {
          const tool = live.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) {
            tool.output = String(event.output);
            tool.isError = event.isError;
          }
        }
      } else if (event.type === 'goal.updated') {
        this.goalEventRevision += 1;
        this.cachedGoal = cloneSnapshot(event.snapshot);
      } else if (event.type === 'todo.updated') {
        this.todoEventRevision += 1;
        this.cachedTodos = cloneSnapshot(event.todos);
      }
      if (event.type === 'session.meta.updated' || event.type === 'turn.ended') {
        void this.refreshStatus();
      }
      // Goal/Todo are ordinary durable core events. They receive exactly one
      // journal sequence and are replayed/broadcast by this shared path.
      const entry = this.appendEvent(event);
      this.broadcast({ type: 'event', seq: entry.seq, epoch: entry.epoch, payload: entry.payload }, entry.volatile);
      // Compaction runs async after begin(); report success/failure only when
      // the worker actually finishes, so the UI shows "compressing -> done".
      if (event.type === 'compaction.completed') {
        const msgId = this.pendingCompactionMsgId;
        this.pendingCompactionMsgId = null;
        void this.refreshStatus().then(() => this.broadcastStatus());
        if (msgId) {
          this.broadcast({ type: 'command_result', command: 'compact', ok: true, message: '会话上下文已压缩。', pendingMsgId: msgId }, false);
        }
      } else if (event.type === 'compaction.cancelled') {
        const msgId = this.pendingCompactionMsgId;
        this.pendingCompactionMsgId = null;
        if (msgId) {
          this.broadcast({ type: 'command_result', command: 'compact', ok: false, message: `压缩已取消${event.reason ? `：${event.reason}` : '。'}`, pendingMsgId: msgId }, false);
        }
      }
    });
  }

  private async initializeCoreState(): Promise<void> {
    const session = this.session;
    if (!session) return;

    const goalRevision = this.goalEventRevision;
    const todoRevision = this.todoEventRevision;
    const [status, goal, todos] = await Promise.all([
      session.getStatus().catch(() => null),
      session.getGoal(),
      session.getTodos(),
    ]);

    if (status !== null) this.cachedStatus = status;
    if (this.goalEventRevision === goalRevision) {
      this.cachedGoal = cloneSnapshot(goal.goal);
    }
    if (this.todoEventRevision === todoRevision) {
      this.cachedTodos = cloneSnapshot(todos);
    }
  }

  private async refreshStatus(): Promise<void> {
    if (!this.session) return;
    try {
      this.cachedStatus = await this.session.getStatus();
    } catch {
      // Ignore
    }
  }

  /** Push cached status to all connected clients (model/permission/plan/etc). */
  private broadcastStatus(): void {
    if (this.cachedStatus) {
      this.broadcast({ type: 'status', status: this.cachedStatus }, false);
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
          this.send(ws, { type: 'error', code: 'session.inactive', message: 'Session is archived (read-only)', clientMessageId });
          return;
        }
        if (!text || this.busy || this.pendingGoalMutations > 0) {
          this.send(ws, { type: 'error', code: 'session.busy', message: 'Session is busy', clientMessageId });
          return;
        }
        // Reserve the turn synchronously before broadcasting acceptance so a
        // second tab cannot race another prompt into the same agent session.
        this.busy = true;
        this.trackPending(this.persistUserMessage(text, this.nextSeq, clientMessageId));
        this.broadcast({ type: 'user_message', clientMessageId, text }, false);
        void this.session.prompt(text).catch((error: unknown) => {
          this.busy = false;
          this.sendError(ws, error, clientMessageId);
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
    const missing = this.journal.filter((entry) => entry.seq > lastSeq);
    for (const entry of missing) {
      if (!entry.volatile) {
        this.send(ws, { type: 'event', seq: entry.seq, epoch: entry.epoch, payload: entry.payload });
      }
    }
  }

  private sendError(ws: WebSocket, error: unknown, clientMessageId?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.send(ws, { type: 'error', message, clientMessageId });
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
        if (this.pendingCompactionMsgId !== null) {
          fail('正在压缩中，请稍候。');
          return;
        }
        this.pendingCompactionMsgId = pendingMsgId ?? null;
        try {
          // begin() starts an async compaction worker and returns immediately.
          // Success/failure is reported when the compaction.completed /
          // compaction.cancelled event arrives (handled in subscribeEvents).
          await this.session.compact();
        } catch (error) {
          this.pendingCompactionMsgId = null;
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
          this.broadcastStatus();
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
          this.broadcastStatus();
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
          const result = await this.onFork(this.sessionId);
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

  getSnapshot(options?: { tail?: number }): SessionSnapshot {
    const all = this.buildMessages();
    let messages = all;
    let olderAvailable: boolean | undefined;
    let oldestSeq: number | undefined;
    if (options?.tail && all.length > options.tail) {
      messages = all.slice(-options.tail);
      olderAvailable = true;
      oldestSeq = messages[0]?.seq;
    }
    truncateThinking(messages);
    return cloneSnapshot({
      sessionId: this.sessionId,
      workDir: this.workDir,
      seq: this.nextSeq - 1,
      epoch: this.epoch,
      model: this.cachedStatus?.model ?? 'unknown',
      permission: this.cachedStatus?.permission ?? this.permission,
      messages,
      olderAvailable,
      oldestSeq,
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
        rlmEnabled: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      },
      busy: this.busy,
      createdAt: this.createdAt,
      title: this.title,
      goal: this.cachedGoal,
      todos: this.cachedTodos,
    });
  }

  /** Older history page: messages strictly older than `beforeSeq`, newest-first window of `tail`. */
  getMessagesOlder(beforeSeq: number, tail: number): { messages: ChatMessage[]; hasMore: boolean } {
    const all = this.buildMessages();
    const older = all.filter((m) => (m.seq ?? Number.MAX_SAFE_INTEGER) < beforeSeq);
    return { messages: older.slice(-tail), hasMore: older.length > tail };
  }

  /** Full thinking text for a truncated entry (loaded on demand). */
  getThinkingEntry(seq: number, toolCallId: string): string {
    const all = this.buildMessages();
    const msg = all.find((m) => m.seq === seq);
    const tool = msg?.tools.find((t) => t.toolCallId === toolCallId);
    if (tool && typeof tool.output === 'string') return tool.output;
    const thinking = msg?.tools.find((t) => t.name === 'thinking');
    return thinking && typeof thinking.output === 'string' ? thinking.output : '';
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

  /** Switch permission mode, then sync status + metadata (TUI /auto,/yes parity). */
  async switchPermission(mode: PermissionMode): Promise<void> {
    if (!this.session) throw new HttpError(409, '会话已归档（只读），无法切换权限模式。');
    await this.session.setPermission(mode);
    this.permission = mode;
    await this.refreshStatus();
    this.broadcast({ type: 'status', status: this.cachedStatus }, false);
    if (this.homeDir) {
      await saveMetadata(this.homeDir, this.getMetadata());
    }
  }

  /** Toggle plan mode, then sync status (TUI /plan parity). */
  async switchPlanMode(enabled: boolean, strategy?: 'normal' | 'fusion'): Promise<void> {
    if (!this.session) throw new HttpError(409, '会话已归档（只读），无法切换计划模式。');
    await this.session.setPlanMode(enabled, strategy);
    await this.refreshStatus();
    this.broadcast({ type: 'status', status: this.cachedStatus }, false);
  }

  /** Toggle wolfpack mode, then sync status. */
  async switchWolfpackMode(enabled: boolean): Promise<void> {
    if (!this.session) throw new HttpError(409, '会话已归档（只读），无法切换 Wolfpack 模式。');
    await this.session.setWolfpackMode(enabled);
    await this.refreshStatus();
    this.broadcast({ type: 'status', status: this.cachedStatus }, false);
  }

  /** Toggle RLM persistent-python mode (+ optional max depth), then sync status. */
  async switchRlm(enabled: boolean, maxDepth?: number): Promise<void> {
    if (!this.session) throw new HttpError(409, '会话已归档（只读），无法切换 RLM 模式。');
    await this.session.setRlmEnabled(enabled);
    if (maxDepth !== undefined) await this.session.setRlmMaxDepth(maxDepth);
    await this.refreshStatus();
    this.broadcast({ type: 'status', status: this.cachedStatus }, false);
  }

  getCoreSessionId(): string {
    return this.coreSessionId;
  }

  async refineGoalDescription(description: string): Promise<string> {
    await this.ready;
    const session = this.requireGoalSession();
    return refineGoal(session, description);
  }

  async createGoal(
    objective: string,
    completionCriterion: string | undefined,
    replace: boolean,
    budgets: readonly GoalBudgetInput[],
  ): Promise<GoalSnapshotData> {
    return this.serializeGoalMutation(async (session) => {
      let goal = await session.createGoal(objective, { completionCriterion, replace });
      try {
        for (const budget of budgets) {
          goal = await session.setGoalBudget(budget.value, budget.unit);
        }
      } catch (error) {
        const recovery = await this.pauseOrClearUnsafeActiveGoal(session);
        throw new HttpError(500, `Goal configuration failed and the new goal was ${recovery}: ${errorMessage(error)}`);
      }

      try {
        await this.startGoalExecution(session, objective);
      } catch (error) {
        const recovery = await this.pauseOrClearUnsafeActiveGoal(session);
        throw new HttpError(500, `Goal was created but execution could not start; it was ${recovery}: ${errorMessage(error)}`);
      }
      return cloneSnapshot(goal);
    });
  }

  async updateGoal(objective: string | undefined, budgets: readonly GoalBudgetInput[]): Promise<GoalSnapshotData> {
    return this.serializeGoalMutation(async (session) => {
      const current = await session.getGoal();
      if (current.goal === null) {
        throw new HttpError(404, 'Goal not found', ErrorCodes.GOAL_NOT_FOUND);
      }

      let goal = current.goal;
      if (objective !== undefined) goal = await session.updateGoalObjective(objective);
      for (const budget of budgets) {
        goal = await session.setGoalBudget(budget.value, budget.unit);
      }
      return cloneSnapshot(goal);
    });
  }

  async pauseGoal(): Promise<GoalSnapshotData> {
    return this.serializeGoalMutation(async (session) => {
      const goal = await session.updateGoalStatus('paused');
      if (goal === null) throw new HttpError(404, 'Goal not found', ErrorCodes.GOAL_NOT_FOUND);
      return cloneSnapshot(goal);
    }, true);
  }

  async resumeGoal(): Promise<GoalSnapshotData> {
    return this.serializeGoalMutation(async (session) => {
      const current = await session.getGoal();
      if (current.goal === null) {
        throw new HttpError(404, 'Goal not found', ErrorCodes.GOAL_NOT_FOUND);
      }
      const goal = await session.updateGoalStatus('active');
      if (goal === null) throw new HttpError(404, 'Goal not found', ErrorCodes.GOAL_NOT_FOUND);

      try {
        await this.startGoalExecution(
          session,
          'Continue working toward the active goal. Review current progress and remaining work before proceeding.',
        );
      } catch (error) {
        const recovery = await this.pauseOrClearUnsafeActiveGoal(session);
        throw new HttpError(500, `Goal was resumed but execution could not continue; it was ${recovery}: ${errorMessage(error)}`);
      }
      return cloneSnapshot(goal);
    });
  }

  async cancelGoal(): Promise<void> {
    await this.serializeGoalMutation(async (session) => {
      const current = await session.getGoal();
      if (current.goal === null) {
        throw new HttpError(404, 'Goal not found', ErrorCodes.GOAL_NOT_FOUND);
      }
      await session.cancelGoal();
    }, true);
  }

  /**
   * Public handle to the live core Session for REST RPC forwarding.
   * Throws 409 for archived (read-only) sessions so handlers never call into a
   * closed core session instead of silently creating one.
   */
  requireLiveSession(): Session {
    if (!this.session) {
      throw new HttpError(409, 'Session is archived (read-only)', ErrorCodes.SESSION_CLOSED);
    }
    return this.session;
  }

  private requireGoalSession(allowBusy = false): Session {
    if (!this.session) {
      throw new HttpError(409, 'Session is archived (read-only)', ErrorCodes.SESSION_CLOSED);
    }
    if (!allowBusy && this.busy) {
      throw new HttpError(409, 'Session is busy', ErrorCodes.TURN_AGENT_BUSY);
    }
    return this.session;
  }

  private serializeGoalMutation<T>(
    mutation: (session: Session) => Promise<T>,
    allowBusy = false,
  ): Promise<T> {
    this.pendingGoalMutations += 1;
    const run = this.goalMutationTail.then(async () => {
      await this.ready;
      return mutation(this.requireGoalSession(allowBusy));
    });
    this.goalMutationTail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.pendingGoalMutations -= 1;
    });
  }

  private async startGoalExecution(session: Session, prompt: string): Promise<void> {
    this.busy = true;
    await this.persistUserMessage(prompt, this.nextSeq);
    this.broadcast({ type: 'user_message', text: prompt }, false);
    try {
      await session.prompt(prompt);
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  private async clearUnsafeActiveGoal(session: Session): Promise<void> {
    try {
      await session.cancelGoal();
    } catch (rollbackError) {
      throw new HttpError(500, `Goal setup failed and rollback also failed: ${errorMessage(rollbackError)}`);
    }
  }

  private async pauseOrClearUnsafeActiveGoal(session: Session): Promise<'paused' | 'cancelled'> {
    try {
      await session.updateGoalStatus('paused');
      return 'paused';
    } catch {
      await this.clearUnsafeActiveGoal(session);
      return 'cancelled';
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  private buildMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let currentAssistant: ChatMessage | null = null;
    let userIndex = 0;
    let turnCount = 0;

    const flushUserMessagesBefore = (seq: number): void => {
      while (userIndex < this.userMessages.length) {
        const item = this.userMessages[userIndex];
        if (item === undefined || item.beforeSeq > seq) break;
        messages.push({ ...item.msg, seq: item.beforeSeq });
        userIndex++;
      }
    };

    let turnFinalized = false;

    for (const entry of this.journal) {
      const event = entry.payload as Event | WebJournalEvent;
      flushUserMessagesBefore(entry.seq);
      switch (event.type) {
        case 'turn.started': {
          turnCount += 1;
          const assistant: ChatMessage = {
            role: 'assistant',
            content: '',
            tools: [],
            seq: entry.seq,
            model: this.cachedStatus?.model,
            turnStats: {
              turn: turnCount,
              step: 0,
              status: 'done',
              firstTokenMs: null,
              llmMs: null,
              toolMs: null,
              tokens: null,
              tokensPerSec: null,
            },
          };
          currentAssistant = assistant;
          messages.push(assistant);
          break;
        }
        case 'assistant.delta':
          if (currentAssistant) {
            currentAssistant.content += event.delta;
          }
          break;
        case 'thinking.delta': {
          if (currentAssistant) {
            const t = currentAssistant.tools.find((x) => x.name === 'thinking');
            if (t) t.output = (t.output ?? '') + event.delta;
            else currentAssistant.tools.push({ toolCallId: 'thinking', name: 'thinking', args: {}, output: event.delta });
          }
          break;
        }
        case 'tool.call.started': {
          if (currentAssistant) {
            currentAssistant.tools.push({
              toolCallId: event.toolCallId,
              name: event.name,
              args: event.args,
            });
            if (currentAssistant.turnStats) currentAssistant.turnStats.step += 1;
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
        case 'web.message.finalized': {
          // Complete durable snapshot of the last turn. Replaces the skeleton
          // built from the (volatile) delta replay so content/thinking/tools
          // survive a server restart.
          const finalized = event.message as ChatMessage;
          const lastSkeletonSeq = messages.length > 0 && messages.at(-1)?.role === 'assistant'
            ? messages.at(-1)!.seq
            : entry.seq;
          finalized.seq = lastSkeletonSeq;
          if (messages.length > 0 && messages.at(-1)?.role === 'assistant') {
            messages[messages.length - 1] = finalized;
          } else {
            messages.push(finalized);
          }
          currentAssistant = null;
          turnFinalized = true;
          break;
        }
        case 'turn.ended':
          if (event.reason === 'failed' && currentAssistant) {
            currentAssistant.isError = true;
          }
          // Pre-finalization turn (no durable snapshot): body cannot be
          // rebuilt after restart — mark it honestly instead of showing "".
          if (currentAssistant && !turnFinalized && currentAssistant.content === '') {
            currentAssistant.degraded = true;
          }
          turnFinalized = false;
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
    // Drain in-flight persistence (journal lines, user messages, title
    // metadata) before returning, so a process restart never races a
    // half-written meta.json or misses the final journal lines.
    await Promise.allSettled(this.pendingWrites);
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

async function handleGoalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  resolveSession: (sessionId: string) => WebSession | undefined,
): Promise<boolean> {
  const match = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/goal(?:/(refine|pause|resume|cancel))?$`).exec(url);
  if (!match) return false;

  const webSession = resolveSession(match[1]!);
  if (!webSession) {
    sendJson(res, 404, { code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' });
    return true;
  }

  const operation = match[2];
  const method = req.method ?? 'GET';
  const expectedMethod = operation === undefined ? new Set(['POST', 'PATCH']) : new Set(['POST']);
  if (!expectedMethod.has(method)) {
    res.setHeader('Allow', [...expectedMethod].join(', '));
    sendJson(res, 405, { code: 405, message: 'Method not allowed' });
    return true;
  }

  try {
    const body = await readJsonBody(req);
    if (operation === 'refine') {
      const objective = await webSession.refineGoalDescription(requiredString(body, 'description'));
      sendJson(res, 200, { objective });
      return true;
    }
    if (operation === 'pause') {
      await webSession.pauseGoal();
      sendJson(res, 202, { ok: true });
      return true;
    }
    if (operation === 'resume') {
      await webSession.resumeGoal();
      sendJson(res, 202, { ok: true });
      return true;
    }
    if (operation === 'cancel') {
      await webSession.cancelGoal();
      sendJson(res, 202, { ok: true });
      return true;
    }

    const budgets = parseGoalBudgets(body);
    if (method === 'POST') {
      await webSession.createGoal(
        requiredString(body, 'objective'),
        optionalString(body, 'completionCriterion'),
        optionalBoolean(body, 'replace', false),
        budgets,
      );
      sendJson(res, 202, { ok: true });
      return true;
    }

    const objective = optionalString(body, 'objective');
    if (objective === undefined && body['budgets'] === undefined) {
      throw new HttpError(400, 'PATCH requires objective or budgets', 'request.invalid');
    }
    await webSession.updateGoal(objective, budgets);
    sendJson(res, 202, { ok: true });
  } catch (error) {
    sendHttpError(res, error);
  }
  return true;
}

// ─── SessionManager ───────────────────────────────────────────────────────

export class SessionManager {
  private readonly sessions = new Map<string, WebSession>();
  /** In-flight activation promises to deduplicate concurrent calls. */
  private readonly activating = new Map<string, Promise<WebSession | null>>();
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
        coreSessionId: meta.coreSessionId ?? meta.sessionId,
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
    try {
      await webSession.ready;
    } catch (error) {
      await webSession.close();
      throw error;
    }
    await saveMetadata(this.homeDir, webSession.getMetadata());
    this.sessions.set(sessionId, webSession);
    log.info('web: session created', { sessionId, workDir: this.workDir });
    return webSession;
  }

  async activateSession(sessionId: string): Promise<WebSession | null> {
    // Deduplicate concurrent activation calls: if two WS connections arrive
    // for the same archived session simultaneously, both would create a new
    // agent session and the first would be orphaned (resource leak).
    const pending = this.activating.get(sessionId);
    if (pending) return pending;

    const promise = this.doActivateSession(sessionId);
    this.activating.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.activating.delete(sessionId);
    }
  }

  private async doActivateSession(sessionId: string): Promise<WebSession | null> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      // Unknown sessionId: reject to prevent zombie session creation.
      return null;
    }
    if (existing.isActive) return existing;
    // Reactivate the exact persisted core session. Never create an empty core
    // session and present the web journal as if restoration succeeded.
    const meta = existing.getMetadata();
    const session = await this.harness.resumeSession({ id: meta.coreSessionId ?? meta.sessionId });
    const reactivated = new WebSession(session, {
      sessionId,
      workDir: meta.workDir,
      permission: meta.permission,
      yolo: this.yolo,
      homeDir: this.homeDir,
      createdAt: meta.createdAt,
      title: meta.title,
      coreSessionId: session.id,
      onFork: (id) => this.forkSession(id),
    });
    // Reload persisted journal into the reactivated session.
    const entries = await loadJournal(this.homeDir, sessionId);
    reactivated.loadFromPersisted(entries);
    try {
      await reactivated.ready;
    } catch (error) {
      await reactivated.close();
      throw error;
    }
    // Replace the archived wrapper only after core restoration and initial
    // Goal/Todo hydration have succeeded.
    await existing.close();
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
      const session = await this.harness.forkSession({ id: source.getCoreSessionId() });
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
      try {
        await webSession.ready;
      } catch (error) {
        await webSession.close();
        throw error;
      }
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

  // ── Generic Session RPC forwarding (exposed as REST endpoints) ───────────

  /** Resolve a live session or throw 404/409; the single guard for all handlers. */
  private getLiveSession(sessionId: string): Session {
    const ws = this.sessions.get(sessionId);
    if (!ws) throw new HttpError(404, 'Session not found', ErrorCodes.SESSION_NOT_FOUND);
    return ws.requireLiveSession();
  }

  async getSessionStatus(sessionId: string): Promise<ReturnType<Session['getStatus']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).getStatus();
  }

  async getSessionUsage(sessionId: string): Promise<ReturnType<Session['getUsage']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).getUsage();
  }

  async getSessionContext(sessionId: string): Promise<ReturnType<Session['getContext']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).getContext();
  }

  async getSessionPlan(sessionId: string): Promise<ReturnType<Session['getPlan']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).getPlan();
  }

  async setPermission(sessionId: string, mode: PermissionMode): Promise<void> {
    const ws = this.sessions.get(sessionId);
    if (!ws) throw new HttpError(404, 'Session not found', ErrorCodes.SESSION_NOT_FOUND);
    await ws.switchPermission(mode);
  }

  async setPlanMode(sessionId: string, enabled: boolean, strategy?: 'normal' | 'fusion'): Promise<void> {
    const ws = this.sessions.get(sessionId);
    if (!ws) throw new HttpError(404, 'Session not found', ErrorCodes.SESSION_NOT_FOUND);
    await ws.switchPlanMode(enabled, strategy);
  }

  async clearPlan(sessionId: string): Promise<void> {
    await this.getLiveSession(sessionId).clearPlan();
  }

  async setWolfpackMode(sessionId: string, enabled: boolean): Promise<void> {
    const ws = this.sessions.get(sessionId);
    if (!ws) throw new HttpError(404, 'Session not found', ErrorCodes.SESSION_NOT_FOUND);
    await ws.switchWolfpackMode(enabled);
  }

  async setRlm(sessionId: string, enabled: boolean, maxDepth?: number): Promise<void> {
    const ws = this.sessions.get(sessionId);
    if (!ws) throw new HttpError(404, 'Session not found', ErrorCodes.SESSION_NOT_FOUND);
    await ws.switchRlm(enabled, maxDepth);
  }

  async undoHistory(sessionId: string, count: number): Promise<void> {
    await this.getLiveSession(sessionId).undoHistory(count);
  }

  async compact(sessionId: string, instruction?: string): Promise<void> {
    await this.getLiveSession(sessionId).compact(instruction ? { instruction } : {});
  }

  async listSkills(sessionId: string): Promise<ReturnType<Session['listSkills']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).listSkills();
  }

  async activateSkill(sessionId: string, name: string, args?: string): Promise<void> {
    await this.getLiveSession(sessionId).activateSkill(name, args);
  }

  async removeSkill(sessionId: string, name: string): Promise<void> {
    await this.getLiveSession(sessionId).removeSkill(name);
  }

  async listPlugins(sessionId: string): Promise<ReturnType<Session['listPlugins']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).listPlugins();
  }

  async getPluginInfo(sessionId: string, id: string): Promise<ReturnType<Session['getPluginInfo']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).getPluginInfo(id);
  }

  async installPlugin(sessionId: string, source: string): Promise<ReturnType<Session['installPlugin']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).installPlugin(source);
  }

  async setPluginEnabled(sessionId: string, id: string, enabled: boolean): Promise<void> {
    await this.getLiveSession(sessionId).setPluginEnabled(id, enabled);
  }

  async setPluginMcpServerEnabled(sessionId: string, id: string, server: string, enabled: boolean): Promise<void> {
    await this.getLiveSession(sessionId).setPluginMcpServerEnabled(id, server, enabled);
  }

  async removePlugin(sessionId: string, id: string): Promise<void> {
    await this.getLiveSession(sessionId).removePlugin(id);
  }

  async reloadPlugins(sessionId: string): Promise<ReturnType<Session['reloadPlugins']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).reloadPlugins();
  }

  async activatePlugin(sessionId: string, id: string): Promise<void> {
    await this.getLiveSession(sessionId).activatePlugin(id);
  }

  async deactivatePlugin(sessionId: string, id: string): Promise<void> {
    await this.getLiveSession(sessionId).deactivatePlugin(id);
  }

  async injectPlugin(sessionId: string, id: string): Promise<void> {
    await this.getLiveSession(sessionId).injectPlugin(id);
  }

  async listMcpServers(sessionId: string): Promise<ReturnType<Session['listMcpServers']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).listMcpServers();
  }

  async getMcpStartupMetrics(sessionId: string): Promise<ReturnType<Session['getMcpStartupMetrics']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).getMcpStartupMetrics();
  }

  async addMcpServer(sessionId: string, name: string, config: Record<string, unknown>): Promise<void> {
    await this.getLiveSession(sessionId).addMcpServer(name, config);
  }

  async reconnectMcpServer(sessionId: string, name: string): Promise<void> {
    await this.getLiveSession(sessionId).reconnectMcpServer(name);
  }

  async stopMcpServer(sessionId: string, name: string): Promise<void> {
    await this.getLiveSession(sessionId).stopMcpServer(name);
  }

  async removeMcpServer(sessionId: string, name: string): Promise<void> {
    await this.getLiveSession(sessionId).removeMcpServer(name);
  }

  async listBackgroundTasks(sessionId: string, activeOnly?: boolean, limit?: number): Promise<ReturnType<Session['listBackgroundTasks']> extends Promise<infer T> ? T : never> {
    return this.getLiveSession(sessionId).listBackgroundTasks({ activeOnly, limit });
  }

  async getBackgroundTaskOutput(sessionId: string, taskId: string, tail?: number): Promise<string> {
    return this.getLiveSession(sessionId).getBackgroundTaskOutput(taskId, tail !== undefined ? { tail } : {});
  }

  async stopBackgroundTask(sessionId: string, taskId: string, reason?: string): Promise<void> {
    await this.getLiveSession(sessionId).stopBackgroundTask(taskId, reason !== undefined ? { reason } : {});
  }

  // ── Harness-level (global) forwarding, no session ────────────────────────

  getConfig(options?: { reload?: boolean }): Promise<ReturnType<ScreamHarness['getConfig']> extends Promise<infer T> ? T : never> {
    return this.harness.getConfig(options);
  }

  setConfig(patch: Parameters<ScreamHarness['setConfig']>[0]): Promise<ReturnType<ScreamHarness['setConfig']> extends Promise<infer T> ? T : never> {
    return this.harness.setConfig(patch);
  }

  removeProvider(providerId: string): Promise<ReturnType<ScreamHarness['removeProvider']> extends Promise<infer T> ? T : never> {
    return this.harness.removeProvider(providerId);
  }

  getExperimentalFlags(): Promise<ReturnType<ScreamHarness['getExperimentalFlags']> extends Promise<infer T> ? T : never> {
    return this.harness.getExperimentalFlags();
  }

  preflight(): Promise<void> {
    return this.harness.preflight();
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
  // Source tree static dir: when running from source before a build it only
  // carries the pairing page, so `/gateway` must still resolve instead of 500.
  const sourcePublicDir = join(baseDir, 'frontend', 'public');
  let publicDir = prodPublicDir;
  try {
    await access(join(devPublicDir, 'index.html'));
    publicDir = devPublicDir;
  } catch {
    try {
      await access(join(sourcePublicDir, 'gateway.html'));
      publicDir = sourcePublicDir;
    } catch {
      // Fall back to prodPublicDir.
    }
  }

  const httpServer: HttpServer = createServer(async (req: IncomingMessage, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (await handleGoalRoute(req, res, url, (sessionId) => sessionId === webSession.sessionId ? webSession : undefined)) {
      return;
    }

    const snapshotMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/snapshot(\\?|$)`).exec(url);
    if (snapshotMatch && method === 'GET') {
      const sid = snapshotMatch[1]!;
      if (sid !== webSession.sessionId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      try {
        await webSession.ready;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const tail = Number(query.get('tail') ?? '');
        sendJson(res, 200, Number.isFinite(tail) && tail > 0 ? webSession.getSnapshot({ tail }) : webSession.getSnapshot());
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

    // Older message history page (before = seq cursor) + full thinking entry (seq + tool)
    if (url.startsWith(`${API_PREFIX}/sessions/${webSession.sessionId}/messages?`) && method === 'GET') {
      try {
        await webSession.ready;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const seq = Number(query.get('seq') ?? '0');
        const tool = query.get('tool') ?? '';
        if (Number.isFinite(seq) && seq > 0 && tool) {
          sendJson(res, 200, { output: webSession.getThinkingEntry(seq, tool) });
          return;
        }
        const before = Number(query.get('before') ?? '0');
        const tail = Number(query.get('tail') ?? '50');
        const page = Number.isFinite(before) && before > 0 ? webSession.getMessagesOlder(before, Number.isFinite(tail) && tail > 0 ? tail : 50) : { messages: [], hasMore: false };
        sendJson(res, 200, page);
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

    // Git status for the status bar
    if (url === `${API_PREFIX}/git/status` && method === 'GET') {
      const gs = await getGitStatus(opts.workDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gs));
      return;
    }

    // Single-file git diff
    if (url.startsWith(`${API_PREFIX}/git/diff?`) && method === 'GET') {
      const relPath = new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? '';
      try {
        const result = await getGitFileDiff(opts.workDir, relPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: relPath, patch: result?.patch ?? '' }));
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

    // File gate (read-only browsing of this session's workdir)
    if (await handleFilesRoutes(req, res, url, method, API_PREFIX, new FileGate(() => [opts.workDir]))) {
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

  try {
    await webSession.ready;
  } catch (error) {
    wss.close();
    await webSession.close();
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${opts.port} 已被占用，请先关闭占用该端口的进程，或使用 --port <port> 指定其他端口。`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(opts.port, '127.0.0.1', resolve);
  });

  const address = httpServer.address() as AddressInfo;
  const url = `http://localhost:${address.port}`;

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
  /** LAN mode: bind 0.0.0.0 and require gateway auth for non-loopback clients. */
  readonly lan?: boolean;
  /** Explicit gateway access key (persisted, replacing any stored key). */
  readonly token?: string;
}

// ─── Session-control REST routes (status/usage/context/plan + mode toggles) ─
// Every route returns `false` so the caller falls through when the URL does not
// match, and routes are wired in runWebServer after the goal route.

async function handleSessionControlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  manager: SessionManager,
): Promise<boolean> {
  // Query set (GET)
  const statusMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/status$`).exec(url);
  if (statusMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.getSessionStatus(decodeURIComponent(statusMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  const usageMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/usage$`).exec(url);
  if (usageMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.getSessionUsage(decodeURIComponent(usageMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  const contextMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/context$`).exec(url);
  if (contextMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.getSessionContext(decodeURIComponent(contextMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  const planMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plan$`).exec(url);
  if (planMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.getSessionPlan(decodeURIComponent(planMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }

  // Mutation set (POST)
  const permissionMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/permission$`).exec(url);
  if (permissionMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const mode = requiredString(body, 'mode') as PermissionMode;
      await manager.setPermission(decodeURIComponent(permissionMatch[1]!), mode);
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const planModeMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plan$`).exec(url);
  if (planModeMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const enabled = optionalBoolean(body, 'enabled', true);
      const strategy = optionalString(body, 'strategy') as 'normal' | 'fusion' | undefined;
      await manager.setPlanMode(decodeURIComponent(planModeMatch[1]!), enabled, strategy);
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const clearPlanMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plan/clear$`).exec(url);
  if (clearPlanMatch && method === 'POST') {
    try {
      await manager.clearPlan(decodeURIComponent(clearPlanMatch[1]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const wolfpackMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/wolfpack$`).exec(url);
  if (wolfpackMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const enabled = optionalBoolean(body, 'enabled', true);
      await manager.setWolfpackMode(decodeURIComponent(wolfpackMatch[1]!), enabled);
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const rlmMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/rlm$`).exec(url);
  if (rlmMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const enabled = optionalBoolean(body, 'enabled', true);
      const maxDepth = typeof body['maxDepth'] === 'number' ? Number(body['maxDepth']) : undefined;
      await manager.setRlm(decodeURIComponent(rlmMatch[1]!), enabled, maxDepth);
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const undoMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/undo$`).exec(url);
  if (undoMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const count = typeof body['count'] === 'number' ? Number(body['count']) : 1;
      await manager.undoHistory(decodeURIComponent(undoMatch[1]!), count);
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const compactMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/compact$`).exec(url);
  if (compactMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await manager.compact(decodeURIComponent(compactMatch[1]!), optionalString(body, 'instruction'));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }

  return false;
}

// ─── Resource REST routes (skills / plugins / MCP / background tasks) ────────

async function handleResourceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  manager: SessionManager,
): Promise<boolean> {
  // Skills
  const skillsMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/skills$`).exec(url);
  if (skillsMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.listSkills(decodeURIComponent(skillsMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  const skillActivateMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/skills/([^/]+)/activate$`).exec(url);
  if (skillActivateMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await manager.activateSkill(decodeURIComponent(skillActivateMatch[1]!), decodeURIComponent(skillActivateMatch[2]!), optionalString(body, 'args'));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const skillRemoveMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/skills/([^/]+)$`).exec(url);
  if (skillRemoveMatch && method === 'DELETE') {
    try {
      await manager.removeSkill(decodeURIComponent(skillRemoveMatch[1]!), decodeURIComponent(skillRemoveMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }

  // Plugins
  const pluginsMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins$`).exec(url);
  if (pluginsMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.listPlugins(decodeURIComponent(pluginsMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  const pluginInstallMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/install$`).exec(url);
  if (pluginInstallMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await manager.installPlugin(decodeURIComponent(pluginInstallMatch[1]!), requiredString(body, 'source')));
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const pluginReloadMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/reload$`).exec(url);
  if (pluginReloadMatch && method === 'POST') {
    try {
      sendJson(res, 200, await manager.reloadPlugins(decodeURIComponent(pluginReloadMatch[1]!)));
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  // /plugins/:pid/enable, /:pid/mcp/:server/enable, /:pid/activate, /:pid/deactivate, /:pid/inject, DELETE /:pid
  const pluginEnableMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/([^/]+)/enable$`).exec(url);
  if (pluginEnableMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await manager.setPluginEnabled(decodeURIComponent(pluginEnableMatch[1]!), decodeURIComponent(pluginEnableMatch[2]!), optionalBoolean(body, 'enabled', true));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const pluginMcpEnableMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/([^/]+)/mcp/([^/]+)/enable$`).exec(url);
  if (pluginMcpEnableMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await manager.setPluginMcpServerEnabled(
        decodeURIComponent(pluginMcpEnableMatch[1]!),
        decodeURIComponent(pluginMcpEnableMatch[2]!),
        decodeURIComponent(pluginMcpEnableMatch[3]!),
        optionalBoolean(body, 'enabled', true),
      );
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const pluginActivateMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/([^/]+)/activate$`).exec(url);
  if (pluginActivateMatch && method === 'POST') {
    try {
      await manager.activatePlugin(decodeURIComponent(pluginActivateMatch[1]!), decodeURIComponent(pluginActivateMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const pluginDeactivateMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/([^/]+)/deactivate$`).exec(url);
  if (pluginDeactivateMatch && method === 'POST') {
    try {
      await manager.deactivatePlugin(decodeURIComponent(pluginDeactivateMatch[1]!), decodeURIComponent(pluginDeactivateMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const pluginInjectMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/([^/]+)/inject$`).exec(url);
  if (pluginInjectMatch && method === 'POST') {
    try {
      await manager.injectPlugin(decodeURIComponent(pluginInjectMatch[1]!), decodeURIComponent(pluginInjectMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  // `install` and `reload` are reserved action words, not plugin ids; exclude
  // them from the :pid routes so GET/DELETE /plugins/install|reload never hit
  // getPluginInfo/removePlugin for those words.
  const pluginInfoMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/plugins/(?!(?:install|reload)$)([^/]+)$`).exec(url);
  if (pluginInfoMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.getPluginInfo(decodeURIComponent(pluginInfoMatch[1]!), decodeURIComponent(pluginInfoMatch[2]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  if (pluginInfoMatch && method === 'DELETE') {
    try {
      await manager.removePlugin(decodeURIComponent(pluginInfoMatch[1]!), decodeURIComponent(pluginInfoMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }

  // MCP servers
  const mcpMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/mcp$`).exec(url);
  if (mcpMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.listMcpServers(decodeURIComponent(mcpMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  const mcpMetricsMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/mcp/startup-metrics$`).exec(url);
  if (mcpMetricsMatch && method === 'GET') {
    try { sendJson(res, 200, await manager.getMcpStartupMetrics(decodeURIComponent(mcpMetricsMatch[1]!))); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  const mcpAddMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/mcp/add$`).exec(url);
  if (mcpAddMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await manager.addMcpServer(decodeURIComponent(mcpAddMatch[1]!), requiredString(body, 'name'), (body['config'] as Record<string, unknown>) ?? {});
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const mcpReconnectMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/mcp/([^/]+)/reconnect$`).exec(url);
  if (mcpReconnectMatch && method === 'POST') {
    try {
      await manager.reconnectMcpServer(decodeURIComponent(mcpReconnectMatch[1]!), decodeURIComponent(mcpReconnectMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const mcpStopMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/mcp/([^/]+)/stop$`).exec(url);
  if (mcpStopMatch && method === 'POST') {
    try {
      await manager.stopMcpServer(decodeURIComponent(mcpStopMatch[1]!), decodeURIComponent(mcpStopMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  // `add`, `reconnect`, `stop`, `startup-metrics` are reserved action words, not
  // server names; exclude them so DELETE /mcp/add|reconnect|stop|startup-metrics
  // never removes a segment as if it were a server name.
  const mcpRemoveMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/mcp/(?!(?:add|reconnect|stop|startup-metrics)$)([^/]+)$`).exec(url);
  if (mcpRemoveMatch && method === 'DELETE') {
    try {
      await manager.removeMcpServer(decodeURIComponent(mcpRemoveMatch[1]!), decodeURIComponent(mcpRemoveMatch[2]!));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }

  // Background tasks
  const tasksMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/tasks$`).exec(url);
  if (tasksMatch && method === 'GET') {
    try {
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      const activeOnly = query.get('activeOnly') === 'true' ? true : query.get('activeOnly') === 'false' ? false : undefined;
      const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
      sendJson(res, 200, await manager.listBackgroundTasks(decodeURIComponent(tasksMatch[1]!), activeOnly, limit));
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const taskOutputMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/tasks/([^/]+)/output$`).exec(url);
  if (taskOutputMatch && method === 'GET') {
    try {
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      const tail = query.get('tail') ? Number(query.get('tail')) : undefined;
      sendJson(res, 200, { output: await manager.getBackgroundTaskOutput(decodeURIComponent(taskOutputMatch[1]!), decodeURIComponent(taskOutputMatch[2]!), tail) });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const taskStopMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/tasks/([^/]+)/stop$`).exec(url);
  if (taskStopMatch && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await manager.stopBackgroundTask(decodeURIComponent(taskStopMatch[1]!), decodeURIComponent(taskStopMatch[2]!), optionalString(body, 'reason'));
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }

  return false;
}

// ─── Global (harness-scoped) REST routes: config / flags / preflight ───────

async function handleGlobalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  manager: SessionManager,
): Promise<boolean> {
  if (url === `${API_PREFIX}/config` && method === 'GET') {
    try { sendJson(res, 200, await manager.getConfig()); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  if (url === `${API_PREFIX}/config` && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const patch = body['patch'];
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new HttpError(400, 'Missing or invalid patch field', 'request.invalid');
      }
      sendJson(res, 200, await manager.setConfig(patch as Parameters<SessionManager['setConfig']>[0]));
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  const providerMatch = new RegExp(`^${API_PREFIX}/config/providers/([^/]+)$`).exec(url);
  if (providerMatch && method === 'DELETE') {
    try {
      sendJson(res, 200, await manager.removeProvider(decodeURIComponent(providerMatch[1]!)));
    } catch (error) { sendHttpError(res, error); }
    return true;
  }
  if (url === `${API_PREFIX}/experimental-flags` && method === 'GET') {
    try { sendJson(res, 200, await manager.getExperimentalFlags()); }
    catch (error) { sendHttpError(res, error); }
    return true;
  }
  if (url === `${API_PREFIX}/preflight` && method === 'GET') {
    try {
      await manager.preflight();
      sendJson(res, 200, { ok: true });
    } catch (error) { sendHttpError(res, error); }
    return true;
  }

  return false;
}

export async function runWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
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

  // ── Gateway (LAN mode security layer) ───────────────────────────────────
  const lanMode = opts.lan === true;
  const host = lanMode ? '0.0.0.0' : '127.0.0.1';
  const gateway = lanMode ? await GatewayAuth.setup({ homeDir, token: opts.token }) : null;
  const loginLimiter = createFixedWindowLimiter({ windowMs: 5 * 60_000, max: 10 });

  // Resume the most recent session for this working directory, but never
  // auto-create one: sessions are created only on explicit user action.
  // A stale metadata entry (core session already purged) must not crash
  // startup — the user simply starts from the empty state.
  if (!manager.list().some((s) => s.active)) {
    const recent = manager.list().find((s) => s.workDir === workDir);
    if (recent) {
      try {
        await manager.activateSession(recent.sessionId);
      } catch (error) {
        log.warn('web: resume of most recent session failed', {
          sessionId: recent.sessionId,
          error: errorMessage(error),
        });
      }
    }
  }

  // ── HTTP server ────────────────────────────────────────────────────────
  const baseDir = import.meta.dirname;
  const prodPublicDir = join(baseDir, 'public');
  const devPublicDir = join(baseDir, 'frontend', 'dist');
  // Source tree static dir: when running from source before a build it only
  // carries the pairing page, so `/gateway` must still resolve instead of 500.
  const sourcePublicDir = join(baseDir, 'frontend', 'public');
  let publicDir = prodPublicDir;
  try {
    await access(join(devPublicDir, 'index.html'));
    publicDir = devPublicDir;
  } catch {
    try {
      await access(join(sourcePublicDir, 'gateway.html'));
      publicDir = sourcePublicDir;
    } catch {
      // Fall back to prodPublicDir.
    }
  }

  const httpServer: HttpServer = createServer(async (req: IncomingMessage, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // ── Gateway auth gate (LAN mode) ──────────────────────────────────────
    // Loopback clients are always trusted; non-local clients must present a
    // valid gateway session cookie, except for the gateway page and the
    // gateway API endpoints themselves.
    if (gateway) {
      const verdict = gatewayVerdict({
        loopback: isLoopbackAddress(req.socket.remoteAddress),
        authenticated: gateway.verifySession(req.headers.cookie),
        path: url.split('?')[0] ?? '/',
        method,
        apiPrefix: API_PREFIX,
      });
      if (verdict === 'redirect') {
        res.writeHead(302, { Location: `/gateway?next=${encodeURIComponent(url)}` });
        res.end();
        return;
      }
      if (verdict === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 40101, message: 'unauthorized' }));
        return;
      }
    }

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

    if (await handleGoalRoute(req, res, url, (sessionId) => manager.get(sessionId))) {
      return;
    }

    // Session-control REST routes (status/usage/context/plan/mode toggles)
    if (await handleSessionControlRoutes(req, res, url, method, manager)) {
      return;
    }

    // Resource REST routes (skills/plugins/MCP/background tasks)
    if (await handleResourceRoutes(req, res, url, method, manager)) {
      return;
    }

    // Global (harness-scoped) REST routes (config/flags/preflight)
    if (await handleGlobalRoutes(req, res, url, method, manager)) {
      return;
    }

    // Snapshot
    const snapshotMatch = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/snapshot(\\?|$)`).exec(url);
    if (snapshotMatch && method === 'GET') {
      const sessionId = decodeURIComponent(snapshotMatch[1]!);
      const ws = manager.get(sessionId);
      if (!ws) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      try {
        await ws.ready;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const tail = Number(query.get('tail') ?? '');
        sendJson(res, 200, Number.isFinite(tail) && tail > 0 ? ws.getSnapshot({ tail }) : ws.getSnapshot());
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

    // Older message history page (before = seq cursor), or full thinking entry (seq + tool)
    const olderMatch = /^\/api\/v1\/sessions\/([^/?]+)\/messages(\?|$)/.exec(url);
    if (olderMatch && method === 'GET') {
      const sessionId = decodeURIComponent(olderMatch[1]!);
      const ws = manager.get(sessionId);
      if (!ws) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'Session not found' }));
        return;
      }
      try {
        await ws.ready;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const seq = Number(query.get('seq') ?? '0');
        const tool = query.get('tool') ?? '';
        if (Number.isFinite(seq) && seq > 0 && tool) {
          sendJson(res, 200, { output: ws.getThinkingEntry(seq, tool) });
          return;
        }
        const before = Number(query.get('before') ?? '0');
        const tail = Number(query.get('tail') ?? '50');
        const page = Number.isFinite(before) && before > 0 ? ws.getMessagesOlder(before, Number.isFinite(tail) && tail > 0 ? tail : 50) : { messages: [], hasMore: false };
        sendJson(res, 200, page);
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

    // Git status for the status bar
    if (url === `${API_PREFIX}/git/status` && method === 'GET') {
      const gs = await getGitStatus(workDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gs));
      return;
    }

    // Single-file git diff
    if (url.startsWith(`${API_PREFIX}/git/diff?`) && method === 'GET') {
      const relPath = new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? '';
      try {
        const result = await getGitFileDiff(workDir, relPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: relPath, patch: result?.patch ?? '' }));
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

  // ── File gate (read-only browsing of session workdirs) ───────────────────

  function makeFileGate(): FileGate {
    return new FileGate(() => manager.list().map((s) => s.workDir));
  }

  if (await handleFilesRoutes(req, res, url, method, API_PREFIX, makeFileGate())) {
    return;
  }

    // Like preferences (shared with the TUI via tui.toml + user-prefs.md)
    if (url === `${API_PREFIX}/like` && method === 'GET') {
      try {
        sendJson(res, 200, await loadLikePreferences());
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }
    if (url === `${API_PREFIX}/like` && method === 'PUT') {
      try {
        const body = await readJsonBody(req);
        const prefs = TuiLikePreferencesSchema.parse(body);
        await saveLikePreferences(prefs);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

    // List available models (from harness config, reloaded)
    if (url === `${API_PREFIX}/models` && method === 'GET') {      try {
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

    // ── Gateway (LAN mode) ─────────────────────────────────────────────────

    if (gateway && url === `${API_PREFIX}/gateway/status` && method === 'GET') {
      const loopback = isLoopbackAddress(req.socket.remoteAddress);
      sendJson(res, 200, {
        authRequired: true,
        authenticated: loopback || gateway.verifySession(req.headers.cookie),
      });
      return;
    }

    if (gateway && url === `${API_PREFIX}/gateway/login` && method === 'POST') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const attempt = loginLimiter.hit(ip);
      if (!attempt.ok) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(attempt.retryAfterSeconds),
        });
        res.end(JSON.stringify({
          code: 42903,
          message: `尝试过于频繁，请 ${attempt.retryAfterSeconds} 秒后重试`,
          retryAfter: attempt.retryAfterSeconds,
        }));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const key = typeof body['key'] === 'string' ? body['key'] : '';
        if (!gateway.verifyKey(key)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 40101, message: '访问密钥错误' }));
          return;
        }
        loginLimiter.reset(ip);
        const sid = gateway.createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': gateway.sessionCookie(sid),
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        sendHttpError(res, error);
      }
      return;
    }

    if (gateway && url === `${API_PREFIX}/gateway/logout` && method === 'POST') {
      gateway.destroySession(req.headers.cookie);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': gateway.clearCookie(),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (gateway && url === '/gateway' && method === 'GET') {
      try {
        const html = await readFile(join(publicDir, 'gateway.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('gateway page missing — did you run pnpm web:build?');
      }
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
    if (gateway && !isLoopbackAddress(req.socket.remoteAddress) && !gateway.verifySession(req.headers.cookie)) {
      ws.close(1008, 'unauthorized');
      return;
    }
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
        }).catch((error: unknown) => {
          log.warn('web: session activation failed', { sessionId, error: errorMessage(error) });
          ws.close(1011, 'Session activation failed');
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
      }).catch((error: unknown) => {
        log.warn('web: session activation failed', { sessionId, error: errorMessage(error) });
        ws.close(1011, 'Session activation failed');
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
    // No session exists yet (fresh install or all deleted): keep the socket
    // open in an idle state instead of closing, so the client does not enter
    // a reconnect loop. The user creates the first session explicitly.
    ws.send(JSON.stringify({ type: 'server_empty' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${opts.port} 已被占用，请先关闭占用该端口的进程，或使用 --port <port> 指定其他端口。`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(opts.port, host, resolve);
  });

  const address = httpServer.address();
  const realPort = typeof address === 'object' && address !== null ? address.port : opts.port;
  const url = `http://localhost:${realPort}`;

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

  let banner =
    `\n  Scream Web UI ready: ${url}\n` +
    `  Working directory: ${workDir}\n` +
    `  Sessions: ${manager.list().length} (${manager.list().filter((s) => s.active).length} active)\n` +
    `  Permission: ${opts.yolo ? 'yolo' : opts.auto ? 'auto' : 'manual'}\n`;

  if (gateway) {
    const addrs = getLanAddresses();
    banner += `  LAN mode: on — non-local devices must present the access key\n`;
    if (addrs.length > 0) {
      for (const addr of addrs) {
        banner += `    http://${addr}:${realPort}\n`;
      }
    } else {
      banner += `    (no reachable LAN IPv4 address found)\n`;
    }
    if (gateway.plaintext !== null) {
      banner += `  Access key: ${gateway.plaintext}${gateway.generated ? ' (auto-generated, saved, persists across restarts)' : ''}\n`;
    } else {
      banner += `  Access key: (saved in a previous run — use --reset-password to change)\n`;
    }
    if (addrs.length > 0) {
      try {
        const qr = await qrToString(`http://${addrs[0]!}:${realPort}`, { type: 'terminal', small: true });
        banner += `\n${qr}\n`;
      } catch {
        // QR is best-effort; the URL lines above are sufficient.
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(banner);

  return { url, close: cleanup };
}
