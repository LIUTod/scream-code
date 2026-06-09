import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'pathe';

import { z } from 'zod';

import { ErrorCodes, ScreamError } from '#/errors';
import type { SessionIndexEntry } from '#/session/store/session-index';
import {
  appendSessionIndexEntry,
  readSessionIndex,
  removeSessionIndexEntry,
} from '#/session/store/session-index';
import { encodeWorkDirKey, normalizeWorkDir } from '#/session/store/workdir-key';
import type { JsonObject, JsonValue, ListSessionsPayload, SessionSummary } from '#/rpc/core-api';

const SessionSummaryStateSchema = z.object({
  customTitle: z.string().optional(),
  isCustomTitle: z.boolean().optional(),
  lastPrompt: z.string().optional(),
  title: z.string().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

type SessionSummaryState = z.infer<typeof SessionSummaryStateSchema>;

// ── cc-connect session file schema ────────────────────────────────────

const CcConnectHistoryEntrySchema = z.object({
  role: z.string(),
  content: z.string(),
  timestamp: z.string().optional(),
});

const CcConnectSessionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  agent_session_id: z.string().optional(),
  agent_type: z.string().optional(),
  history: z.array(CcConnectHistoryEntrySchema).nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

const CcConnectSnapshotSchema = z.object({
  sessions: z.record(z.string(), CcConnectSessionSchema).optional(),
  active_session: z.record(z.string(), z.string()).optional(),
  version: z.number().optional(),
});

type CcConnectSession = z.infer<typeof CcConnectSessionSchema>;

export interface CreateSessionRecordInput {
  readonly id: string;
  readonly workDir: string;
}

export interface ForkSessionRecordInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
}

export type SessionStoreOptions = Record<string, never>;

export class SessionStore {
  readonly sessionsDir: string;

  constructor(
    readonly homeDir: string,
    _options: SessionStoreOptions = {},
  ) {
    this.sessionsDir = join(homeDir, 'sessions');
  }

  sessionDirFor(input: { readonly id: string; readonly workDir: string }): string {
    assertSafeSessionId(input.id);
    return join(this.sessionsDir, encodeWorkDirKey(normalizeWorkDir(input.workDir)), input.id);
  }

  async create(input: CreateSessionRecordInput): Promise<SessionSummary> {
    assertSafeSessionId(input.id);
    const workDir = normalizeWorkDir(input.workDir);
    const dir = this.sessionDirFor({ id: input.id, workDir });

    const indexed = await this.findSessionEntry(input.id);
    if (indexed !== undefined) {
      await this.delete(input.id);
    } else if (await isDirectory(dir)) {
      // Directory exists but no index entry — orphaned from partial delete.
      await rm(dir, { recursive: true, force: true });
    }

    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendSessionIndexEntry(this.homeDir, {
      sessionId: input.id,
      sessionDir: dir,
      workDir,
    });
    return this.summaryFromDir(input.id, dir, workDir);
  }

  async fork(input: ForkSessionRecordInput): Promise<SessionSummary> {
    const source = await this.findExistingSessionEntry(input.sourceId);
    assertSafeSessionId(input.targetId);
    const indexed = await this.findSessionEntry(input.targetId);
    if (indexed !== undefined) {
      throw new ScreamError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.targetId}" already exists`);
    }

    const targetDir = this.sessionDirFor({ id: input.targetId, workDir: source.workDir });
    if (await isDirectory(targetDir)) {
      throw new ScreamError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.targetId}" already exists`);
    }

    await mkdir(dirname(targetDir), { recursive: true, mode: 0o700 });
    try {
      await cp(source.sessionDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await this.writeForkedState(input, source.sessionDir, targetDir);
      const summary = await this.summaryFromDir(input.targetId, targetDir, source.workDir);
      await appendSessionIndexEntry(this.homeDir, {
        sessionId: input.targetId,
        sessionDir: targetDir,
        workDir: source.workDir,
      });
      return summary;
    } catch (error) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async get(id: string): Promise<SessionSummary> {
    const entry = await this.findExistingSessionEntry(id);
    return this.summaryFromDir(id, entry.sessionDir, entry.workDir);
  }

  async rename(id: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (normalized.length === 0) {
      throw new ScreamError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    const entry = await this.findExistingSessionEntry(id);
    const statePath = join(entry.sessionDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new ScreamError(ErrorCodes.SESSION_STATE_NOT_FOUND, `Session "${id}" state.json was not found`, {
        cause: error,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ScreamError(ErrorCodes.SESSION_STATE_INVALID, `Session "${id}" state.json is invalid`);
    }
    const next: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      title: normalized,
      isCustomTitle: true,
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  }

  async delete(id: string): Promise<void> {
    assertSafeSessionId(id);
    const entry = await this.findSessionEntry(id);
    if (entry !== undefined) {
      await rm(entry.sessionDir, { recursive: true, force: true }).catch(() => {});
    }
    await removeSessionIndexEntry(this.homeDir, id).catch(() => {});
  }

  async list(options: ListSessionsPayload = {}): Promise<readonly SessionSummary[]> {
    const workDir =
      options.workDir === undefined ? undefined : normalizeRequiredWorkDir(options.workDir);
    const sessionId = normalizeOptionalSessionId(options.sessionId);

    if (workDir !== undefined) {
      if (sessionId !== undefined) {
        const local = await this.summaryFromWorkDirSession(sessionId, workDir);
        if (local !== undefined) return [local];
        return this.listSessionId(sessionId);
      }
      return this.listWorkDir(workDir);
    }

    if (sessionId !== undefined) {
      return this.listSessionId(sessionId);
    }
    return this.listAll();
  }

  private async listWorkDir(workDir: string): Promise<readonly SessionSummary[]> {
    const bucketDir = join(this.sessionsDir, encodeWorkDirKey(workDir));
    let entries;
    try {
      entries = await readdir(bucketDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!isSafeSessionId(id)) continue;
      const dir = join(bucketDir, id);
      sessions.push(await this.summaryFromDir(id, dir, workDir));
    }
    sessions.sort(compareSessionSummary);
    return sessions;
  }

  private async listSessionId(sessionId: string): Promise<readonly SessionSummary[]> {
    try {
      return [await this.get(sessionId)];
    } catch (error) {
      if (error instanceof ScreamError && error.code === ErrorCodes.SESSION_NOT_FOUND) {
        return [];
      }
      throw error;
    }
  }

  private async listAll(): Promise<readonly SessionSummary[]> {
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    const sessions: SessionSummary[] = [];
    const seenAgentIds = new Set<string>();
    for (const entry of index.values()) {
      if (!(await isDirectory(entry.sessionDir))) continue;
      const summary = await this.summaryFromDir(entry.sessionId, entry.sessionDir, entry.workDir);
      sessions.push(summary);
      seenAgentIds.add(entry.sessionId);
    }

    // Merge cc-connect sessions.
    try {
      const ccSessions = await listCcConnectSessions(seenAgentIds);
      sessions.push(...ccSessions);
    } catch {
      // cc-connect not installed or data directory unreadable — skip silently.
    }

    sessions.sort(compareSessionSummary);
    return sessions;
  }

  private async summaryFromWorkDirSession(
    sessionId: string,
    workDir: string,
  ): Promise<SessionSummary | undefined> {
    if (!isSafeSessionId(sessionId)) return undefined;
    const sessionDir = this.sessionDirFor({ id: sessionId, workDir });
    if (!(await isDirectory(sessionDir))) return undefined;
    return this.summaryFromDir(sessionId, sessionDir, workDir);
  }

  async assertDirectory(id: string): Promise<string> {
    return (await this.findExistingSessionEntry(id)).sessionDir;
  }

  private async findSessionEntry(id: string): Promise<SessionIndexEntry | undefined> {
    if (!isSafeSessionId(id)) return undefined;
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    return index.get(id);
  }

  private async findExistingSessionEntry(id: string): Promise<SessionIndexEntry> {
    const entry = await this.findSessionEntry(id);
    if (entry !== undefined && (await isDirectory(entry.sessionDir))) return entry;
    throw new ScreamError(ErrorCodes.SESSION_NOT_FOUND, `Session "${id}" was not found`, {
      details: { sessionId: id },
    });
  }

  private async writeForkedState(
    input: ForkSessionRecordInput,
    sourceDir: string,
    targetDir: string,
  ): Promise<void> {
    const statePath = join(targetDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new ScreamError(
        ErrorCodes.SESSION_STATE_NOT_FOUND,
        `Session "${input.sourceId}" state.json was not found`,
        {
          cause: error,
        },
      );
    }
    if (!isRecord(parsed)) {
      throw new ScreamError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session "${input.sourceId}" state.json is invalid`,
      );
    }

    const title = normalizeForkTitle(input.title, parsed['title']);
    const now = new Date().toISOString();
    const next: Record<string, unknown> = {
      ...parsed,
      createdAt: now,
      updatedAt: now,
      title,
      isCustomTitle: input.title === undefined ? parsed['isCustomTitle'] === true : true,
      forkedFrom: input.sourceId,
      agents: rewriteAgentHomedirs(parsed['agents'], sourceDir, targetDir),
      custom: Object.assign({}, isRecord(parsed['custom']) ? parsed['custom'] : {}, input.metadata),
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  }

  private async summaryFromDir(
    id: string,
    sessionDir: string,
    workDir: string,
  ): Promise<SessionSummary> {
    const dirStat = await stat(sessionDir);
    const state = await readOptionalState(sessionDir);
    const [stateInfo, wireInfo, agentsWireMtime] = await Promise.all([
      statIfExists(join(sessionDir, 'state.json')),
      statIfExists(join(sessionDir, 'wire.jsonl')),
      latestAgentWireMtime(sessionDir),
    ]);
    return {
      id,
      workDir,
      sessionDir,
      createdAt: timestampOrFallback(dirStat.birthtimeMs, dirStat.ctimeMs),
      updatedAt: Math.max(
        dirStat.mtimeMs,
        stateInfo?.mtimeMs ?? 0,
        wireInfo?.mtimeMs ?? 0,
        agentsWireMtime ?? 0,
      ),
      title: titleFromState(state),
      lastPrompt: state?.lastPrompt,
      metadata: metadataFromState(state),
    };
  }
}

function metadataFromState(state: SessionSummaryState | undefined): JsonObject | undefined {
  if (state === undefined || state.custom === undefined) return undefined;
  return state.custom as JsonObject;
}

async function latestAgentWireMtime(sessionDir: string): Promise<number | undefined> {
  const agentsDir = join(sessionDir, 'agents');
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let latest = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wireInfo = await statIfExists(join(agentsDir, entry.name, 'wire.jsonl'));
    latest = Math.max(latest, wireInfo?.mtimeMs ?? 0);
  }
  return latest > 0 ? latest : undefined;
}

function titleFromState(state: SessionSummaryState | undefined): string | undefined {
  if (state === undefined) return undefined;
  if (typeof state.isCustomTitle === 'boolean' && typeof state.title === 'string') {
    return state.title;
  }
  if (typeof state.customTitle === 'string') return state.customTitle;
  return typeof state.title === 'string' ? state.title : undefined;
}

async function readOptionalState(sessionDir: string): Promise<SessionSummaryState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')) as unknown;
    const result = SessionSummaryStateSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRequiredWorkDir(workDir: string): string {
  if (workDir.trim() === '') {
    throw new ScreamError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, 'listSessions requires workDir');
  }
  return normalizeWorkDir(workDir);
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  return sessionId === undefined ? undefined : sessionId.trim();
}

function normalizeForkTitle(title: string | undefined, fallback: unknown): string {
  if (title !== undefined) {
    const normalized = title.trim();
    if (normalized.length === 0) {
      throw new ScreamError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    return normalized;
  }
  return typeof fallback === 'string' && fallback.trim().length > 0 ? fallback : 'New Session';
}

function rewriteAgentHomedirs(value: unknown, sourceDir: string, targetDir: string): unknown {
  if (!isRecord(value)) return {};

  const agents: Record<string, unknown> = {};
  for (const [agentId, agentMeta] of Object.entries(value)) {
    if (!isRecord(agentMeta)) {
      agents[agentId] = agentMeta;
      continue;
    }
    const homedir = agentMeta['homedir'];
    agents[agentId] = {
      ...agentMeta,
      homedir:
        typeof homedir === 'string' ? remapSessionPath(homedir, sourceDir, targetDir) : homedir,
    };
  }
  return agents;
}

function remapSessionPath(value: string, sourceDir: string, targetDir: string): string {
  const rel = relative(sourceDir, value);
  if (rel === '') return targetDir;
  if (rel.startsWith('..') || isAbsolute(rel)) return value;
  return join(targetDir, rel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function statIfExists(path: string): Promise<{ readonly mtimeMs: number } | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function timestampOrFallback(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertSafeSessionId(id: string): void {
  if (isSafeSessionId(id)) return;
  throw new ScreamError(ErrorCodes.SESSION_ID_INVALID, 'Session id contains unsupported path characters');
}

function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

function compareSessionSummary(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

// ── cc-connect session discovery ───────────────────────────────────────

const CC_CONNECT_SESSIONS_DIR = join(homedir(), '.cc-connect', 'sessions');

/**
 * Scan `~/.cc-connect/sessions/*.json` and return ScreamCode-compatible
 * SessionSummary entries for every cc-connect session that has a
 * non-empty agent_session_id (i.e. can actually be resumed).
 *
 * Sessions whose `agent_session_id` already appears in `seenAgentIds` are
 * skipped — the native ScreamCode session takes precedence.
 */
async function listCcConnectSessions(
  seenAgentIds: Set<string>,
): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(CC_CONNECT_SESSIONS_DIR);
  } catch {
    return [];
  }

  const results: SessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const projectName = name.slice(0, -5); // strip ".json"
    const filePath = join(CC_CONNECT_SESSIONS_DIR, name);
    const parsed = await readCcConnectSnapshot(filePath);
    if (parsed === undefined) continue;

    for (const [, ccSession] of Object.entries(parsed.sessions ?? {})) {
      const agentId = ccSession.agent_session_id?.trim();
      if (!agentId || agentId.length === 0) continue;
      // Deduplicate: if a native ScreamCode session already tracks this
      // agent session ID, skip the CC wrapper.
      if (seenAgentIds.has(agentId)) continue;

      const summary = ccSessionToSummary(ccSession, agentId, projectName);
      if (summary !== undefined) {
        results.push(summary);
        seenAgentIds.add(agentId);
      }
    }
  }
  return results;
}

async function readCcConnectSnapshot(
  filePath: string,
): Promise<z.infer<typeof CcConnectSnapshotSchema> | undefined> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = CcConnectSnapshotSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the last user-message content for a preview in the picker. */
function lastPromptFromCcHistory(
  history: readonly z.infer<typeof CcConnectHistoryEntrySchema>[] | null | undefined,
): string | undefined {
  if (!history || history.length === 0) return undefined;
  // Walk backwards to find the last user message.
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.role === 'user' && entry.content?.trim().length > 0) {
      return entry.content.trim();
    }
  }
  return undefined;
}

function ccSessionToSummary(
  cc: CcConnectSession,
  agentSessionId: string,
  projectName: string,
): SessionSummary | undefined {
  const id = `cc:${projectName}/${cc.id}`;
  const createdAt = parseCcTimestamp(cc.created_at);
  const updatedAt = parseCcTimestamp(cc.updated_at) ?? createdAt;
  if (createdAt === undefined && updatedAt === undefined) return undefined;

  const title = cc.name?.trim() || cc.id;
  const lastPrompt = lastPromptFromCcHistory(cc.history);

  const metadata: Record<string, JsonValue> = {
    source: 'cc-connect',
    agentSessionId,
    ccProject: projectName,
    ccSessionId: cc.id,
  };
  if (cc.agent_type) {
    metadata['agentType'] = cc.agent_type;
  }

  return {
    id,
    workDir: homedir(),
    sessionDir: '',
    createdAt: createdAt ?? updatedAt!,
    updatedAt: updatedAt ?? createdAt!,
    title: title.length > 0 ? title : undefined,
    lastPrompt,
    metadata,
  };
}

/** Parse an ISO-8601 timestamp with optional timezone offset to epoch ms. */
function parseCcTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
