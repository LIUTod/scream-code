/**
 * Bot gateway persistence (bot.db).
 *
 * One SQLite file owns bots, threads, runs, approvals, questions and the
 * reserved handoff/room tables. The gateway is the only writer; the UI reads
 * through REST. `node:sqlite` is synchronous, so every helper here is too — the
 * async boundary lives in the runtime, not in the store.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateBotDatabase } from './migrations';

import type {
  ApprovalDecision,
  Attachment,
  ApprovalStatus,
  AuditEntry,
  BotStatus,
  CreateBotInput,
  CreateThreadInput,
  HandoffStatus,
  Message,
  RecoveryDecision,
  RunKind,
  QuestionItem,
  RunStatus,
  ToolPolicy,
  UpdateBotInput,
} from '../shared/contracts';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
export const DEFAULT_QUESTION_TIMEOUT_MS = 300_000;

/** Stored bot row. `status`/`unread`/`needsYou` are derived, never stored. */
export interface RoomRecord {
  readonly id: string;
  readonly name: string;
  readonly leadBotId: string | null;
  readonly memberIds: readonly string[];
  readonly createdAt: number;
}

export interface RoomMessageRecord {
  readonly id: string;
  readonly attachments?: readonly Attachment[];
  readonly roomId: string;
  readonly speakerKind: 'user' | 'bot' | 'system';
  readonly speakerId: string;
  readonly content: string;
  readonly via: 'direct' | 'handoff';
  readonly answeredBy: string | null;
  readonly runId: string | null;
  readonly roomRequestId: string | null;
  readonly createdAt: number;
}

export interface BotRecord {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly rolePrompt: string;
  readonly avatarSeed: string;
  readonly avatarEmoji: string | null;
  readonly accentHue: number | null;
  readonly workspace: string;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly permission: string;
  readonly toolPolicy: ToolPolicy;
  readonly paused: boolean;
  readonly createdAt: number;
  readonly lastActiveAt: number | null;
  readonly configRevision: number;
}

export interface ThreadRecord {
  readonly workspace: string;
  readonly blockedByRunId: string | null;
  readonly projectionVersion: number;
  /** Legacy sessions pinned their role into the profile; new ones read it at runtime. */
  readonly pinnedRole: boolean;
  readonly appliedConfigRevision: number;
  readonly id: string;
  readonly botId: string;
  readonly coreSessionId: string | null;
  readonly title: string;
  readonly lastActiveAt: number;
  readonly archivedAt: number | null;
  readonly handoffDepth: number;
  readonly unread: number;
  readonly createdAt: number;
}

export interface RunRecord {
  readonly input: { readonly text: string } | null;
  readonly requestKey: string | null;
  readonly kind: RunKind;
  readonly origin: unknown;
  readonly coreSessionId: string | null;
  readonly sessionGeneration: string | null;
  readonly turnId: number | null;
  readonly dispatchStartedAt: number | null;
  readonly retryOfRunId: string | null;
  readonly recoveryDecision: RecoveryDecision | null;
  readonly recoveryAt: number | null;
  readonly recoveryRunId: string | null;
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly parentRunId: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly requestId: string;
  readonly toolName: string;
  readonly action: string;
  readonly reasons: readonly string[];
  readonly grantOptions: readonly ('once' | 'session')[];
  readonly status: ApprovalStatus;
  readonly decision: ApprovalDecision | null;
  readonly feedback: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface QuestionRecord {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly requestId: string;
  readonly items: readonly QuestionItem[];
  readonly answers: Readonly<Record<string, string | readonly string[]>> | null;
  readonly status: 'pending' | 'answered' | 'expired';
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface BotCounters {
  readonly unread: number;
  readonly needsYou: number;
}

/** One queued hand-off between two Bots; the gateway owns every write. */
export interface HandoffRecord {
  readonly id: string;
  readonly fromBotId: string;
  readonly fromThreadId: string;
  readonly toBotId: string;
  readonly toThreadId: string | null;
  readonly targetRunId: string | null;
  readonly relayRunId: string | null;
  readonly relayStatus: string | null;
  readonly parentRunId: string | null;
  readonly depth: number;
  readonly task: string;
  readonly constraints: string | null;
  readonly expecting: string | null;
  readonly status: HandoffStatus;
  readonly error: string | null;
  readonly answer: string | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
}

export interface CreateRunInput {
  readonly text?: string;
  readonly requestKey?: string;
  readonly kind?: RunKind;
  readonly origin?: unknown;
  readonly retryOfRunId?: string;
  readonly botId: string;
  readonly threadId: string;
  readonly parentRunId?: string | null;
}

export interface CreateApprovalInput {
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly requestId: string;
  readonly toolName: string;
  readonly action: string;
  readonly reasons: readonly string[];
  readonly grantOptions: readonly ('once' | 'session')[];
  readonly expiresAt: number;
}

export interface CreateQuestionInput {
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly requestId: string;
  readonly items: readonly QuestionItem[];
  readonly expiresAt: number;
}

export interface CreateHandoffInput {
  readonly fromBotId: string;
  readonly fromThreadId: string;
  readonly toBotId: string;
  readonly toThreadId: string;
  readonly parentRunId: string | null;
  readonly depth: number;
  readonly task: string;
  readonly constraints: string | null;
  readonly expecting: string | null;
  readonly idempotencyKey: string;
  readonly targetRunId?: string | null | undefined;
}

export interface AppendAuditInput {
  readonly actor: string;
  readonly initiator: AuditEntry['initiator'];
  readonly action: string;
  readonly decision?: string | null;
  readonly botId?: string | null;
  readonly threadId?: string | null;
  readonly payload?: unknown;
}

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  role_prompt TEXT NOT NULL DEFAULT '',
  avatar_seed TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL,
  model TEXT,
  thinking TEXT,
  permission TEXT NOT NULL DEFAULT 'bot',
  tool_policy_json TEXT NOT NULL DEFAULT '{}',
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  core_session_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  last_active_at INTEGER NOT NULL,
  archived_at INTEGER,
  handoff_depth INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_bot ON threads(bot_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_run_id TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  grant_options_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  feedback TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status, bot_id);
CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  request_id TEXT NOT NULL,
  items_json TEXT NOT NULL,
  answers_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_pending ON questions(status, bot_id);

-- One row per message_bot hand-off; the answer is written back when the target
-- run finishes, and the source thread is then prompted for a follow-up.
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  from_bot_id TEXT NOT NULL,
  from_thread_id TEXT NOT NULL,
  to_bot_id TEXT NOT NULL,
  to_thread_id TEXT,
  parent_run_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  task TEXT NOT NULL,
  constraints TEXT,
  expecting TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  answer TEXT,
  completed_at INTEGER,
  idempotency_key TEXT NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_idempotency ON handoffs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_handoffs_to_thread ON handoffs(to_thread_id, status);

-- Reserved for M3 (rooms). Schema only in M0/M1.
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lead_bot_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, bot_id)
);
CREATE TABLE IF NOT EXISTS room_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  speaker_kind TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  content TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT 'direct',
  answered_by TEXT,
  source_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at);
CREATE TABLE IF NOT EXISTS room_threads (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  core_session_id TEXT,
  PRIMARY KEY (room_id, bot_id)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  initiator TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT,
  bot_id TEXT,
  thread_id TEXT,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_bot ON audit(bot_id, created_at DESC);
`;

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_user'];

/** How many bots the UI may create; keeps a runaway client from filling the disk. */
const MAX_BOTS = 64;

function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToBot(row: Record<string, unknown>): BotRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    title: String(row['title']),
    rolePrompt: String(row['role_prompt']),
    avatarSeed: String(row['avatar_seed']),
    avatarEmoji: toStringOrNull(row['avatar_emoji']),
    accentHue: row['accent_hue'] === null || row['accent_hue'] === undefined ? null : Number(row['accent_hue']),
    workspace: String(row['workspace']),
    model: toStringOrNull(row['model']),
    thinking: toStringOrNull(row['thinking']),
    permission: String(row['permission']),
    toolPolicy: parseJson<ToolPolicy>(row['tool_policy_json'], {}),
    paused: toBool(row['paused']),
    createdAt: Number(row['created_at']),
    lastActiveAt: toNumberOrNull(row['last_active_at']),
    configRevision: Number(row['config_revision'] ?? 1),
  };
}

function rowToThread(row: Record<string, unknown>): ThreadRecord {
  return {
    workspace: toStringOrNull(row['workspace']) ?? '',
    blockedByRunId: toStringOrNull(row['blocked_by_run_id']),
    projectionVersion: Number(row['projection_version'] ?? 0),
    pinnedRole: Number(row['pinned_role'] ?? 0) === 1,
    appliedConfigRevision: Number(row['applied_config_revision'] ?? 0),
    id: String(row['id']),
    botId: String(row['bot_id']),
    coreSessionId: toStringOrNull(row['core_session_id']),
    title: String(row['title']),
    lastActiveAt: Number(row['last_active_at']),
    archivedAt: toNumberOrNull(row['archived_at']),
    handoffDepth: Number(row['handoff_depth']),
    unread: Number(row['unread']),
    createdAt: Number(row['created_at']),
  };
}

function rowToRoomMessage(row: Record<string, unknown>): RoomMessageRecord {
  return {
    id: String(row['id']),
    roomId: String(row['room_id']),
    speakerKind: row['speaker_kind'] as RoomMessageRecord['speakerKind'],
    speakerId: String(row['speaker_id']),
    content: String(row['content']),
    via: row['via'] as RoomMessageRecord['via'],
    answeredBy: toStringOrNull(row['answered_by']),
    runId: toStringOrNull(row['run_id']),
    roomRequestId: toStringOrNull(row['room_request_id']),
    createdAt: Number(row['created_at']),
    ...(parseJson<readonly Attachment[] | null>(row['attachments_json'], null) === null
      ? {}
      : { attachments: parseJson<readonly Attachment[]>(row['attachments_json'], []) }),
  };
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    input: parseJson<{ text: string } | null>(row['input_json'], null),
    requestKey: toStringOrNull(row['request_key']),
    kind: row['kind'] === 'observed' ? 'observed' : 'prompt',
    origin: parseJson(row['origin_json'], null),
    coreSessionId: toStringOrNull(row['core_session_id']),
    sessionGeneration: toStringOrNull(row['session_generation']),
    turnId: toNumberOrNull(row['turn_id']),
    dispatchStartedAt: toNumberOrNull(row['dispatch_started_at']),
    retryOfRunId: toStringOrNull(row['retry_of_run_id']),
    recoveryDecision: toStringOrNull(row['recovery_decision']) as RecoveryDecision | null,
    recoveryAt: toNumberOrNull(row['recovery_at']),
    recoveryRunId: toStringOrNull(row['recovery_run_id']),
    id: String(row['id']),
    botId: String(row['bot_id']),
    threadId: String(row['thread_id']),
    status: String(row['status']) as RunStatus,
    parentRunId: toStringOrNull(row['parent_run_id']),
    startedAt: toNumberOrNull(row['started_at']),
    endedAt: toNumberOrNull(row['ended_at']),
    error: toStringOrNull(row['error']),
    createdAt: Number(row['created_at']),
  };
}

function rowToHandoff(row: Record<string, unknown>): HandoffRecord {
  return {
    id: String(row['id']),
    fromBotId: String(row['from_bot_id']),
    fromThreadId: String(row['from_thread_id']),
    toBotId: String(row['to_bot_id']),
    toThreadId: toStringOrNull(row['to_thread_id']),
    targetRunId: toStringOrNull(row['target_run_id']),
    relayRunId: toStringOrNull(row['relay_run_id']),
    relayStatus: toStringOrNull(row['relay_status']),
    parentRunId: toStringOrNull(row['parent_run_id']),
    depth: Number(row['depth']),
    task: String(row['task']),
    constraints: toStringOrNull(row['constraints']),
    expecting: toStringOrNull(row['expecting']),
    status: String(row['status']) as HandoffStatus,
    error: toStringOrNull(row['error']),
    answer: toStringOrNull(row['answer']),
    completedAt: toNumberOrNull(row['completed_at']),
    createdAt: Number(row['created_at']),
  };
}

function rowToApproval(row: Record<string, unknown>): ApprovalRecord {
  const decision = toStringOrNull(row['decision']) ?? '';
  return {
    id: String(row['id']),
    botId: String(row['bot_id']),
    threadId: String(row['thread_id']),
    runId: toStringOrNull(row['run_id']),
    requestId: String(row['request_id']),
    toolName: String(row['tool_name']),
    action: String(row['action']),
    reasons: parseJson<string[]>(row['reasons_json'], []),
    grantOptions: parseJson<('once' | 'session')[]>(row['grant_options_json'], []),
    status: String(row['status']) as ApprovalStatus,
    decision:
      decision === 'allow_once' || decision === 'allow_session' || decision === 'deny'
        ? decision
        : null,
    feedback: toStringOrNull(row['feedback']),
    createdAt: Number(row['created_at']),
    expiresAt: Number(row['expires_at']),
  };
}

function rowToQuestion(row: Record<string, unknown>): QuestionRecord {
  const status = String(row['status']);
  return {
    id: String(row['id']),
    botId: String(row['bot_id']),
    threadId: String(row['thread_id']),
    runId: toStringOrNull(row['run_id']),
    requestId: String(row['request_id']),
    items: parseJson<QuestionItem[]>(row['items_json'], []),
    answers: parseJson<Record<string, string | readonly string[]>>(row['answers_json'], {}),
    status: status === 'answered' || status === 'expired' ? status : 'pending',
    createdAt: Number(row['created_at']),
    expiresAt: Number(row['expires_at']),
  };
}

export class BotStore {
  private readonly dbPath: string;
  private readonly now: () => number;
  private db: DatabaseSync | undefined;

  constructor(dbPath: string, options: { readonly now?: () => number } = {}) {
    this.dbPath = dbPath;
    this.now = options.now ?? Date.now;
  }

  /** Open the database (creating the parent directory) and run migrations. */
  open(): void {
    if (this.db !== undefined) return;
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    try {
      migrateBotDatabase(db, this.dbPath, SCHEMA_V1);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    // Older databases may hold Bots created before a default conversation was
    // seeded. Give each one a thread so opening it lands in a chat, not on a
    // permanent "Opening a conversation…" placeholder.
    for (const bot of this.listBots()) {
      if (this.listThreads(bot.id, { includeArchived: true }).length === 0) {
        this.createThread(bot.id);
      }
    }
  }

  close(): void {
    if (this.db === undefined) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // :memory: and read-only mounts have no WAL to checkpoint.
    }
    this.db.close();
    this.db = undefined;
  }

  private handle(): DatabaseSync {
    if (this.db === undefined) {
      throw new Error('BotStore is not open; call open() first');
    }
    return this.db;
  }

  // ---------------------------------------------------------------- bots

  listBots(): BotRecord[] {
    const rows = this.handle()
      .prepare('SELECT * FROM bots ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToBot);
  }

  getBot(id: string): BotRecord | undefined {
    const row = this.handle().prepare('SELECT * FROM bots WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToBot(row);
  }

  countBots(): number {
    const row = this.handle().prepare('SELECT COUNT(*) AS n FROM bots').get() as
      | Record<string, unknown>
      | undefined;
    return Number(row?.['n'] ?? 0);
  }

  createBot(input: CreateBotInput): BotRecord {
    if (this.countBots() >= MAX_BOTS) {
      throw new Error(`Bot limit reached (${String(MAX_BOTS)})`);
    }
    const now = this.now();
    const id = `bot_${randomUUID()}`;
    this.handle()
      .prepare(
        `INSERT INTO bots (id, name, title, role_prompt, avatar_seed, workspace, model, thinking,
          permission, tool_policy_json, paused, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
      )
      .run(
        id,
        input.name,
        input.title ?? '',
        input.rolePrompt ?? '',
        input.name.slice(0, 2).toLowerCase() || 'bt',
        input.workspace,
        input.model ?? null,
        input.thinking ?? null,
        input.permission ?? 'bot',
        JSON.stringify(input.toolPolicy ?? {}),
        now,
      );
    return this.requireBot(id);
  }

  updateBot(id: string, patch: UpdateBotInput): BotRecord | undefined {
    const current = this.getBot(id);
    if (current === undefined) return undefined;
    const next = {
      name: patch.name ?? current.name,
      title: patch.title ?? current.title,
      workspace: patch.workspace ?? current.workspace,
      rolePrompt: patch.rolePrompt ?? current.rolePrompt,
      model: patch.model ?? current.model,
      thinking: patch.thinking ?? current.thinking,
      permission: patch.permission ?? current.permission,
      toolPolicy: patch.toolPolicy ?? current.toolPolicy,
      paused: patch.paused ?? current.paused,
      avatarEmoji: patch.avatarEmoji === undefined ? current.avatarEmoji : patch.avatarEmoji,
      accentHue: patch.accentHue === undefined ? current.accentHue : patch.accentHue,
    };
    const configChanged =
      patch.name !== undefined ||
      patch.title !== undefined ||
      patch.workspace !== undefined ||
      patch.rolePrompt !== undefined ||
      patch.model !== undefined ||
      patch.thinking !== undefined ||
      patch.permission !== undefined ||
      patch.toolPolicy !== undefined;
    this.handle()
      .prepare(
        `UPDATE bots SET name = ?, title = ?, role_prompt = ?, model = ?, thinking = ?,
          permission = ?, tool_policy_json = ?, paused = ?, workspace = ?,
          avatar_emoji = ?, accent_hue = ?,
          config_revision = config_revision + ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.title,
        next.rolePrompt,
        next.model,
        next.thinking,
        next.permission,
        JSON.stringify(next.toolPolicy),
        next.paused ? 1 : 0,
        next.workspace,
        next.avatarEmoji,
        next.accentHue,
        configChanged ? 1 : 0,
        id,
      );
    return this.getBot(id);
  }

  setBotPaused(id: string, paused: boolean): BotRecord | undefined {
    return this.updateBot(id, { paused });
  }

  /** Delete a bot and its threads/runs/inbox rows. Returns false when unknown. */
  deleteBot(id: string): boolean {
    const threadIds = this.listThreads(id, { includeArchived: true, scope: 'all' }).map(
      (thread) => thread.id,
    );
    const db = this.handle();
    db.exec('BEGIN');
    try {
      for (const threadId of threadIds) {
        db.prepare('DELETE FROM approvals WHERE thread_id = ?').run(threadId);
        db.prepare('DELETE FROM questions WHERE thread_id = ?').run(threadId);
        db.prepare('DELETE FROM runs WHERE thread_id = ?').run(threadId);
        db.prepare('DELETE FROM handoffs WHERE from_thread_id = ? OR to_thread_id = ?').run(
          threadId,
          threadId,
        );
      }
      db.prepare('DELETE FROM approvals WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM questions WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM runs WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM handoffs WHERE from_bot_id = ? OR to_bot_id = ?').run(id, id);
      db.prepare('UPDATE rooms SET lead_bot_id = NULL WHERE lead_bot_id = ?').run(id);
      db.prepare('DELETE FROM room_threads WHERE bot_id = ? OR core_session_id IN (SELECT id FROM threads WHERE bot_id = ?)').run(id, id);
      db.prepare('DELETE FROM room_members WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM threads WHERE bot_id = ?').run(id);
      const result = db.prepare('DELETE FROM bots WHERE id = ?').run(id);
      db.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  touchBot(id: string, at: number = this.now()): void {
    this.handle().prepare('UPDATE bots SET last_active_at = ? WHERE id = ?').run(at, id);
  }

  // -------------------------------------------------------------- threads

  /**
   * A Bot's threads, scoped to what the caller is allowed to see.
   *
   * `direct` is the safe default: threads opened on behalf of a room are that room's
   * conversation, not the Bot's 1:1 history, and must never show up in a single-chat list.
   * Internal paths that need every session (cleanup, recovery) ask for `all` explicitly.
   */
  listThreads(
    botId: string,
    options: { readonly includeArchived?: boolean; readonly scope?: 'direct' | 'all' } = {},
  ): ThreadRecord[] {
    const includeArchived = options.includeArchived === true;
    const scope = options.scope ?? 'direct';
    const archived = includeArchived ? '' : ' AND archived_at IS NULL';
    const roomFilter =
      scope === 'all'
        ? ''
        : ' AND id NOT IN (SELECT core_session_id FROM room_threads)';
    const rows = this.handle()
      .prepare(
        `SELECT * FROM threads WHERE bot_id = ?${archived}${roomFilter}
         ORDER BY last_active_at DESC`,
      )
      .all(botId) as Record<string, unknown>[];
    return rows.map(rowToThread);
  }

  getThread(id: string): ThreadRecord | undefined {
    const row = this.handle().prepare('SELECT * FROM threads WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToThread(row);
  }

  /** Reverse lookup used by in-band tool calls, which only carry a session id. */
  getThreadByCoreSessionId(coreSessionId: string): ThreadRecord | undefined {
    const row = this.handle()
      .prepare('SELECT * FROM threads WHERE core_session_id = ? ORDER BY created_at LIMIT 1')
      .get(coreSessionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToThread(row);
  }

  createThread(botId: string, input: CreateThreadInput & { readonly handoffDepth?: number } = {}): ThreadRecord {
    const now = this.now();
    const id = `th_${randomUUID()}`;
    this.handle()
      .prepare(
        `INSERT INTO threads (id, bot_id, core_session_id, title, last_active_at, archived_at,
          handoff_depth, unread, created_at, pinned_role)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, 0, ?, 0)`,
      )
      .run(id, botId, input.title ?? '', now, input.handoffDepth ?? 0, now);
    this.handle().prepare('UPDATE threads SET workspace=(SELECT workspace FROM bots WHERE id=?) WHERE id=?').run(botId, id);
    this.touchBot(botId, now);
    return this.requireThread(id);
  }

  updateThread(
    id: string,
    patch: {
      readonly title?: string;
      readonly coreSessionId?: string | null;
      readonly archivedAt?: number | null;
      readonly unread?: number;
      readonly handoffDepth?: number;
    },
  ): ThreadRecord | undefined {
    const current = this.getThread(id);
    if (current === undefined) return undefined;
    this.handle()
      .prepare(
        `UPDATE threads SET title = ?, core_session_id = ?, archived_at = ?, unread = ?,
          handoff_depth = ? WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.coreSessionId === undefined ? current.coreSessionId : patch.coreSessionId,
        patch.archivedAt === undefined ? current.archivedAt : patch.archivedAt,
        patch.unread ?? current.unread,
        patch.handoffDepth ?? current.handoffDepth,
        id,
      );
    return this.getThread(id);
  }

  touchThread(id: string, at: number = this.now()): void {
    this.handle().prepare('UPDATE threads SET last_active_at = ? WHERE id = ?').run(at, id);
  }

  markThreadUnread(id: string, unread: boolean): void {
    this.handle().prepare('UPDATE threads SET unread = ? WHERE id = ?').run(unread ? 1 : 0, id);
  }

  deleteThread(id: string): boolean {
    const db = this.handle();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM approvals WHERE thread_id = ?').run(id);
      db.prepare('DELETE FROM questions WHERE thread_id = ?').run(id);
      db.prepare('DELETE FROM runs WHERE thread_id = ?').run(id);
      db.prepare('DELETE FROM handoffs WHERE from_thread_id = ? OR to_thread_id = ?').run(id, id);
      const result = db.prepare('DELETE FROM threads WHERE id = ?').run(id);
      db.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // ----------------------------------------------------------------- rooms

  createRoom(input: {
    readonly name: string;
    readonly memberIds: readonly string[];
    readonly leadBotId?: string | undefined;
  }): RoomRecord {
    const id = `room_${randomUUID()}`;
    const now = this.now();
    const db = this.handle();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO rooms (id, name, lead_bot_id, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        input.name,
        input.leadBotId ?? null,
        now,
      );
      for (const botId of input.memberIds) {
        db.prepare(
          'INSERT OR IGNORE INTO room_members (room_id, bot_id, joined_at) VALUES (?, ?, ?)',
        ).run(id, botId, now);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return this.requireRoom(id);
  }

  getRoom(id: string): RoomRecord | undefined {
    const row = this.handle().prepare('SELECT * FROM rooms WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.roomFromRow(row);
  }

  requireRoom(id: string): RoomRecord {
    const room = this.getRoom(id);
    if (room === undefined) throw new Error(`Unknown room: ${id}`);
    return room;
  }

  listRooms(): RoomRecord[] {
    const rows = this.handle()
      .prepare('SELECT * FROM rooms ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.roomFromRow(row));
  }

  private roomFromRow(row: Record<string, unknown>): RoomRecord {
    const id = String(row['id']);
    const members = this.handle()
      .prepare('SELECT bot_id FROM room_members WHERE room_id = ? ORDER BY joined_at')
      .all(id) as Record<string, unknown>[];
    return {
      id,
      name: String(row['name']),
      leadBotId: toStringOrNull(row['lead_bot_id']),
      memberIds: members.map((member) => String(member['bot_id'])),
      createdAt: Number(row['created_at']),
    };
  }

  appendRoomMessage(input: {
    readonly roomId: string;
    readonly speakerKind: 'user' | 'bot' | 'system';
    readonly speakerId: string;
    readonly content: string;
    readonly via?: 'direct' | 'handoff';
    readonly answeredBy?: string | null;
    readonly sourceMessageId?: string | null;
    readonly roomRequestId?: string | null;
    readonly runId?: string | null;
    readonly attachments?: readonly Attachment[];
  }): RoomMessageRecord {
    const id = `rm_${randomUUID()}`;
    const now = this.now();
    const via = input.via ?? 'direct';
    const answeredBy = input.answeredBy ?? null;
    const sourceMessageId = input.sourceMessageId ?? null;
    const insert = (): void => {
      this.handle()
        .prepare(
          `INSERT INTO room_messages (id, room_id, speaker_kind, speaker_id, content, via,
            answered_by, source_message_id, created_at, room_request_id, run_id, attachments_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.roomId,
          input.speakerKind,
          input.speakerId,
          input.content,
          via,
          answeredBy,
          sourceMessageId,
          now,
          input.roomRequestId ?? null,
          input.runId ?? null,
          input.attachments === undefined || input.attachments.length === 0
            ? null
            : JSON.stringify(input.attachments),
        );
    };
    if (sourceMessageId !== null) {
      // The unique index settles the race; a replay lands here instead.
      const existing = this.findRoomMessage(input.roomId, input.speakerId, sourceMessageId);
      if (existing !== undefined) return existing;
    }
    try {
      insert();
    } catch (error) {
      if (sourceMessageId === null) throw error;
      const existing = this.findRoomMessage(input.roomId, input.speakerId, sourceMessageId);
      if (existing === undefined) throw error;
      return existing;
    }
    return {
      id,
      roomId: input.roomId,
      speakerKind: input.speakerKind,
      speakerId: input.speakerId,
      content: input.content,
      via,
      answeredBy,
      runId: input.runId ?? null,
      roomRequestId: input.roomRequestId ?? null,
      createdAt: now,
      ...(input.attachments === undefined || input.attachments.length === 0
        ? {}
        : { attachments: input.attachments }),
    };
  }

  private findRoomMessage(
    roomId: string,
    speakerId: string,
    sourceMessageId: string,
  ): RoomMessageRecord | undefined {
    const row = this.handle()
      .prepare(
        'SELECT * FROM room_messages WHERE room_id = ? AND speaker_id = ? AND source_message_id = ?',
      )
      .get(roomId, speakerId, sourceMessageId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToRoomMessage(row);
  }

  listRoomMessages(roomId: string): RoomMessageRecord[] {
    const rows = this.handle()
      .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at, id')
      .all(roomId) as Record<string, unknown>[];
    return rows.map(rowToRoomMessage);
  }

  /** Room id for every thread a room owns. */
  roomThreadMap(): Map<string, string> {
    const rows = this.handle()
      .prepare('SELECT room_id, core_session_id FROM room_threads')
      .all() as Record<string, unknown>[];
    return new Map(rows.map((row) => [String(row['core_session_id']), String(row['room_id'])]));
  }

  getRoomThread(roomId: string, botId: string): string | undefined {
    const row = this.handle()
      .prepare('SELECT core_session_id FROM room_threads WHERE room_id = ? AND bot_id = ?')
      .get(roomId, botId) as Record<string, unknown> | undefined;
    const threadId = row?.['core_session_id'];
    return typeof threadId === 'string' ? threadId : undefined;
  }

  /** Newest message across a Bot's 1:1 history, for roster previews. */
  lastDirectMessage(botId: string): Message | undefined {
    const row = this.handle()
      .prepare(
        `SELECT message_json FROM thread_messages
         WHERE thread_id IN (
           SELECT id FROM threads WHERE bot_id = ? AND archived_at IS NULL
             AND id NOT IN (SELECT core_session_id FROM room_threads)
         )
         ORDER BY COALESCE(json_extract(message_json, '$.createdAt'), 0) DESC, rowid DESC
         LIMIT 1`,
      )
      .get(botId) as Record<string, unknown> | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(String(row['message_json'])) as Message);
  }

  /** Newest message in a room, for roster previews. */
  lastRoomMessage(roomId: string): RoomMessageRecord | undefined {
    const row = this.handle()
      .prepare(
        'SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(roomId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToRoomMessage(row);
  }

  listRoomThreads(roomId: string): { botId: string; threadId: string }[] {
    const rows = this.handle()
      .prepare('SELECT bot_id, core_session_id FROM room_threads WHERE room_id = ?')
      .all(roomId) as Record<string, unknown>[];
    return rows.map((row) => ({ botId: String(row['bot_id']), threadId: String(row['core_session_id']) }));
  }

  getRoomThreadByThreadId(threadId: string): { roomId: string; botId: string } | undefined {
    const row = this.handle()
      .prepare('SELECT room_id, bot_id FROM room_threads WHERE core_session_id = ?')
      .get(threadId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return { roomId: String(row['room_id']), botId: String(row['bot_id']) };
  }

  setRoomThread(roomId: string, botId: string, threadId: string): void {
    this.handle()
      .prepare(
        `INSERT INTO room_threads (room_id, bot_id, core_session_id) VALUES (?, ?, ?)
         ON CONFLICT(room_id, bot_id) DO UPDATE SET core_session_id = excluded.core_session_id`,
      )
      .run(roomId, botId, threadId);
  }

  deleteRoom(id: string): string[] | undefined {
    if (this.getRoom(id) === undefined) return undefined;
    const threadRows = this.handle()
      .prepare('SELECT core_session_id FROM room_threads WHERE room_id = ?')
      .all(id) as Record<string, unknown>[];
    const db = this.handle();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM room_messages WHERE room_id = ?').run(id);
      db.prepare('DELETE FROM room_members WHERE room_id = ?').run(id);
      db.prepare('DELETE FROM room_threads WHERE room_id = ?').run(id);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return threadRows.map((row) => String(row['core_session_id']));
  }

  // ----------------------------------------------------------------- runs

  createRun(input: CreateRunInput): RunRecord {
    const id = `run_${randomUUID()}`;
    this.handle()
      .prepare(`INSERT INTO runs
        (id,bot_id,thread_id,status,parent_run_id,created_at,input_json,request_key,kind,origin_json,retry_of_run_id)
        VALUES(?,?,?,'queued',?,?,?,?,?,?,?)`)
      .run(
        id, input.botId, input.threadId, input.parentRunId ?? null, this.now(),
        input.text === undefined ? null : JSON.stringify({ text: input.text }),
        input.requestKey ?? null, input.kind ?? 'prompt',
        JSON.stringify(input.origin ?? { kind: 'user' }), input.retryOfRunId ?? null,
      );
    return this.requireRun(id);
  }

  transaction<T>(action: () => T): T {
    const db = this.handle();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  getAcceptedInput(key: string): { run: RunRecord; text: string; threadId: string } | undefined {
    const row = this.handle().prepare('SELECT * FROM run_inputs WHERE request_key=?').get(key);
    if (row === undefined) return undefined;
    return { run: this.requireRun(String(row['run_id'])), text: parseJson(row['input_json'], {text:''}).text, threadId: String(row['thread_id']) };
  }

  recordInput(key: string, runId: string, message: Message, kind: 'queue' | 'steer'): void {
    this.handle().prepare('INSERT INTO run_inputs VALUES(?,?,?,?,?,?)').run(key,runId,message.threadId,
      JSON.stringify({text:message.content}),message.id,kind);
    this.saveMessage(message, this.listMessages(message.threadId).length);
  }

  listQueuedRuns(): RunRecord[] {
    return (this.handle().prepare(`SELECT * FROM runs AS queued WHERE status='queued'
      ORDER BY COALESCE((SELECT created_at FROM runs AS original WHERE original.id=queued.retry_of_run_id),created_at),
        CASE WHEN retry_of_run_id IS NULL THEN 1 ELSE 0 END,rowid`).all() as Record<string, unknown>[]).map(rowToRun);
  }

  markDispatch(id: string, sessionId: string, generation: string): void {
    this.handle().prepare('UPDATE runs SET dispatch_started_at=?,core_session_id=?,session_generation=? WHERE id=?')
      .run(this.now(),sessionId,generation,id);
  }

  bindTurn(id: string, turnId: number): void {
    this.handle().prepare('UPDATE runs SET turn_id=? WHERE id=?').run(turnId,id);
  }

  blockThread(threadId: string, runId: string): void {
    this.handle().prepare('UPDATE threads SET blocked_by_run_id=COALESCE(blocked_by_run_id,?) WHERE id=?').run(runId,threadId);
  }

  recoverRun(id: string, decision: RecoveryDecision): { run: RunRecord; retry: RunRecord | undefined } {
    return this.transaction(() => {
      const run = this.requireRun(id);
      if (run.status !== 'interrupted') throw new Error('Only interrupted runs accept recovery decisions');
      if (run.recoveryDecision !== null) {
        if (run.recoveryDecision !== decision) throw new Error('Recovery decision already recorded');
        return { run, retry: run.recoveryRunId === null ? undefined : this.getRun(run.recoveryRunId) };
      }
      if (decision === 'retry' && run.input === null) throw new Error('Legacy or observed run has no replayable input');
      const retry = decision === 'retry' && run.input !== null ? this.createRun({ botId:run.botId,threadId:run.threadId,
        text:run.input.text,requestKey:`retry:${run.id}`,retryOfRunId:run.id }) : undefined;
      if (decision === 'cancel_queue') {
        this.handle().prepare("UPDATE runs SET status='cancelled',ended_at=? WHERE thread_id=? AND status='queued'").run(this.now(),run.threadId);
      }
      this.handle().prepare('UPDATE runs SET recovery_decision=?,recovery_at=?,recovery_run_id=? WHERE id=?').run(decision,this.now(),retry?.id ?? null,id);
      this.handle().prepare(`UPDATE threads SET blocked_by_run_id=(SELECT id FROM runs WHERE thread_id=? AND status='interrupted'
        AND recovery_decision IS NULL ORDER BY created_at,rowid LIMIT 1) WHERE id=?`).run(run.threadId,run.threadId);
      this.appendAudit({actor:'person',initiator:'person',action:'run.recovery',decision,botId:run.botId,threadId:run.threadId,payload:{runId:id,retryRunId:retry?.id ?? null}});
      return {run:this.requireRun(id),retry};
    });
  }

  listMessages(threadId: string): Message[] {
    return this.handle().prepare('SELECT message_json FROM thread_messages WHERE thread_id=? ORDER BY position,rowid').all(threadId)
      .map((row) => JSON.parse(String(row['message_json'])) as Message);
  }

  saveMessage(message: Message, position: number): void {
    this.handle().prepare(`INSERT INTO thread_messages(id,thread_id,core_session_id,core_message_id,run_id,position,message_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET core_session_id=excluded.core_session_id,
      core_message_id=excluded.core_message_id,message_json=excluded.message_json,position=excluded.position`)
      .run(message.id,message.threadId,message.coreSessionId ?? null,message.coreMessageId ?? null,message.runId ?? null,position,JSON.stringify(message));
  }

  saveProjection(threadId: string, messages: readonly Message[], version: number): void {
    this.transaction(() => {
      messages.forEach((message, index) => { this.saveMessage(message, index); });
      this.handle().prepare('UPDATE threads SET projection_version=? WHERE id=?').run(version,threadId);
    });
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.handle().prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToRun(row);
  }

  listRunsForThread(threadId: string, limit = 50): RunRecord[] {
    const rows = this.handle()
      .prepare('SELECT rowid AS row_id, * FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(threadId, limit) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  /**
   * Newest-first runs, optionally scoped to a Bot and/or thread. Called with no
   * filters it is the Activity feed; `runIds` are stable across restarts.
   */
  listRuns(options: {
    readonly botId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly limit?: number | undefined;
  } = {}): RunRecord[] {
    const requested = options.limit ?? 50;
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), 200)
      : 50;
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.botId !== undefined) {
      clauses.push('bot_id = ?');
      params.push(options.botId);
    }
    if (options.threadId !== undefined) {
      clauses.push('thread_id = ?');
      params.push(options.threadId);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.handle()
      .prepare(
        `SELECT rowid AS row_id, * FROM runs${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  updateRunStatus(
    id: string,
    status: RunStatus,
    patch: { readonly error?: string | null } = {},
  ): RunRecord | undefined {
    const current = this.getRun(id);
    if (current === undefined) return undefined;
    const now = this.now();
    const startedAt =
      current.startedAt ?? (status === 'running' ? now : null);
    const terminal = status === 'done' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
    const endedAt = terminal ? (current.endedAt ?? now) : null;
    const error = patch.error === undefined ? current.error : patch.error;
    this.handle()
      .prepare('UPDATE runs SET status = ?, started_at = ?, ended_at = ?, error = ? WHERE id = ?')
      .run(status, startedAt, endedAt, error, id);
    return this.getRun(id);
  }

  activeRunForThread(threadId: string): RunRecord | undefined {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
    const row = this.handle()
      .prepare(
        `SELECT rowid AS row_id, * FROM runs WHERE thread_id = ? AND status IN (${placeholders})
         ORDER BY CASE WHEN status='queued' THEN 1 ELSE 0 END, created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId, ...ACTIVE_RUN_STATUSES) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToRun(row);
  }

  /** Startup recovery: a fresh process cannot continue a dead turn. */
  markOrphanRuns(reason = 'server restarted; execution outcome unknown'): number {
    return this.transaction(() => {
      const rows = this.handle().prepare(`SELECT * FROM runs WHERE status IN ('queued','running','waiting_user')
        AND (status!='queued' OR input_json IS NULL OR dispatch_started_at IS NOT NULL OR kind='observed') ORDER BY created_at,rowid`).all();
      for (const row of rows) {
        const run = rowToRun(row);
        this.updateRunStatus(run.id,'interrupted',{error:reason});
        this.blockThread(run.threadId,run.id);
      }
      this.handle().prepare(`UPDATE handoffs SET status='failed',error='interrupted during restart; confirmation required',completed_at=?
        WHERE status IN ('queued','running')`).run(this.now());
      return rows.length;
    });
  }

  // ------------------------------------------------------------- handoffs

  /**
   * Queue a hand-off. `idempotencyKey` is unique, so a replayed tool call lands
   * on the existing row instead of executing the same task twice.
   */
  createHandoff(input: CreateHandoffInput): { handoff: HandoffRecord; created: boolean } {
    const existing = this.getHandoffByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) return { handoff: existing, created: false };
    const id = `ho_${randomUUID()}`;
    const now = this.now();
    try {
      this.handle()
        .prepare(
          `INSERT INTO handoffs (id, from_bot_id, from_thread_id, to_bot_id, to_thread_id,
            parent_run_id, depth, task, constraints, expecting, status, error, answer,
            completed_at, idempotency_key, lease_owner, lease_until, attempts, next_attempt_at,
            created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, NULL, NULL, 0,
            NULL, ?)`,        )
        .run(
          id,
          input.fromBotId,
          input.fromThreadId,
          input.toBotId,
          input.toThreadId,
          input.parentRunId,
          input.depth,
          input.task,
          input.constraints,
          input.expecting,
          input.idempotencyKey,
          now,
        );
    } catch (error) {
      // A concurrent replay wins the insert; the unique index settles the race.
      const raced = this.getHandoffByIdempotencyKey(input.idempotencyKey);
      if (raced === undefined) throw error;
      return { handoff: raced, created: false };
    }
    return { handoff: this.requireHandoff(id), created: true };
  }

  getHandoff(id: string): HandoffRecord | undefined {
    const row = this.handle().prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToHandoff(row);
  }

  /** Lookup behind the idempotency check performed before a queued row exists. */
  getHandoffByIdempotencyKey(key: string): HandoffRecord | undefined {
    const row = this.handle()
      .prepare('SELECT * FROM handoffs WHERE idempotency_key = ?')
      .get(key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToHandoff(row);
  }

  /** Newest-first; `botId` matches either side of the hand-off. */
  listHandoffs(options: {
    readonly botId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly limit?: number | undefined;
  } = {}): HandoffRecord[] {
    const requested = options.limit ?? 50;
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), 200)
      : 50;
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.botId !== undefined) {
      clauses.push('(from_bot_id = ? OR to_bot_id = ?)');
      params.push(options.botId, options.botId);
    }
    if (options.threadId !== undefined) {
      clauses.push('(from_thread_id = ? OR to_thread_id = ?)');
      params.push(options.threadId, options.threadId);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.handle()
      .prepare(
        `SELECT rowid AS row_id, * FROM handoffs${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToHandoff);
  }

  /** How many hand-offs the current run already made; the per-run cap reads this. */
  countHandoffsForRun(runId: string): number {
    const row = this.handle()
      .prepare('SELECT COUNT(*) AS n FROM handoffs WHERE parent_run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  listPendingHandoffsForThread(toThreadId: string): HandoffRecord[] {
    const rows = this.handle()
      .prepare(
        `SELECT * FROM handoffs WHERE to_thread_id = ? AND status IN ('queued', 'running')
         ORDER BY created_at, rowid`,
      )
      .all(toThreadId) as Record<string, unknown>[];
    return rows.map(rowToHandoff);
  }

  completeHandoff(
    id: string,
    input: { readonly answer: string; readonly toThreadId?: string | null | undefined },
  ): HandoffRecord | undefined {
    this.handle()
      .prepare(
        `UPDATE handoffs SET status = 'delivered', answer = ?, error = NULL, completed_at = ?,
          to_thread_id = COALESCE(?, to_thread_id) WHERE id = ?`,
      )
      .run(input.answer, this.now(), input.toThreadId ?? null, id);
    return this.getHandoff(id);
  }

  failHandoff(id: string, error: string): HandoffRecord | undefined {
    this.handle()
      .prepare("UPDATE handoffs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
      .run(error, this.now(), id);
    return this.getHandoff(id);
  }

  /** Attach the concrete target run created for this hand-off. */
  setHandoffTargetRun(id: string, runId: string): void {
    this.handle()
      .prepare("UPDATE handoffs SET target_run_id = ?, status = 'running' WHERE id = ?")
      .run(runId, id);
  }

  /** Pending hand-offs owned by one target run — never by the whole thread. */
  listPendingHandoffsForRun(targetRunId: string): HandoffRecord[] {
    const rows = this.handle()
      .prepare(
        `SELECT * FROM handoffs WHERE target_run_id = ? AND status IN ('queued', 'running')
         ORDER BY created_at, rowid`,
      )
      .all(targetRunId) as Record<string, unknown>[];
    return rows.map(rowToHandoff);
  }

  /** Target finished: keep the answer, but delivery waits for the relay run. */
  markHandoffAwaitingRelay(id: string, answer: string): HandoffRecord | undefined {
    this.handle()
      .prepare(
        `UPDATE handoffs SET status = 'awaiting_relay', answer = ?, error = NULL,
          completed_at = ?, relay_status = 'pending', relay_run_id = NULL WHERE id = ?`,
      )
      .run(answer, this.now(), id);
    return this.getHandoff(id);
  }

  /** Failure is also relayed, so the source conversation learns why. */
  markHandoffFailedPendingRelay(id: string, error: string): HandoffRecord | undefined {
    this.handle()
      .prepare(
        `UPDATE handoffs SET status = 'failed', error = ?, completed_at = ?,
          relay_status = 'pending', relay_run_id = NULL WHERE id = ?`,
      )
      .run(error, this.now(), id);
    return this.getHandoff(id);
  }

  setThreadAppliedRevision(threadId: string, revision: number): void {
    this.handle()
      .prepare('UPDATE threads SET applied_config_revision = ? WHERE id = ?')
      .run(revision, threadId);
  }

  setRoomMessageRun(id: string, runId: string): void {
    this.handle().prepare('UPDATE room_messages SET run_id = ? WHERE id = ?').run(runId, id);
  }

  findRoomMessageByRequest(roomId: string, requestId: string): RoomMessageRecord | undefined {
    const row = this.handle()
      .prepare('SELECT * FROM room_messages WHERE room_id = ? AND room_request_id = ?')
      .get(roomId, requestId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToRoomMessage(row);
  }

  /** Recent room transcript used as shared context for whichever Bot is addressed. */
  roomTranscript(roomId: string, limit = 40, maxChars = 12_000): string {
    const rows = this.handle()
      .prepare(
        `SELECT speaker_kind, speaker_id, content FROM room_messages
         WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(roomId, limit) as Record<string, unknown>[];
    const lines: string[] = [];
    let used = 0;
    for (const row of rows.toReversed()) {
      const kind = String(row['speaker_kind']);
      const speakerId = String(row['speaker_id']);
      const name =
        kind === 'bot' ? (this.getBot(speakerId)?.name ?? speakerId) : kind === 'system' ? 'system' : 'person';
      const line = `${name}: ${String(row['content'])}`;
      if (used + line.length > maxChars) break;
      used += line.length;
      lines.push(line);
    }
    return lines.join('\n');
  }

  markHandoffRelayFailed(relayRunId: string, error: string): HandoffRecord | undefined {
    const handoff = this.getHandoffByRelayRun(relayRunId);
    if (handoff === undefined) return undefined;
    this.handle()
      .prepare(
        `UPDATE handoffs SET relay_status = 'failed', relay_run_id = NULL, error = ?
         WHERE relay_run_id = ?`,
      )
      .run(error, relayRunId);
    return this.getHandoff(handoff.id);
  }

  listRelayableHandoffs(): HandoffRecord[] {
    const rows = this.handle()
      .prepare(
        `SELECT * FROM handoffs WHERE relay_status = 'pending' AND relay_run_id IS NULL
         AND status IN ('awaiting_relay', 'failed') ORDER BY completed_at, rowid`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToHandoff);
  }

  claimHandoffRelay(id: string, relayRunId: string): void {
    this.handle()
      .prepare("UPDATE handoffs SET relay_run_id = ?, relay_status = 'claimed' WHERE id = ?")
      .run(relayRunId, id);
  }

  /** The relayed answer has actually landed in the source conversation. */
  /** The relayed answer has actually landed in the source conversation. */
  getHandoffByRelayRun(relayRunId: string): HandoffRecord | undefined {
    const row = this.handle()
      .prepare('SELECT * FROM handoffs WHERE relay_run_id = ?')
      .get(relayRunId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToHandoff(row);
  }

  completeHandoffRelay(relayRunId: string): HandoffRecord | undefined {
    const row = this.handle()
      .prepare('SELECT * FROM handoffs WHERE relay_run_id = ?')
      .get(relayRunId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const id = String(row['id']);
    // A relayed failure stays a failure; only the delivery leg is complete.
    const status = row['status'] === 'failed' ? 'failed' : 'delivered';
    this.handle()
      .prepare('UPDATE handoffs SET status = ?, relay_status = ? WHERE id = ?')
      .run(status, 'delivered', id);
    return this.getHandoff(id);
  }

  // ------------------------------------------------------------ approvals

  createApproval(input: CreateApprovalInput): ApprovalRecord {
    const id = `apr_${randomUUID()}`;
    this.handle()
      .prepare(
        `INSERT INTO approvals (id, bot_id, thread_id, run_id, request_id, tool_name, action,
          reasons_json, grant_options_json, status, decision, feedback, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.threadId,
        input.runId,
        input.requestId,
        input.toolName,
        input.action,
        JSON.stringify(input.reasons),
        JSON.stringify(input.grantOptions),
        this.now(),
        input.expiresAt,
      );
    return this.requireApproval(id);
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.handle().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToApproval(row);
  }

  listApprovals(options: { readonly botId?: string; readonly pendingOnly?: boolean } = {}): ApprovalRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.botId !== undefined) {
      clauses.push('bot_id = ?');
      params.push(options.botId);
    }
    if (options.pendingOnly === true) {
      clauses.push("status = 'pending'");
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.handle()
      .prepare(`SELECT * FROM approvals${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToApproval);
  }

  decideApproval(
    id: string,
    decision: ApprovalDecision,
    feedback: string | null = null,
  ): ApprovalRecord | undefined {
    const status: ApprovalStatus =
      decision === 'deny' ? 'denied' : 'approved';
    this.handle()
      .prepare("UPDATE approvals SET status = ?, decision = ?, feedback = ? WHERE id = ? AND status = 'pending'")
      .run(status, decision, feedback, id);
    return this.getApproval(id);
  }

  expireApproval(id: string): ApprovalRecord | undefined {
    this.handle()
      .prepare("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(id);
    return this.getApproval(id);
  }

  expireStaleApprovals(now: number = this.now()): number {
    const result = this.handle()
      .prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }

  expirePendingApprovalsForThread(threadId: string): number {
    const result = this.handle()
      .prepare("UPDATE approvals SET status = 'expired' WHERE thread_id = ? AND status = 'pending'")
      .run(threadId);
    return Number(result.changes);
  }

  // ------------------------------------------------------------ questions

  createQuestion(input: CreateQuestionInput): QuestionRecord {
    const id = `q_${randomUUID()}`;
    this.handle()
      .prepare(
        `INSERT INTO questions (id, bot_id, thread_id, run_id, request_id, items_json, answers_json,
          status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.threadId,
        input.runId,
        input.requestId,
        JSON.stringify(input.items),
        this.now(),
        input.expiresAt,
      );
    return this.requireQuestion(id);
  }

  getQuestion(id: string): QuestionRecord | undefined {
    const row = this.handle().prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToQuestion(row);
  }

  listQuestions(options: { readonly botId?: string; readonly pendingOnly?: boolean } = {}): QuestionRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.botId !== undefined) {
      clauses.push('bot_id = ?');
      params.push(options.botId);
    }
    if (options.pendingOnly === true) {
      clauses.push("status = 'pending'");
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.handle()
      .prepare(`SELECT * FROM questions${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToQuestion);
  }

  answerQuestion(
    id: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): QuestionRecord | undefined {
    this.handle()
      .prepare("UPDATE questions SET status = 'answered', answers_json = ? WHERE id = ? AND status = 'pending'")
      .run(JSON.stringify(answers), id);
    return this.getQuestion(id);
  }

  expireQuestion(id: string): QuestionRecord | undefined {
    this.handle()
      .prepare("UPDATE questions SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(id);
    return this.getQuestion(id);
  }

  expireStaleQuestions(now: number = this.now()): number {
    const result = this.handle()
      .prepare("UPDATE questions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }

  expirePendingQuestionsForThread(threadId: string): number {
    const result = this.handle()
      .prepare("UPDATE questions SET status = 'expired' WHERE thread_id = ? AND status = 'pending'")
      .run(threadId);
    return Number(result.changes);
  }

  // -------------------------------------------------------------- counters

  counters(): Map<string, BotCounters> {
    const out = new Map<string, { unread: number; needsYou: number }>();
    const ensure = (botId: string): { unread: number; needsYou: number } => {
      let entry = out.get(botId);
      if (entry === undefined) {
        entry = { unread: 0, needsYou: 0 };
        out.set(botId, entry);
      }
      return entry;
    };
    const unreadRows = this.handle()
      .prepare(
        `SELECT bot_id, SUM(CASE WHEN id IN (SELECT core_session_id FROM room_threads)
           THEN 0 ELSE unread END) AS n FROM threads GROUP BY bot_id`,
      )
      .all() as Record<string, unknown>[];
    for (const row of unreadRows) {
      ensure(String(row['bot_id'])).unread = Number(row['n'] ?? 0);
    }
    const approvalRows = this.handle()
      .prepare("SELECT bot_id, COUNT(*) AS n FROM approvals WHERE status = 'pending' GROUP BY bot_id")
      .all() as Record<string, unknown>[];
    for (const row of approvalRows) {
      ensure(String(row['bot_id'])).needsYou += Number(row['n'] ?? 0);
    }
    const questionRows = this.handle()
      .prepare("SELECT bot_id, COUNT(*) AS n FROM questions WHERE status = 'pending' GROUP BY bot_id")
      .all() as Record<string, unknown>[];
    for (const row of questionRows) {
      ensure(String(row['bot_id'])).needsYou += Number(row['n'] ?? 0);
    }
    return out;
  }

  /** Status derived from lifecycle + live inbox; never persisted. */
  statusForBot(bot: BotRecord, counters: BotCounters): BotStatus {
    if (bot.paused) return 'paused';
    if (counters.needsYou > 0) return 'needs_you';
    const row = this.handle()
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE bot_id = ? AND status IN ('running', 'waiting_user', 'queued')",
      )
      .get(bot.id) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0) > 0 ? 'working' : 'idle';
  }

  // ---------------------------------------------------------------- audit

  appendAudit(input: AppendAuditInput): AuditEntry {
    const now = this.now();
    const result = this.handle()
      .prepare(
        `INSERT INTO audit (actor, initiator, action, decision, bot_id, thread_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.actor,
        input.initiator,
        input.action,
        input.decision ?? null,
        input.botId ?? null,
        input.threadId ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        now,
      );
    return {
      id: Number(result.lastInsertRowid),
      actor: input.actor,
      initiator: input.initiator,
      action: input.action,
      decision: input.decision ?? null,
      botId: input.botId ?? null,
      threadId: input.threadId ?? null,
      payload:input.payload ?? null,
      createdAt: now,
    };
  }

  listAudit(options: { readonly botId?: string; readonly limit?: number } = {}): AuditEntry[] {
    const limit = options.limit ?? 100;
    const rows = (
      options.botId === undefined
        ? this.handle().prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
        : this.handle()
            .prepare('SELECT * FROM audit WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
            .all(options.botId, limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row['id']),
      actor: String(row['actor']),
      initiator: String(row['initiator']) as AuditEntry['initiator'],
      action: String(row['action']),
      decision: toStringOrNull(row['decision']),
      botId: toStringOrNull(row['bot_id']),
      threadId: toStringOrNull(row['thread_id']),
      payload:parseJson(row['payload_json'],null),
      createdAt: Number(row['created_at']),
    }));
  }

  // --------------------------------------------------------------- helpers

  private requireBot(id: string): BotRecord {
    const bot = this.getBot(id);
    if (bot === undefined) throw new Error(`Bot not found: ${id}`);
    return bot;
  }

  private requireThread(id: string): ThreadRecord {
    const thread = this.getThread(id);
    if (thread === undefined) throw new Error(`Thread not found: ${id}`);
    return thread;
  }

  private requireRun(id: string): RunRecord {
    const run = this.getRun(id);
    if (run === undefined) throw new Error(`Run not found: ${id}`);
    return run;
  }

  private requireApproval(id: string): ApprovalRecord {
    const approval = this.getApproval(id);
    if (approval === undefined) throw new Error(`Approval not found: ${id}`);
    return approval;
  }

  private requireQuestion(id: string): QuestionRecord {
    const question = this.getQuestion(id);
    if (question === undefined) throw new Error(`Question not found: ${id}`);
    return question;
  }

  private requireHandoff(id: string): HandoffRecord {
    const handoff = this.getHandoff(id);
    if (handoff === undefined) throw new Error(`Handoff not found: ${id}`);
    return handoff;
  }
}
