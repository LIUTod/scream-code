/**
 * Bot runtime: one ScreamHarness, one lazily created core session per thread.
 *
 * The gateway never blocks an HTTP request on a turn: `prompt` creates a run
 * row and returns immediately, while the turn streams through SSE and closes
 * the run on `turn.ended`. Approvals and questions are persisted before they
 * are announced, so a refreshing UI can always recover the inbox.
 */
import { createHash, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponse,
  ContextMessage,
  Event as SessionEvent,
  QuestionHandler,
  QuestionRequest,
  QuestionResult,
  ScreamHarness,
  SessionAgentProfile,
  Session as ScreamSession,
  ToolCallRequest,
  ToolCallResponse,
} from '@scream-code/scream-code-sdk';

import type {
  Approval,
  ApprovalDecision,
  Attachment,
  Bot,
  BotPermission,
  Handoff,
  Message,
  Question,
  QuestionItem,
  RelayStatus,
  Run,
  RunStatus,
  Thread,
  ToolCall,
  TranscriptSnapshot,
  RecoveryDecision,
} from '../shared/contracts';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_QUESTION_TIMEOUT_MS,
  type ApprovalRecord,
  type BotRecord,
  type BotStore,
  type HandoffRecord,
  type QuestionRecord,
  type RoomMessageRecord,
  type RunRecord,
  type ThreadRecord,
} from './store';
import type { SseHub } from './sse';
import { answerForRun, reconcileMessages } from './transcript';
import { identityPrompt } from './identity';
export { mergeMessages } from './transcript';

/** The slice of `Session` the runtime relies on; fakes only implement this. */
export interface BotSession {
  readonly id: string;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  /** Host-executed tools are registered per session; nothing is persisted. */
  registerTool(payload: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }): Promise<void>;
  /** Soft runtime prompt; replaces the previous append rather than stacking. */
  setRuntimeSystemPrompt(prompt: {
    readonly replace?: string | undefined;
    readonly append?: string | undefined;
  }): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  setPermission(mode: 'manual' | 'yolo' | 'auto' | 'ask' | 'bot'): Promise<void>;
  setActiveTools(names: readonly string[]): Promise<void>;
  prompt(input: string): Promise<void>;
  steer(input: string): Promise<void>;
  cancel(): Promise<void>;
  getContext(): Promise<{ readonly history: readonly ContextMessage[] }>;
  listBackgroundTasks?(options: { activeOnly: boolean }): Promise<readonly unknown[]>;
  listCronTasks?(): Promise<readonly unknown[]>;
  close(options?: { readonly extractMemories?: boolean }): Promise<void>;
}

export interface BotSessionFactory {
  open(bot: BotRecord, thread: ThreadRecord): Promise<BotSession>;
}

export interface BotRuntimeOptions {
  readonly store: BotStore;
  readonly hub: SseHub;
  readonly sessions: BotSessionFactory;
  readonly now?: (() => number) | undefined;
  readonly approvalTimeoutMs?: number | undefined;
  readonly questionTimeoutMs?: number | undefined;
  readonly idleMinutes?: number | undefined;
}

export interface PromptOptions {
  readonly text: string;
  readonly mode?: 'steer' | 'queue' | undefined;
  readonly requestKey?: string;
  readonly attachments?: readonly Attachment[];
}

export interface PromptResult {
  readonly runId: string;
  readonly status: RunStatus;
}

const ATTACHMENT_PATH = /^\.scream-attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[\p{L}\p{N}._-]+$/u;

/** Only files this server saved may be attached; anything else is a client bug. */
function normalizeAttachments(input: readonly Attachment[] | undefined): readonly Attachment[] {
  if (input === undefined || input.length === 0) return [];
  if (input.length > 10) {
    throw new RuntimeError('attachments.too_many', 'At most 10 attachments per message', 400);
  }
  for (const attachment of input) {
    if (!ATTACHMENT_PATH.test(attachment.path)) {
      throw new RuntimeError('attachments.invalid', 'Attachment path is not an uploaded file', 400);
    }
  }
  return input;
}

/** The turn sees where the files are; the transcript keeps the plain sentence. */
function withAttachments(text: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map(
    (attachment) => `- ${attachment.path} (${attachment.name}, ${attachment.mime})`,
  );
  return `${text}\n\nAttached files (paths are relative to your workspace):\n${lines.join('\n')}`;
}

/** Error with an HTTP status so the gateway does not have to guess. */
export class RuntimeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface OpenSession {
  readonly generation: string;
  readonly session: BotSession;
  readonly botId: string;
  lastUsedAt: number;
  readonly unsubscribe: () => void;
}

interface PendingApproval {
  readonly approvalId: string;
  readonly runId: string | null;
  readonly threadId: string;
  readonly botId: string;
  readonly resolve: (response: ApprovalResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
  readonly questionId: string;
  readonly runId: string | null;
  readonly threadId: string;
  readonly botId: string;
  readonly resolve: (result: QuestionResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting_user']);

/** One hop only, and at most this many hand-offs from a single run. */
const MAX_HANDOFFS_PER_RUN = 3;

/** The one host-executed tool this gateway registers on every session. */
const MESSAGE_BOT_TOOL: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
} = {
  name: 'message_bot',
  description:
    'Work with another Bot in this workbench. action="send" hands over a task (one hop only, at most three per run); action="list" returns the Bots you can contact.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send', 'list'],
        description: 'send hands over work; list returns the Bot roster.',
      },
      to: { type: 'string', description: 'Name of the Bot that should take the task.' },
      task: { type: 'string', description: 'The task to hand over, stated in full.' },
      constraints: { type: 'string', description: 'Optional limits the other Bot must respect.' },
      expecting: { type: 'string', description: 'Optional description of the answer needed back.' },
    },
    anyOf: [
      { properties: { action: { const: 'list' } }, required: ['action'] },
      { required: ['to', 'task'] },
    ],
    additionalProperties: false,
  },
};

function isActiveRun(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map a stored permission string onto the bot's two tiers. Anything that is
 * not exactly `auto` is the safe tier — a legacy `ask`/`workspace`/`read`/
 * `yolo`/`manual` row can never leave a Bot in a read-only or unchecked mode.
 */
export function normalizePermission(value: string | undefined): BotPermission {
  return value === 'auto' ? 'auto' : 'bot';
}

/** Session profile for a bot: role text is appended to the base prompt. */
export function buildSessionProfile(bot: BotRecord): SessionAgentProfile {
  const allow = bot.toolPolicy.allow;
  return {
    name: bot.name,
    systemPrompt: bot.rolePrompt.length > 0 ? bot.rolePrompt : undefined,
    ...(allow !== undefined && allow.length > 0 ? { activeTools: allow } : {}),
  };
}

/**
 * Real factory over `ScreamHarness`. `exactWorkDir` keeps a bot rooted in its
 * own workspace instead of folding into the enclosing repository.
 */
export function createHarnessSessionFactory(
  harness: ScreamHarness,
  defaults: { readonly model?: string | undefined; readonly permission?: string | undefined } = {},
): BotSessionFactory {
  return {
    async open(bot, thread) {
      if (thread.coreSessionId !== null) {
        const resumed = await harness.resumeSession({ id: thread.coreSessionId });
        return resumed as unknown as BotSession;
      }
      const model = bot.model ?? defaults.model;
      const created: ScreamSession = await harness.createSession({
        workDir: thread.workspace || bot.workspace,
        exactWorkDir: true,
        permission: normalizePermission(bot.permission ?? defaults.permission),
        ...(model === undefined ? {} : { model }),
        ...(bot.thinking === null ? {} : { thinking: bot.thinking }),
        profile: buildSessionProfile(bot),
      });
      return created as unknown as BotSession;
    },
  };
}

/**
 * Members a room message is addressed to, in the order they are mentioned.
 * With no resolvable mention the message goes to `fallback` (lead or first
 * member) instead of failing the post.
 */
function resolveRoomTargets(
  members: readonly BotRecord[],
  fallback: BotRecord,
  text: string,
): BotRecord[] {
  const lower = text.toLowerCase();
  const boundary = /[\s，。！？；：、,.!?;:()（）[\]【】"'“”‘’]/u;
  const hits: { index: number; bot: BotRecord }[] = [];
  for (const bot of members) {
    // Full names may contain spaces; match the longest literal name and only
    // when it stands on its own (so `a@b.com` is not a mention).
    const needle = `@${bot.name.toLowerCase()}`;
    let index = lower.indexOf(needle);
    while (index !== -1) {
      const before = index === 0 ? ' ' : lower[index - 1] ?? ' ';
      const after = lower[index + needle.length] ?? ' ';
      if (boundary.test(before) && boundary.test(after)) {
        hits.push({ index, bot });
        break;
      }
      index = lower.indexOf(needle, index + 1);
    }
  }
  hits.sort((left, right) => left.index - right.index);
  const targets: BotRecord[] = [];
  for (const { bot } of hits) {
    if (!targets.some((entry) => entry.id === bot.id)) targets.push(bot);
  }
  return targets.length > 0 ? targets : [fallback];
}

export class BotRuntime {
  private readonly store: BotStore;
  private readonly hub: SseHub;
  private readonly sessions: BotSessionFactory;
  private readonly now: () => number;
  private readonly approvalTimeoutMs: number;
  private readonly questionTimeoutMs: number;
  private readonly idleMs: number;

  private readonly openSessions = new Map<string, OpenSession>();
  private readonly openingSessions = new Map<string, Promise<BotSession>>();
  private readonly activeRunByThread = new Map<string, string>();
  private readonly roomDeltaAt = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly completions = new Map<string, () => void>();
  private readonly awaitingStart = new Map<string, {runId:string;generation:string}>();
  private readonly seenTurns = new Set<string>();
  private readonly dispatchCollisions = new Set<string>();
  private readonly stepByRun = new Map<string,string>();
  private readonly scheduledRuns = new Set<string>();
  private readonly deletingThreads = new Set<string>();
  private readonly deletingBots = new Set<string>();
  private readonly projectionVersions = new Map<string, number>();
  private readonly reconciling = new Map<string, Promise<void>>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly transcripts = new Map<string, Message[]>();
  private readonly assistantBuffers = new Map<string, string>();
  /** Placeholder message id per run, so deltas patch one assistant bubble. */
  private readonly assistantMessageIds = new Map<string, string>();
  private readonly toolsByRun = new Map<string, Map<string, ToolCall>>();
  private readonly errorsByRun = new Map<string, string>();
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: BotRuntimeOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.questionTimeoutMs = options.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
    this.idleMs = Math.max(0, options.idleMinutes ?? 0) * 60_000;
  }

  /**
   * Recover only provably undispatched inputs. Unknown execution becomes an
   * interrupted record and a thread-local gate; old callback decisions expire.
   */
  start(): { orphanRuns: number; expiredApprovals: number; expiredQuestions: number } {
    const orphanRuns = this.store.markOrphanRuns();
    const staleApprovals = this.store.listApprovals({ pendingOnly: true });
    for (const approval of staleApprovals) this.store.expireApproval(approval.id);
    const staleQuestions = this.store.listQuestions({ pendingOnly: true });
    for (const question of staleQuestions) this.store.expireQuestion(question.id);
    if (orphanRuns > 0 || staleApprovals.length > 0 || staleQuestions.length > 0) {
      this.store.appendAudit({
        actor: 'gateway',
        initiator: 'system',
        action: 'gateway.recovered',
        decision: 'expired',
        payload: {
          orphanRuns,
          expiredApprovals: staleApprovals.length,
          expiredQuestions: staleQuestions.length,
        },
      });
    }
    if (this.idleMs > 0 && this.idleTimer === undefined) {
      const interval = Math.min(60_000, Math.max(1_000, this.idleMs));
      this.idleTimer = setInterval(() => {
        void this.sweepIdleSessions();
      }, interval);
      this.idleTimer.unref?.();
    }
    this.kickQueue();
    // A crash between "target answered" and "answer relayed" leaves a durable
    // pending relay; resume it without re-running the target.
    this.pumpRelays();
    return {
      orphanRuns,
      expiredApprovals: staleApprovals.length,
      expiredQuestions: staleQuestions.length,
    };
  }

  /** Queue a prompt; returns the run id without waiting for the turn. */
  prompt(threadId: string, input: PromptOptions): PromptResult {
    this.assertOpen();
    const thread = this.requireThread(threadId);
    const bot = this.requireBot(thread.botId);
    const text = input.text.trim();
    if (text.length === 0) {
      throw new RuntimeError('prompt.empty', 'Message text is required', 400);
    }
    if (this.deletingThreads.has(threadId) || this.deletingBots.has(bot.id)) {
      throw new RuntimeError('thread.deleting', 'Thread is being deleted', 409);
    }
    const attachments = normalizeAttachments(input.attachments);
    const key = input.requestKey ?? `request_${randomUUID()}`;
    const accepted = this.store.getAcceptedInput(key);
    if (accepted !== undefined) {
      if (accepted.threadId !== threadId || accepted.text !== text) {
        throw new RuntimeError('request.conflict', 'Request key belongs to different input', 409);
      }
      return { runId: accepted.run.id, status: accepted.run.status };
    }
    if (bot.paused) throw new RuntimeError('bot.paused', 'Bot is paused', 409);
    const runningId = this.activeRunByThread.get(threadId);
    const open = this.openSessions.get(threadId);
    const active = runningId === undefined ? undefined : this.store.getRun(runningId);
    const steer = input.mode === 'steer' && active !== undefined && active.turnId !== null && open !== undefined;
    const { run, message } = this.store.transaction(() => {
      const promptText = withAttachments(text, attachments);
      const run = steer ? active : this.store.createRun({ botId: bot.id, threadId, text: promptText, requestKey: key });
      const message: Message = {
        id: `msg_${randomUUID()}`, threadId, role: 'user', content: text, createdAt: this.now(), runId: run.id,
        ...(attachments.length === 0 ? {} : { attachments }),
      };
      this.store.recordInput(key, run.id, message, steer ? 'steer' : 'queue');
      this.store.touchThread(threadId, this.now());
      this.store.touchBot(bot.id, this.now());
      return { run, message };
    });
    this.appendMessage(threadId, message);
    this.publishMessage(bot.id, threadId, message);
    this.publishRun(run);
    if (steer) {
      void open.session.steer(withAttachments(text, attachments)).catch((error: unknown) => {
        void this.interruptUncertain(run.id, threadId, `steer failed: ${errorMessage(error)}`);
      });
    } else {
      this.kickQueue();
    }
    return { runId: run.id, status: run.status };
  }

  /** Cancel the live turn (if any) and settle its inbox items. */
  async interrupt(threadId: string): Promise<Run | undefined> {
    this.assertOpen();
    const thread = this.requireThread(threadId);
    const bot = this.requireBot(thread.botId);
    const runId = this.activeRunByThread.get(threadId) ?? this.awaitingStart.get(threadId)?.runId;
    this.expireInboxForThread(threadId, 'interrupted');
    const open = this.openSessions.get(threadId);
    if (open !== undefined && runId !== undefined) {
      try {
        await open.session.cancel();
      } catch (error) {
        await this.interruptUncertain(runId, threadId, `Cancel outcome unknown: ${errorMessage(error)}`);
      }
    }
    const run = runId === undefined ? undefined : this.store.getRun(runId);
    this.store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'run.cancel_requested',
      decision: run?.status ?? 'no_active_run',
      botId: bot.id,
      threadId,
    });
    return run === undefined ? undefined : this.publicRun(run);
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    feedback?: string,
  ): Promise<Approval | undefined> {
    this.assertOpen();
    const row = this.store.getApproval(approvalId);
    if (row === undefined) return undefined;
    if (row.status !== 'pending') return publicApproval(row);
    const updated = this.store.decideApproval(approvalId, decision, feedback ?? null);
    if (updated === undefined) return undefined;
    this.hub.publish({ botId: updated.botId, threadId: updated.threadId, type: 'approval.decided', data: publicApproval(updated) });
    this.store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'approval.decided',
      decision,
      botId: updated.botId,
      threadId: updated.threadId,
      payload: { approvalId, toolName: updated.toolName, feedback: feedback ?? null },
    });
    const pending = this.pendingApprovals.get(approvalId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(approvalId);
      pending.resolve(toSdkApprovalResponse(decision, feedback));
      this.resumeRunIfIdle(pending.threadId, pending.runId);
    }
    this.publishBot(updated.botId);
    return publicApproval(updated);
  }

  async resolveQuestion(
    questionId: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<Question | undefined> {
    this.assertOpen();
    const row = this.store.getQuestion(questionId);
    if (row === undefined) return undefined;
    if (row.status !== 'pending') return publicQuestion(row);
    const updated = this.store.answerQuestion(questionId, answers);
    if (updated === undefined) return undefined;
    this.hub.publish({ botId: updated.botId, threadId: updated.threadId, type: 'question.answered', data: publicQuestion(updated) });
    this.store.appendAudit({
      actor: 'person',
      initiator: 'person',
      action: 'question.answered',
      decision: 'answered',
      botId: updated.botId,
      threadId: updated.threadId,
      payload: { questionId },
    });
    const pending = this.pendingQuestions.get(questionId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pendingQuestions.delete(questionId);
      pending.resolve(toSdkQuestionResult(updated));
      this.resumeRunIfIdle(pending.threadId, pending.runId);
    }
    this.publishBot(updated.botId);
    return publicQuestion(updated);
  }

  /**
   * Transcript for a thread: core history projected through the runtime, with
   * live in-flight messages preserved when a run is active.
   */
  async hydrate(threadId: string): Promise<Message[]> {
    const thread = this.requireThread(threadId);
    if (thread.blockedByRunId !== null) return [...this.messagesForThread(threadId)];
    if (thread.coreSessionId !== null || this.openSessions.has(threadId) || this.openingSessions.has(threadId)) {
      const initialized = this.openSessions.has(threadId) && !this.openingSessions.has(threadId);
      const session = await this.ensureSession(this.requireBot(thread.botId), thread);
      if (initialized && !this.activeRunByThread.has(threadId)) await this.reconcileTranscript(threadId, session);
    }
    return [...this.messagesForThread(threadId)];
  }

  async transcriptSnapshot(threadId: string): Promise<TranscriptSnapshot> {
    const messages = await this.hydrate(threadId);
    return {epoch:this.hub.epoch,threadId,version:this.version(threadId),messages};
  }

  private messagesForThread(threadId: string): Message[] {
    let messages = this.transcripts.get(threadId);
    if (messages === undefined) { messages = this.store.listMessages(threadId); this.transcripts.set(threadId,messages); }
    return messages;
  }

  private version(threadId: string): number {
    return this.projectionVersions.get(threadId) ?? this.store.getThread(threadId)?.projectionVersion ?? 0;
  }

  private bumpVersion(threadId: string): number {
    const version = this.version(threadId)+1;
    this.projectionVersions.set(threadId,version);
    return version;
  }

  private persistTranscript(threadId: string): void {
    if (this.store.getThread(threadId) !== undefined) this.store.saveProjection(threadId,this.messagesForThread(threadId),this.version(threadId));
  }

  private reconcileTranscript(threadId: string, session: BotSession): Promise<void> {
    const previous = this.reconciling.get(threadId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const context = await session.getContext();
      if (this.closed || this.deletingThreads.has(threadId) || this.store.getThread(threadId) === undefined || this.openSessions.get(threadId)?.session !== session) return;
      const cached = this.messagesForThread(threadId);
      const eligible = new Set(cached.flatMap((message) => {
        if (message.runId === undefined) return [];
        const run = this.store.getRun(message.runId);
        return run?.turnId !== null && run?.dispatchStartedAt !== null && run?.coreSessionId === session.id ? [message.runId] : [];
      }));
      const merged = reconcileMessages(projectHistory(context.history,threadId,session.id),cached,eligible);
      if (JSON.stringify(merged) !== JSON.stringify(cached)) { this.bumpVersion(threadId); this.transcripts.set(threadId,merged); }
      this.persistTranscript(threadId);
    }).finally(() => { if (this.reconciling.get(threadId) === task) this.reconciling.delete(threadId); });
    this.reconciling.set(threadId,task);
    return task;
  }

  /** Drop every live session/transcript for a bot before the row is deleted. */
  async closeBot(botId: string): Promise<void> {
    this.deletingBots.add(botId);
    for (const thread of this.store.listThreads(botId,{includeArchived:true,scope:'all'})) {
      this.deletingThreads.add(thread.id);
      this.expireInboxForThread(thread.id,'deleted');
      for (const run of this.store.listRunsForThread(thread.id,Number.MAX_SAFE_INTEGER)) {
        if (isActiveRun(run.status)) this.finishRun(run.id,thread.id,'cancelled');
      }
    }
    for (const [threadId, entry] of Array.from(this.openSessions)) {
      if (entry.botId !== botId) continue;
      this.openSessions.delete(threadId);
      entry.unsubscribe();
      await entry.session.close({ extractMemories: false }).catch(() => {});
    }
    for (const thread of this.store.listThreads(botId, { includeArchived: true, scope: 'all' })) {
      this.transcripts.delete(thread.id);
      this.activeRunByThread.delete(thread.id);
    }
  }

  async deleteRoom(roomId: string): Promise<boolean> {
    const threadIds = this.store.deleteRoom(roomId);
    if (threadIds === undefined) return false;
    for (const threadId of threadIds) {
      await this.deleteThread(threadId);
    }
    return true;
  }

  async deleteThread(threadId: string): Promise<boolean> {
    const botId = this.store.getThread(threadId)?.botId;
    this.deletingThreads.add(threadId);
    this.expireInboxForThread(threadId,'deleted');
    for (const run of this.store.listRunsForThread(threadId,Number.MAX_SAFE_INTEGER)) {
      if (isActiveRun(run.status)) this.finishRun(run.id,threadId,'cancelled');
    }
    await this.openingSessions.get(threadId)?.catch(() => {});
    const open = this.openSessions.get(threadId);
    if (open !== undefined) {
      this.openSessions.delete(threadId);
      open.unsubscribe();
      await open.session.cancel().catch(() => {});
      await open.session.close({ extractMemories: false }).catch(() => {});
    }
    this.transcripts.delete(threadId);
    this.activeRunByThread.delete(threadId);
    const deleted = this.store.deleteThread(threadId);
    if (
      deleted &&
      botId !== undefined &&
      this.store.getBot(botId) !== undefined &&
      this.store.listThreads(botId).length === 0
    ) {
      // Keep the Bot's landing conversation available, including after room
      // cleanup, without adding side effects to BotStore.createBot.
      this.store.createThread(botId);
    }
    return deleted;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.completions.values()) resolve();
    this.completions.clear();
    this.awaitingStart.clear();
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timer);
      this.store.expireApproval(pending.approvalId);
      pending.resolve({ decision: 'cancelled' });
    }
    this.pendingApprovals.clear();
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timer);
      this.store.expireQuestion(pending.questionId);
      pending.resolve(null);
    }
    this.pendingQuestions.clear();
    const sessions = [...this.openSessions.values()];
    this.openSessions.clear();
    await Promise.all(
      sessions.map(async (entry) => {
        entry.unsubscribe();
        await entry.session.close({ extractMemories: false }).catch(() => {});
      }),
    );
    await Promise.all([...this.openingSessions.values()].map(async (opening) => {
      const session = await opening.catch(() => undefined);
      await session?.close({ extractMemories: false }).catch(() => {});
    }));
    this.openingSessions.clear();
    await Promise.all([...this.chains.values()].map(async (chain) => chain.catch(() => {})));
  }

  // ------------------------------------------------------------- execution

  kickQueue(): void {
    if (this.closed) return;
    for (const run of this.store.listQueuedRuns()) {
      const thread = this.store.getThread(run.threadId);
      if (
        run.input === null || run.dispatchStartedAt !== null || this.scheduledRuns.has(run.id) || this.activeRunByThread.has(run.threadId) ||
        thread === undefined || thread.blockedByRunId !== null || this.store.getBot(run.botId)?.paused ||
        this.deletingThreads.has(run.threadId) || this.deletingBots.has(run.botId)
      ) continue;
      const text = run.input.text;
      this.scheduledRuns.add(run.id);
      this.enqueue(run.threadId, async () => {
        try {
          await this.executeRun(run.id, text);
        } finally {
          this.scheduledRuns.delete(run.id);
          this.kickQueue();
        }
      });
    }
  }

  cancelQueuedRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (run === undefined) throw new RuntimeError('run.not_found', 'Run not found', 404);
    if (run.status === 'cancelled') return this.publicRun(run);
    if (run.status !== 'queued' || run.dispatchStartedAt !== null) {
      throw new RuntimeError('run.not_queued', 'Only undispatched queued runs can be cancelled', 409);
    }
    return this.publicRun(this.finishRun(runId, run.threadId, 'cancelled')!);
  }

  recoverRun(runId: string, decision: RecoveryDecision): { run: Run; retryRun: Run | null } {
    const current = this.store.getRun(runId);
    if (current === undefined) throw new RuntimeError('run.not_found', 'Run not found', 404);
    let result;
    try {
      result = this.store.recoverRun(runId, decision);
    } catch (error) {
      throw new RuntimeError('run.recovery_conflict', errorMessage(error), 409);
    }
    this.publishRun(result.run);
    if (result.retry !== undefined) this.publishRun(result.retry);
    this.kickQueue();
    return {
      run: this.publicRun(result.run),
      retryRun: result.retry === undefined ? null : this.publicRun(result.retry),
    };
  }

  private async interruptUncertain(runId: string, threadId: string, reason: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (run === undefined || !isActiveRun(run.status)) return;
    this.store.transaction(() => {
      this.store.updateRunStatus(runId, 'interrupted', { error: reason });
      this.store.blockThread(threadId, runId);
      const other = this.activeRunByThread.get(threadId);
      if (other !== undefined && other !== runId) {
        const interrupted = this.store.updateRunStatus(other, 'interrupted', { error: reason });
        if (interrupted !== undefined) this.publishRun(interrupted);
        this.expireRunInbox(other);
      }
    });
    this.flushAssistantMessage(runId, threadId);
    this.expireRunInbox(runId);
    this.activeRunByThread.delete(threadId);
    this.awaitingStart.delete(threadId);
    const open = this.openSessions.get(threadId);
    this.openSessions.delete(threadId);
    open?.unsubscribe();
    this.persistTranscript(threadId);
    this.publishRun(this.store.getRun(runId)!);
    this.completions.get(runId)?.();
    this.completions.delete(runId);
    await open?.session.close({ extractMemories: false }).catch(() => {});
  }

  private enqueue(threadId: string, task: () => Promise<void>): void {
    const previous = this.chains.get(threadId) ?? Promise.resolve();
    const next = previous
      .then(task, task)
      .catch(() => {})
      .finally(() => {
        if (this.chains.get(threadId) === next) this.chains.delete(threadId);
      });
    this.chains.set(threadId, next);
  }

  private async executeRun(runId: string, text: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (run === undefined || this.closed) return;
    // Interrupted while still queued: never start the turn.
    if (run.status === 'cancelled') return;
    const thread = this.store.getThread(run.threadId);
    if (thread === undefined) {
      this.failRun(runId, run.threadId, 'thread disappeared');
      return;
    }
    const bot = this.store.getBot(run.botId);
    if (bot === undefined) {
      this.failRun(runId, run.threadId, 'bot disappeared');
      return;
    }

    if (bot.paused || thread.blockedByRunId !== null || this.deletingThreads.has(thread.id) || this.deletingBots.has(bot.id)) return;
    let dispatched = false;
    try {
      const session = await this.ensureSession(bot,thread);
      await this.applyConfig(session, bot, thread);
      await this.applyIdentity(session, bot, thread);
      const latest = this.store.getRun(runId);
      const liveThread = this.store.getThread(thread.id);
      if (this.closed || latest?.status !== 'queued' || liveThread?.blockedByRunId !== null || this.store.getBot(bot.id)?.paused || this.deletingThreads.has(thread.id)) return;
      if (this.activeRunByThread.has(thread.id)) return;
      const generation = this.openSessions.get(thread.id)!.generation;
      // Install the completion waiter and origin latch before crossing RPC.
      const ended = new Promise<void>((resolve) => { this.completions.set(runId,resolve); });
      this.awaitingStart.set(thread.id,{runId,generation});
      this.store.markDispatch(runId,session.id,generation);
      dispatched = true;
      this.assistantBuffers.set(runId,'');
      this.toolsByRun.set(runId,new Map());
      await session.prompt(text);
      if (this.awaitingStart.get(thread.id)?.runId === runId && this.dispatchCollisions.delete(runId)) {
        await this.interruptUncertain(runId, thread.id, 'A scheduled main turn consumed the prompt as steer; execution outcome unknown');
      }
      await ended;
    } catch (error) {
      if (dispatched) await this.interruptUncertain(runId,thread.id,`Dispatch outcome unknown: ${errorMessage(error)}`);
      else this.failRun(runId,thread.id,errorMessage(error),error);
    } finally {
      const open = this.openSessions.get(thread.id);
      if (open !== undefined) open.lastUsedAt = this.now();
    }
  }

  private finishRun(
    runId: string,
    threadId: string,
    status: Extract<RunStatus, 'done' | 'failed' | 'cancelled'>,
  ): RunRecord | undefined {
    const current = this.store.getRun(runId);
    if (current === undefined || !isActiveRun(current.status)) return current;
    const error = status === 'failed' ? (this.errorsByRun.get(runId) ?? current.error) : null;
    const updated = this.store.updateRunStatus(runId, status, { error });
    // The turn is over: release the thread's active-run marker here rather
    // than in `executeRun`, which returns long before the turn ends.
    if (this.activeRunByThread.get(threadId) === runId) {
      this.activeRunByThread.delete(threadId);
    }
    this.flushAssistantMessage(runId, threadId);
    this.expireRunInbox(runId);
    // A relay run lands the hand-off answer in the source conversation; a
    // normal run settles only the hand-offs it was created for.
    if (this.store.getHandoffByRelayRun(runId) !== undefined) {
      if (status === 'done') {
        const relayed = this.store.completeHandoffRelay(runId);
        if (relayed !== undefined) this.publishHandoff(relayed);
      } else {
        // The answer never reached the source conversation; keep it retryable.
        this.store.markHandoffRelayFailed(runId, error ?? `relay ${status}`);
      }
    } else {
      this.settleHandoffsForRun(
        runId,
        threadId,
        status === 'done'
          ? { ok: true }
          : {
              ok: false,
              error: error ?? (status === 'cancelled' ? 'the run was cancelled' : 'the run failed'),
            },
      );
    }
    if (updated !== undefined) {
      this.publishRun(updated);
      this.store.appendAudit({
        actor: updated.botId,
        initiator: 'person',
        action: status === 'failed' ? 'run.failed' : `run.${status}`,
        decision: status,
        botId: updated.botId,
        threadId,
        payload: { runId, error },
      });
      this.publishBot(updated.botId);
    }
    this.assistantBuffers.delete(runId);
    this.assistantMessageIds.delete(runId);
    this.toolsByRun.delete(runId);
    this.errorsByRun.delete(runId);
    // The provider may deliver a complete message instead of streamed deltas,
    // and the UI refetches as soon as the run turns done. Rehydrate after the
    // active-run marker is cleared and announce the thread once more, so the
    // final assistant message lands without a manual refresh.
    if (this.awaitingStart.get(threadId)?.runId === runId) this.awaitingStart.delete(threadId);
    this.persistTranscript(threadId);
    void this.refreshTranscript(threadId).finally(() => {
      this.completions.get(runId)?.();
      this.completions.delete(runId);
      this.kickQueue();
    });
    return updated;
  }

  /**
   * Post a person message into a room.
   *
   * Every `@name` that matches a member is queued in that member's own room
   * thread; no valid mention goes to the lead (or the first member). A mention
   * that matches nobody falls back to the lead instead of failing the post.
   */
  promptRoom(
    roomId: string,
    text: string,
    options: { readonly requestKey?: string; readonly attachments?: readonly Attachment[] } = {},
  ): { roomMessage: RoomMessageRecord; runId: string; runIds: readonly string[] } {
    const requestKey = options.requestKey;
    const attachments = normalizeAttachments(options.attachments);
    const room = this.store.requireRoom(roomId);
    if (requestKey !== undefined) {
      const existing = this.store.findRoomMessageByRequest(roomId, requestKey);
      if (existing !== undefined) {
        if (existing.content !== text) {
          throw new RuntimeError('room.request_conflict', 'This request key belongs to a different message', 409);
        }
        // Same key means the same request: never duplicate the Bots' work.
        return {
          roomMessage: existing,
          runId: existing.runId ?? '',
          runIds: existing.runId === null ? [] : [existing.runId],
        };
      }
    }
    // Context is captured before the new message joins the room, so the
    // speaker list is what the other Bots actually saw.
    const context = this.store.roomTranscript(roomId);
    const members = room.memberIds
      .map((id) => this.store.getBot(id))
      .filter((bot): bot is BotRecord => bot !== undefined);
    const lead =
      room.leadBotId === null
        ? undefined
        : members.find((bot) => bot.id === room.leadBotId);
    const fallback = lead ?? members[0];
    if (fallback === undefined) {
      throw new RuntimeError('room.no_available_bot', 'Room has no Bots left', 409);
    }

    const targets = resolveRoomTargets(members, fallback, text).filter((bot) => !bot.paused);
    if (targets.length === 0) {
      throw new RuntimeError('room.no_available_bot', 'Every addressed Bot is paused', 409);
    }
    let roomMessage = this.store.appendRoomMessage({
      roomId,
      speakerKind: 'user',
      speakerId: 'person',
      content: text,
      via: 'direct',
      roomRequestId: requestKey ?? null,
      attachments,
    });
    this.hub.publish({
      botId: targets[0]?.id ?? fallback.id,
      roomId,
      type: 'room.message',
      data: roomMessage,
    });

    const runIds: string[] = [];
    const failures: string[] = [];
    for (const target of targets) {
      try {
        let threadId = this.store.getRoomThread(roomId, target.id);
        if (threadId === undefined) {
          const thread = this.store.createThread(target.id, { title: `# ${room.name}` });
          this.store.setRoomThread(roomId, target.id, thread.id);
          threadId = thread.id;
        }
        const envelope =
          context.trim().length === 0
            ? text
            : `Shared conversation in #${room.name} (oldest first; reference only):\n${context}\n\nNew message from person:\n${text}`;
        const started = this.prompt(threadId, { text: envelope, mode: 'queue', attachments });
        runIds.push(started.runId);
        if (runIds.length === 1) {
          this.store.setRoomMessageRun(roomMessage.id, started.runId);
          roomMessage = { ...roomMessage, runId: started.runId };
        }
      } catch (error) {
        failures.push(`${target.name}: ${errorMessage(error)}`);
      }
    }
    const [first] = runIds;
    if (first === undefined) {
      throw new RuntimeError('room.prompt_failed', failures.join('; ') || 'No Bot accepted the message', 409);
    }
    return { roomMessage, runId: first, runIds };
  }

  /** Write the last assistant answer of a room thread back into the room. */
  private appendRoomReply(threadId: string): void {
    const mapping = this.store.getRoomThreadByThreadId(threadId);
    if (mapping === undefined) return;
    const messages = this.transcripts.get(threadId);
    if (messages === undefined) return;
    const last = messages.findLast(
      (message) => message.role === 'assistant' && message.content.trim().length > 0,
    );
    if (last === undefined) return;
    // A relay run speaks an answer that came from another Bot; the room shows that
    // attribution instead of presenting it as a direct reply.
    const relayed = last.runId === undefined ? undefined : this.store.getHandoffByRelayRun(last.runId);
    const roomMessage = this.store.appendRoomMessage({
      roomId: mapping.roomId,
      speakerKind: 'bot',
      speakerId: mapping.botId,
      content: last.content,
      via: relayed === undefined ? 'direct' : 'handoff',
      answeredBy: mapping.botId,
      sourceMessageId: last.id,
    });
    this.hub.publish({
      botId: mapping.botId,
      roomId: mapping.roomId,
      type: 'room.message',
      data: roomMessage,
    });
  }

  private async refreshTranscript(threadId: string): Promise<void> {
    try {
      await this.hydrate(threadId);
      this.appendRoomReply(threadId);
      const thread = this.store.getThread(threadId);
      if (thread !== undefined) {
        this.hub.publish({
          botId: thread.botId,
          threadId,
          type: 'thread.updated',
          data: thread,
        });
      }
    } catch {
      // A refresh failure must not turn a finished run into a failure.
    }
  }

  private failRun(runId: string, threadId: string, message: string, error?: unknown): void {
    const current = this.store.getRun(runId);
    if (current === undefined || !isActiveRun(current.status)) return;
    this.errorsByRun.set(runId, message);
    this.finishRun(runId, threadId, 'failed');
    if (error !== undefined) {
      this.store.appendAudit({
        actor: current.botId,
        initiator: 'system',
        action: 'run.error',
        decision: 'failed',
        botId: current.botId,
        threadId,
        payload: { runId, message },
      });
    }
  }

  // -------------------------------------------------------------- handoffs

  /**
   * In-band tool execution.
   *
   * The harness forwards every session-registered tool call here; `message_bot`
   * is the only tool this gateway registers. Refusals come back as ordinary
   * output (`isError: false`) so the model reads one sentence and moves on
   * instead of retrying a tool that is working exactly as designed.
   */
  async handleToolCall(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (request.name !== MESSAGE_BOT_TOOL.name) {
      return { output: `Unknown tool: ${request.name ?? request.toolCallId}`, isError: true };
    }
    const sessionId = request.sessionId;
    const thread =
      sessionId === undefined ? undefined : this.store.getThreadByCoreSessionId(sessionId);
    if (thread === undefined) {
      return { output: 'This session is not attached to a Bot thread.', isError: true };
    }
    const runId = this.activeRunByThread.get(thread.id);
    if (runId === undefined) {
      return { output: 'This Bot has no active run to hand off from.', isError: true };
    }
    const fromBot = this.store.getBot(thread.botId);
    if (fromBot === undefined) {
      return { output: 'This session is not attached to a Bot thread.', isError: true };
    }

    if (fromBot.toolPolicy.handoff === false) {
      return { output: `${fromBot.name} is not allowed to hand work to other Bots.`, isError: false };
    }
    const args = isRecord(request.args) ? request.args : {};
    const action = optionalText(args['action']) ?? 'send';
    if (action === 'list') {
      const peers = this.store
        .listBots()
        .filter((bot) => bot.id !== fromBot.id)
        .map((bot) => `${bot.name} (${bot.id}) — ${bot.paused ? 'paused' : 'available'}`);
      return {
        output:
          peers.length === 0
            ? 'No other Bots are available in this workbench.'
            : `Bots you can hand work to:\n${peers.join('\n')}`,
        isError: false,
      };
    }
    if (this.store.getHandoffByRelayRun(runId) !== undefined) {
      return {
        output: 'This turn is relaying a hand-off result and cannot hand off again.',
        isError: false,
      };
    }
    const to = optionalText(args['to']) ?? '';
    const task = optionalText(args['task']) ?? '';
    if (to.length === 0 || task.length === 0) {
      return {
        output: 'message_bot needs a Bot name in `to` and a task to hand over.',
        isError: true,
      };
    }
    const constraints = optionalText(args['constraints']);
    const expecting = optionalText(args['expecting']);

    const refuse = (reason: string, message: string): ToolCallResponse => {
      this.store.appendAudit({
        actor: fromBot.id,
        initiator: 'handoff',
        action: 'handoff.refused',
        decision: 'refused',
        botId: fromBot.id,
        threadId: thread.id,
        payload: { reason, to, runId },
      });
      return { output: message, isError: false };
    };

    const needle = to.trim();
    const matches = this.store
      .listBots()
      .filter(
        (bot) =>
          bot.id === needle ||
          (needle.length > 0 && bot.name.toLowerCase() === needle.toLowerCase()),
      );
    if (matches.length > 1) {
      return refuse(
        'ambiguous_target',
        `Several Bots match "${to}". Address one by its id: ${matches.map((bot) => `${bot.name} (${bot.id})`).join(', ')}.`,
      );
    }
    const target = matches[0];
    if (target === undefined) {
      return refuse('unknown_target', `No Bot named "${to}" in this workbench.`);
    }
    if (target.id === fromBot.id) {
      return refuse('self', 'That is you. Pick another Bot.');
    }
    if (target.paused) {
      return refuse('paused', `${target.name} is paused and cannot take work right now.`);
    }
    if (thread.handoffDepth >= 1) {
      return refuse(
        'depth',
        'This task already came from another Bot; it cannot be handed on again.',
      );
    }
    if (this.store.countHandoffsForRun(runId) >= MAX_HANDOFFS_PER_RUN) {
      return refuse('limit', 'This run has already handed off three times, which is the limit.');
    }

    const idempotencyKey = `${runId}:${target.id}:${sha256(task)}`;
    if (this.store.getHandoffByIdempotencyKey(idempotencyKey) !== undefined) {
      return { output: `That task was already handed to ${target.name}.`, isError: false };
    }

    const toThread = this.handoffThreadFor(target.id, fromBot.name, thread.handoffDepth + 1);
    const { handoff, created } = this.store.createHandoff({
      fromBotId: fromBot.id,
      fromThreadId: thread.id,
      toBotId: target.id,
      toThreadId: toThread.id,
      parentRunId: runId,
      depth: thread.handoffDepth + 1,
      task,
      constraints: constraints ?? null,
      expecting: expecting ?? null,
      idempotencyKey,
    });
    if (!created) {
      return { output: `That task was already handed to ${target.name}.`, isError: false };
    }

    const envelope = [
      `You received this task from ${fromBot.name}, another Bot in the same workbench. The person is not addressing you directly right now.`,
      `Task: ${task}`,
      `Constraints: ${constraints ?? 'none'}`,
      `Expected: ${expecting ?? 'a direct answer'}`,
      `Reply in plain text; your answer is relayed back to ${fromBot.name}.`,
    ].join('\n');
    try {
      const targetRun = this.prompt(toThread.id, { text: envelope, mode: 'queue' });
      this.store.setHandoffTargetRun(handoff.id, targetRun.runId);
    } catch (error) {
      const message = errorMessage(error);
      const failed = this.store.failHandoff(handoff.id, message);
      if (failed !== undefined) this.publishHandoff(failed);
      this.store.appendAudit({
        actor: fromBot.id,
        initiator: 'handoff',
        action: 'handoff.failed',
        decision: 'failed',
        botId: fromBot.id,
        threadId: thread.id,
        payload: { handoffId: handoff.id, toBotId: target.id, message },
      });
      return { output: `${target.name} could not take the task: ${message}`, isError: false };
    }

    this.publishHandoff(handoff);
    this.store.appendAudit({
      actor: fromBot.id,
      initiator: 'handoff',
      action: 'handoff.offered',
      decision: 'queued',
      botId: fromBot.id,
      threadId: thread.id,
      payload: { handoffId: handoff.id, toBotId: target.id, toThreadId: toThread.id, runId },
    });
    return {
      output: `Handed to ${target.name}. Its answer will come back to this conversation.`,
      isError: false,
    };
  }

  /**
   * Reuse the thread this Bot already opened for this sender, so repeated
   * hand-offs from the same Bot stay one conversation; otherwise open one at
   * the next depth.
   */
  private handoffThreadFor(toBotId: string, fromName: string, depth: number): ThreadRecord {
    const title = `handoff from ${fromName}`;
    // Depth is part of the identity: reusing a shallower thread would let a chain
    // run past its cap, because the thread is what carries the depth forward.
    const reusable = this.store
      .listThreads(toBotId)
      .find((thread) => thread.handoffDepth === depth && thread.title === title);
    return reusable ?? this.store.createThread(toBotId, { title, handoffDepth: depth });
  }

  private publishHandoff(handoff: HandoffRecord): void {
    this.hub.publish({
      botId: handoff.fromBotId,
      threadId: handoff.fromThreadId,
      type: 'handoff.updated',
      data: publicHandoff(handoff),
    });
  }

  /**
   * Write the target run's outcome back into every hand-off it received, then
   * give the source Bot one follow-up turn to relay the answer in its own
   * words. A run that never completes leaves its row queued, never lost.
   */
  private settleHandoffsForRun(
    runId: string,
    threadId: string,
    outcome: { readonly ok: true } | { readonly ok: false; readonly error: string },
  ): void {
    const pending = this.store.listPendingHandoffsForRun(runId);
    if (pending.length === 0) {
      this.pumpRelays();
      return;
    }
    void (async () => {
      let answer = '';
      if (outcome.ok) {
        await this.hydrate(threadId).catch(() => []);
        answer = this.assistantTextForRun(threadId, runId);
      }
      for (const handoff of pending) {
        const updated = outcome.ok
          ? this.store.markHandoffAwaitingRelay(handoff.id, answer)
          : this.store.markHandoffFailedPendingRelay(handoff.id, outcome.error);
        if (updated === undefined) continue;
        this.publishHandoff(updated);
        this.store.appendAudit({
          actor: updated.toBotId,
          initiator: 'handoff',
          action: outcome.ok ? 'handoff.answered' : 'handoff.failed',
          decision: updated.status,
          botId: updated.toBotId,
          threadId,
          payload: { handoffId: updated.id, fromBotId: updated.fromBotId },
        });
      }
      this.pumpRelays();
    })();
  }

  /**
   * Deliver every pending answer back to the source conversation. The relay is
   * its own run, so "target finished" and "answer relayed" stay distinguishable
   * across crashes; a relay run cannot hand off again.
   */
  private pumpRelays(): void {
    for (const handoff of this.store.listRelayableHandoffs()) {
      const source = this.store.getBot(handoff.fromBotId);
      const toName = this.store.getBot(handoff.toBotId)?.name ?? 'The other Bot';
      if (source === undefined || this.store.getThread(handoff.fromThreadId) === undefined) {
        this.store.appendAudit({
          actor: 'system',
          initiator: 'handoff',
          action: 'handoff.relay_failed',
          decision: 'failed',
          botId: handoff.fromBotId,
          threadId: handoff.fromThreadId,
          payload: { handoffId: handoff.id, reason: 'source_missing' },
        });
        continue;
      }
      const text =
        handoff.status === 'failed'
          ? `[handoff failed] ${toName} could not finish: ${handoff.error ?? 'unknown error'}`
          : `[handoff result] ${toName} answered:\n${handoff.answer ?? ''}\nRelay it to the person in your own words. Do not call message_bot for this result.`;
      try {
        const relay = this.prompt(handoff.fromThreadId, {
          text,
          mode: 'queue',
        });
        this.store.claimHandoffRelay(handoff.id, relay.runId);
      } catch (error) {
        this.store.appendAudit({
          actor: 'system',
          initiator: 'handoff',
          action: 'handoff.relay_failed',
          decision: 'failed',
          botId: handoff.fromBotId,
          threadId: handoff.fromThreadId,
          payload: { handoffId: handoff.id, message: errorMessage(error) },
        });
      }
    }
  }

  /** The last assistant text a thread produced, empty when it said nothing. */
  /** The answer belonging to this exact run, not just the thread's latest text. */
  private assistantTextForRun(threadId: string, runId: string): string {
    return answerForRun(this.transcripts.get(threadId) ?? [], runId);
  }

  private lastAssistantText(threadId: string): string {
    const messages = this.transcripts.get(threadId) ?? [];
    const last = messages.findLast(
      (message) => message.role === 'assistant' && message.content.trim().length > 0,
    );
    return last?.content.trim() ?? '';
  }

  private followUpSource(handoff: HandoffRecord, text: string): void {
    if (this.store.getThread(handoff.fromThreadId) === undefined) return;
    try {
      this.prompt(handoff.fromThreadId, { text, mode: 'queue' });
    } catch (error) {
      this.store.appendAudit({
        actor: handoff.fromBotId,
        initiator: 'handoff',
        action: 'handoff.followup_failed',
        decision: 'failed',
        botId: handoff.fromBotId,
        threadId: handoff.fromThreadId,
        payload: { handoffId: handoff.id, message: errorMessage(error) },
      });
    }
  }

  /** A relay run must not start another hand-off: it exists to speak the answer. */

  // -------------------------------------------------------------- sessions

  /** Refresh the Bot's self-description and peer roster before a turn. */
  private async applyIdentity(
    session: BotSession,
    bot: BotRecord,
    thread: ThreadRecord,
  ): Promise<void> {
    const peers = this.store.listBots().filter((entry) => entry.id !== bot.id);
    const room = this.store.getRoomThreadByThreadId(thread.id);
    const roomName = room === undefined ? undefined : this.store.getRoom(room.roomId)?.name;
    await session.setRuntimeSystemPrompt({
      append: identityPrompt(bot, thread, peers, roomName),
    });
  }

  private async applyConfig(
    session: BotSession,
    bot: BotRecord,
    thread: ThreadRecord,
  ): Promise<void> {
    if (bot.model !== null) await session.setModel(bot.model);
    if (bot.thinking !== null) await session.setThinking(bot.thinking);
    await session.setPermission(bot.permission as 'bot' | 'auto');
    // An empty allow list means "no override"; never translate it to [].
    if ((bot.toolPolicy.allow?.length ?? 0) > 0) {
      await session.setActiveTools(bot.toolPolicy.allow ?? []);
    }
    this.store.setThreadAppliedRevision(thread.id, bot.configRevision);
  }

  private async ensureSession(bot: BotRecord, thread: ThreadRecord): Promise<BotSession> {
    const opening = this.openingSessions.get(thread.id);
    if (opening !== undefined) return opening;
    const existing = this.openSessions.get(thread.id);
    if (existing !== undefined) {
      existing.lastUsedAt = this.now();
      return existing.session;
    }

    const promise = (async () => {
      const session = await this.sessions.open(bot, thread);
      if (this.closed || this.deletingThreads.has(thread.id) || this.deletingBots.has(bot.id)) {
        await session.close({extractMemories:false});
        throw new RuntimeError('thread.closed','Thread closed while opening',409);
      }
      const generation = randomUUID();
      if (thread.coreSessionId === null) {
        this.store.updateThread(thread.id, { coreSessionId: session.id });
      }
      session.setApprovalHandler((request) => this.onApprovalRequest(bot.id, thread.id, request));
      session.setQuestionHandler((request) => this.onQuestionRequest(bot.id, thread.id, request));
      const unsubscribe = session.onEvent((event) => {
        if (this.openSessions.get(thread.id)?.generation !== generation) return;
        this.onSessionEvent(bot.id, thread.id, event);
      });
      this.openSessions.set(thread.id, {
        generation,
        session,
        botId: bot.id,
        lastUsedAt: this.now(),
        unsubscribe,
      });
      try {
        // Observe SDK-triggered work before any asynchronous setup boundary.
        await session.registerTool(MESSAGE_BOT_TOOL);
      await this.applyIdentity(session, bot, thread);
        await this.reconcileTranscript(thread.id, session);
        return session;
      } catch (error) {
        this.openSessions.delete(thread.id);
        unsubscribe();
        await session.close({ extractMemories: false }).catch(() => {});
        throw error;
      }
    })();

    this.openingSessions.set(thread.id, promise);
    try {
      return await promise;
    } finally {
      this.openingSessions.delete(thread.id);
    }
  }

  private onSessionEvent(botId: string, threadId: string, event: SessionEvent): void {
    const open = this.openSessions.get(threadId);
    if (open === undefined || event.sessionId !== open.session.id || event.agentId !== 'main' || this.closed || this.deletingThreads.has(threadId)) return;
    open.lastUsedAt = this.now();
    if (event.type === 'turn.started') {
      const key = `${open.generation}:${event.turnId}`;
      if (this.seenTurns.has(key)) return;
      this.seenTurns.add(key);
      const awaiting = this.awaitingStart.get(threadId);
      let run: RunRecord;
      if (awaiting !== undefined && awaiting.generation === open.generation && event.origin.kind === 'user') {
        run = this.store.getRun(awaiting.runId)!;
        this.awaitingStart.delete(threadId);
      } else {
        if (awaiting !== undefined) this.dispatchCollisions.add(awaiting.runId);
        run = this.store.createRun({botId,threadId,kind:'observed',origin:event.origin});
        this.store.markDispatch(run.id,open.session.id,open.generation);
      }
      this.store.bindTurn(run.id,event.turnId);
      this.activeRunByThread.set(threadId,run.id);
      const started = this.store.updateRunStatus(run.id,'running');
      if (started !== undefined) this.publishRun(started);
      return;
    }
    const runId = this.activeRunByThread.get(threadId);
    const run = runId === undefined ? undefined : this.store.getRun(runId);
    if (run !== undefined && (run.sessionGeneration !== open.generation || ('turnId' in event && event.turnId !== run.turnId))) return;
    switch (event.type) {
      case 'turn.step.started': {
        if (runId === undefined) return;
        this.stepByRun.set(runId,event.stepId ?? `step_${event.step}`);
        return;
      }
      case 'turn.step.completed': {
        if (runId === undefined) return;
        this.flushAssistantMessage(runId,threadId);
        this.assistantBuffers.delete(runId);
        this.assistantMessageIds.delete(runId);
        this.toolsByRun.delete(runId);
        void this.reconcileTranscript(threadId,open.session).catch(() => {});
        return;
      }
      case 'assistant.delta': {
        if (runId === undefined) return;
        const content = (this.assistantBuffers.get(runId) ?? '') + event.delta;
        this.assistantBuffers.set(runId, content);
        const message = this.updateLiveMessage(runId,threadId);
        this.hub.publish({botId,threadId,type:'assistant.delta',data:{runId,messageId:message.id,content,message,version:this.version(threadId)}});
        // A room should show the answer while it is being written, not only
        // when the run ends. Throttled to keep the stream light.
        const room = this.store.getRoomThreadByThreadId(threadId);
        if (room !== undefined) {
          const now = this.now();
          if (now - (this.roomDeltaAt.get(threadId) ?? 0) >= 120) {
            this.roomDeltaAt.set(threadId, now);
            this.hub.publish({
              botId,
              roomId: room.roomId,
              type: 'room.delta',
              data: { botId: room.botId, messageId: message.id, content, runId },
            });
          }
        }
        return;
      }
      case 'tool.call.started': {
        if (runId === undefined) return;
        const tools = this.toolsForRun(runId);
        const tool: ToolCall = {
          id: event.toolCallId,
          name: event.name,
          status: 'running',
          args: event.args,
          startedAt: this.now(),
        };
        tools.set(event.toolCallId, tool);
        const message = this.updateLiveMessage(runId,threadId);
        this.hub.publish({ botId, threadId, type: 'tool.updated', data: { runId, tool, message, version:this.version(threadId) } });
        this.persistTranscript(threadId);
        return;
      }
      case 'tool.progress': {
        if (runId === undefined) return;
        const tools = this.toolsForRun(runId);
        const previous = tools.get(event.toolCallId);
        if (previous === undefined || event.update.text === undefined) return;
        const tool = { ...previous, output: (previous.output ?? '') + event.update.text };
        tools.set(event.toolCallId,tool);
        const message = this.updateLiveMessage(runId,threadId);
        this.hub.publish({botId,threadId,type:'tool.updated',data:{runId,tool,message,version:this.version(threadId)}});
        return;
      }
      case 'tool.result': {
        if (runId === undefined) return;
        const tools = this.toolsForRun(runId);
        const previous = tools.get(event.toolCallId);
        const tool: ToolCall = {
          id: event.toolCallId,
          name: previous?.name ?? event.toolCallId,
          status: event.isError === true ? 'error' : 'done',
          ...(previous?.args === undefined ? {} : { args: previous.args }),
          output: stringifyOutput(event.output),
          startedAt: previous?.startedAt ?? this.now(),
          endedAt: this.now(),
          ...(event.isError === true ? { error: stringifyOutput(event.output) } : {}),
        };
        tools.set(event.toolCallId, tool);
        const message = this.updateLiveMessage(runId,threadId);
        this.hub.publish({ botId, threadId, type: 'tool.updated', data: { runId, tool, message, version:this.version(threadId) } });
        this.persistTranscript(threadId);
        return;
      }
      case 'turn.ended': {
        if (runId === undefined) return;
        if (event.error !== undefined) {
          this.errorsByRun.set(runId, event.error.message);
        }
        const status: 'done' | 'failed' | 'cancelled' =
          event.reason === 'failed' ? 'failed' : event.reason === 'cancelled' ? 'cancelled' : 'done';
        this.finishRun(runId, threadId, status);
        return;
      }
      case 'error': {
        // This event has no turn identity. Only turn.ended.error can authoritatively
        // settle a run; a delayed diagnostic must not poison the next turn.
        return;
      }
      case 'agent.status.updated': {
        this.publishBot(botId);
        return;
      }
      case 'background.task.started':
      case 'background.task.terminated':
      case 'background.task.updated':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
      case 'compaction.started':
      case 'cron.fired':
      case 'goal.updated':
      case 'hook.result':
      case 'mcp.server.status':
      case 'session.meta.updated':
      case 'skill.activated':
      case 'skill_candidate':
      case 'subagent.child_request':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.spawned':
      case 'subagent.started':
      case 'thinking.delta':
      case 'todo.updated':
      case 'tool.call.delta':
      case 'tool.list.updated':
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
      case 'warning':
        return;
    }
  }

  private toolsForRun(runId: string): Map<string, ToolCall> {
    let tools = this.toolsByRun.get(runId);
    if (tools === undefined) {
      tools = new Map();
      this.toolsByRun.set(runId, tools);
    }
    return tools;
  }

  private updateLiveMessage(runId: string, threadId: string): Message {
    let id = this.assistantMessageIds.get(runId);
    if (id === undefined) { id = `msg_${randomUUID()}`; this.assistantMessageIds.set(runId,id); }
    const list = this.messagesForThread(threadId);
    const index = list.findIndex((message) => message.id === id);
    const run = this.store.getRun(runId);
    const message: Message = {id,threadId,role:'assistant',content:this.assistantBuffers.get(runId) ?? '',
      createdAt:list[index]?.createdAt ?? this.now(),runId,turnId:run?.turnId ?? undefined,
      stepId:this.stepByRun.get(runId),origin:run?.origin,toolCalls:[...this.toolsForRun(runId).values()],projectionVersion:this.bumpVersion(threadId)};
    if (index < 0) list.push(message); else list[index] = message;
    return message;
  }

  private publishMessage(botId: string, threadId: string, message: Message): void {
    const version = this.bumpVersion(threadId);
    const updated = {...message,projectionVersion:version};
    const list = this.messagesForThread(threadId);
    const index = list.findIndex((entry) => entry.id === message.id);
    if (index >= 0) list[index] = updated;
    this.hub.publish({botId,threadId,type:'message.created',data:{message:updated,version}});
    this.persistTranscript(threadId);
  }

  private flushAssistantMessage(runId: string, threadId: string): void {
    if (!this.assistantMessageIds.has(runId)) return;
    const message = this.updateLiveMessage(runId,threadId);
    const botId = this.store.getThread(threadId)?.botId;
    if (botId !== undefined) this.publishMessage(botId,threadId,message);
  }

  // ------------------------------------------------------ approvals/questions

  private onApprovalRequest(
    botId: string,
    threadId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> {
    const runId = this.activeRunByThread.get(threadId) ?? null;
    const expiresAt = this.now() + this.approvalTimeoutMs;
    const grantOptions =
      request.grantOptions === undefined || request.grantOptions.length === 0
        ? (['once', 'session'] as const)
        : request.grantOptions;
    const row = this.store.createApproval({
      botId,
      threadId,
      runId,
      requestId: request.toolCallId,
      toolName: request.toolName,
      action: request.action,
      reasons: request.reasons ?? [],
      grantOptions: [...grantOptions],
      expiresAt,
    });
    if (runId !== null) this.markWaiting(runId, threadId);
    this.hub.publish({
      botId,
      threadId,
      type: 'approval.requested',
      data: publicApproval(row),
    });
    this.store.appendAudit({
      actor: botId,
      initiator: 'system',
      action: 'approval.requested',
      decision: 'pending',
      botId,
      threadId,
      payload: { approvalId: row.id, toolName: row.toolName },
    });
    this.publishBot(botId);

    return new Promise<ApprovalResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.expireApproval(row.id);
      }, this.approvalTimeoutMs);
      timer.unref?.();
      this.pendingApprovals.set(row.id, {
        approvalId: row.id,
        runId,
        threadId,
        botId,
        resolve,
        timer,
      });
    });
  }

  private onQuestionRequest(
    botId: string,
    threadId: string,
    request: QuestionRequest,
  ): Promise<QuestionResult> {
    const runId = this.activeRunByThread.get(threadId) ?? null;
    const items: QuestionItem[] = request.questions.map((question, index) => ({
      id: String(index),
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
      multiple: question.multiSelect === true,
      allowOther: question.otherLabel !== undefined,
    }));
    const row = this.store.createQuestion({
      botId,
      threadId,
      runId,
      requestId: request.toolCallId ?? `turn-${String(request.turnId ?? 0)}`,
      items,
      expiresAt: this.now() + this.questionTimeoutMs,
    });
    if (runId !== null) this.markWaiting(runId, threadId);
    this.hub.publish({ botId, threadId, type: 'question.requested', data: publicQuestion(row) });
    this.store.appendAudit({
      actor: botId,
      initiator: 'system',
      action: 'question.requested',
      decision: 'pending',
      botId,
      threadId,
      payload: { questionId: row.id, count: items.length },
    });
    this.publishBot(botId);

    return new Promise<QuestionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.expireQuestion(row.id);
      }, this.questionTimeoutMs);
      timer.unref?.();
      this.pendingQuestions.set(row.id, {
        questionId: row.id,
        runId,
        threadId,
        botId,
        resolve,
        timer,
      });
    });
  }

  private expireApproval(approvalId: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    const row = this.store.expireApproval(approvalId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(approvalId);
      pending.resolve({ decision: 'cancelled' });
      this.resumeRunIfIdle(pending.threadId, pending.runId);
    }
    if (row !== undefined && row.status === 'expired') {
      this.hub.publish({
        botId: row.botId,
        threadId: row.threadId,
        type: 'approval.decided',
        data: publicApproval(row),
      });
      this.store.appendAudit({
        actor: 'gateway',
        initiator: 'system',
        action: 'approval.expired',
        decision: 'expired',
        botId: row.botId,
        threadId: row.threadId,
        payload: { approvalId },
      });
      this.publishBot(row.botId);
    }
  }

  private expireQuestion(questionId: string): void {
    const pending = this.pendingQuestions.get(questionId);
    const row = this.store.expireQuestion(questionId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pendingQuestions.delete(questionId);
      pending.resolve(null);
      this.resumeRunIfIdle(pending.threadId, pending.runId);
    }
    if (row !== undefined && row.status === 'expired') {
      this.hub.publish({
        botId: row.botId,
        threadId: row.threadId,
        type: 'question.answered',
        data: publicQuestion(row),
      });
      this.store.appendAudit({
        actor: 'gateway',
        initiator: 'system',
        action: 'question.expired',
        decision: 'expired',
        botId: row.botId,
        threadId: row.threadId,
        payload: { questionId },
      });
      this.publishBot(row.botId);
    }
  }

  private markWaiting(runId: string, threadId: string): void {
    const updated = this.store.updateRunStatus(runId, 'waiting_user');
    if (updated !== undefined) {
      this.publishRun(updated);
      this.markThreadUnread(threadId);
    }
  }

  private resumeRunIfIdle(threadId: string, runId: string | null): void {
    if (runId === null) return;
    const stillWaiting =
      [...this.pendingApprovals.values()].some((entry) => entry.threadId === threadId) ||
      [...this.pendingQuestions.values()].some((entry) => entry.threadId === threadId);
    if (stillWaiting) return;
    const run = this.store.getRun(runId);
    if (run === undefined || run.status !== 'waiting_user') return;
    const updated = this.store.updateRunStatus(runId, 'running');
    if (updated !== undefined) this.publishRun(updated);
  }

  private expireRunInbox(runId: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.runId !== runId) continue;
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(id);
      const row = this.store.expireApproval(id);
      pending.resolve({ decision: 'cancelled' });
      if (row !== undefined) {
        this.hub.publish({ botId: row.botId, threadId: row.threadId, type: 'approval.decided', data: publicApproval(row) });
      }
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.runId !== runId) continue;
      clearTimeout(pending.timer);
      this.pendingQuestions.delete(id);
      const row = this.store.expireQuestion(id);
      pending.resolve(null);
      if (row !== undefined) {
        this.hub.publish({ botId: row.botId, threadId: row.threadId, type: 'question.answered', data: publicQuestion(row) });
      }
    }
  }

  private expireInboxForThread(threadId: string, reason: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.threadId !== threadId) continue;
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(id);
      const row = this.store.expireApproval(id);
      pending.resolve({ decision: 'cancelled' });
      if (row !== undefined) {
        this.hub.publish({ botId: row.botId, threadId, type: 'approval.decided', data: publicApproval(row) });
        this.store.appendAudit({
          actor: 'person',
          initiator: 'person',
          action: 'approval.expired',
          decision: reason,
          botId: row.botId,
          threadId,
          payload: { approvalId: id },
        });
      }
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.threadId !== threadId) continue;
      clearTimeout(pending.timer);
      this.pendingQuestions.delete(id);
      const row = this.store.expireQuestion(id);
      pending.resolve(null);
      if (row !== undefined) {
        this.hub.publish({ botId: row.botId, threadId, type: 'question.answered', data: publicQuestion(row) });
      }
    }
  }

  // --------------------------------------------------------------- views

  private appendMessage(threadId: string, message: Message): void {
    const list = this.messagesForThread(threadId);
    if (list.some((entry) => entry.id === message.id)) return;
    list.push(message);
    this.transcripts.set(threadId, list);
  }

  private markThreadUnread(threadId: string): void {
    this.store.markThreadUnread(threadId, true);
    const thread = this.store.getThread(threadId);
    if (thread === undefined) return;
    this.hub.publish({ botId: thread.botId, threadId, type: 'thread.updated', data: publicThread(this.store, thread) });
    this.publishBot(thread.botId);
  }

  private publishRun(run: RunRecord): void {
    this.hub.publish({
      botId: run.botId,
      threadId: run.threadId,
      type: 'run.updated',
      data: this.publicRun(run),
    });
  }

  private publicRun(run: RunRecord): Run {
    return {
      id: run.id,
      botId: run.botId,
      threadId: run.threadId,
      status: run.status,
      startedAt: run.startedAt ?? run.createdAt,
      endedAt: run.endedAt,
      error: run.error,
      kind:run.kind,origin:run.origin,requestKey:run.requestKey,dispatchStartedAt:run.dispatchStartedAt,
      retryOfRunId:run.retryOfRunId,recoveryDecision:run.recoveryDecision,recoveryAt:run.recoveryAt,
    };
  }

  publishBot(botId: string): void {
    const bot = this.store.getBot(botId);
    if (bot === undefined) return;
    this.hub.publish({ botId, type: 'bot.updated', data: publicBot(this.store, bot) });
  }

  // -------------------------------------------------------------- helpers

  private async sweepIdleSessions(): Promise<void> {
    if (this.closed || this.idleMs <= 0) return;
    const cutoff = this.now() - this.idleMs;
    for (const [threadId, entry] of Array.from(this.openSessions)) {
      if (entry.lastUsedAt > cutoff) continue;
      if (this.activeRunByThread.has(threadId)) continue;
      if (this.store.activeRunForThread(threadId) !== undefined || this.awaitingStart.has(threadId)) continue;
      try {
        if (entry.session.listBackgroundTasks !== undefined && (await entry.session.listBackgroundTasks({activeOnly:true})).length > 0) continue;
        if (entry.session.listCronTasks !== undefined && (await entry.session.listCronTasks()).length > 0) continue;
      } catch { continue; }
      if (this.activeRunByThread.has(threadId) || this.awaitingStart.has(threadId) || entry.lastUsedAt > cutoff) continue;
      this.openSessions.delete(threadId);
      entry.unsubscribe();
      await entry.session.close({ extractMemories: false }).catch(() => {});
    }
  }

  private requireThread(threadId: string): ThreadRecord {
    const thread = this.store.getThread(threadId);
    if (thread === undefined) {
      throw new RuntimeError('thread.not_found', `Thread not found: ${threadId}`, 404);
    }
    return thread;
  }

  private requireBot(botId: string): BotRecord {
    const bot = this.store.getBot(botId);
    if (bot === undefined) {
      throw new RuntimeError('bot.not_found', `Bot not found: ${botId}`, 404);
    }
    return bot;
  }

  private assertOpen(): void {
    if (this.closed) throw new RuntimeError('gateway.closed', 'Gateway is shutting down', 503);
  }
}

// ------------------------------------------------------------------- views

export function publicBot(store: BotStore, bot: BotRecord): Bot {
  const counters = store.counters().get(bot.id) ?? { unread: 0, needsYou: 0 };
  const last = store.lastDirectMessage(bot.id);
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    rolePrompt: bot.rolePrompt,
    avatarSeed: bot.avatarSeed,
    avatarEmoji: bot.avatarEmoji,
    accentHue: bot.accentHue,
    workspace: bot.workspace,
    model: bot.model ?? undefined,
    thinking: bot.thinking ?? undefined,
    permission: normalizePermission(bot.permission),
    toolPolicy: bot.toolPolicy,
    paused: bot.paused,
    status: store.statusForBot(bot, counters),
    unread: counters.unread,
    needsYou: counters.needsYou,
    lastActiveAt: bot.lastActiveAt,
    lastMessage: last?.content ?? null,
    lastMessageAt: last?.createdAt ?? null,
  };
}

export function publicThread(store: BotStore, thread: ThreadRecord): Thread {
  const active = store.activeRunForThread(thread.id);
  const blocked = thread.blockedByRunId === null ? undefined : store.getRun(thread.blockedByRunId);
  const latest = blocked ?? active ?? store.listRunsForThread(thread.id, 1)[0];
  const bot = store.getBot(thread.botId);
  const applied = thread.appliedConfigRevision;
  const desired = bot?.configRevision ?? 0;
  return {
    id: thread.id,
    botId: thread.botId,
    title: thread.title,
    lastActiveAt: thread.lastActiveAt,
    runStatus: latest?.status ?? null,
    unread: thread.unread,
    archivedAt: thread.archivedAt,
    blockedByRunId: thread.blockedByRunId,
    workspace: thread.workspace,
    appliedConfigRevision: applied,
    configApplyState:
      thread.pinnedRole && applied < desired
        ? 'requires_new_thread'
        : applied >= desired
          ? 'applied'
          : 'pending',
    configError: null,
  };
}

export function publicApproval(row: ApprovalRecord): Approval {
  return {
    id: row.id,
    botId: row.botId,
    threadId: row.threadId,
    runId: row.runId,
    toolName: row.toolName,
    action: row.action,
    reasons: row.reasons,
    grantOptions: row.grantOptions,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export function publicQuestion(row: QuestionRecord): Question {
  return {
    id: row.id,
    botId: row.botId,
    threadId: row.threadId,
    runId: row.runId,
    items: row.items,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export function publicHandoff(row: HandoffRecord): Handoff {
  return {
    id: row.id,
    fromBotId: row.fromBotId,
    toBotId: row.toBotId,
    fromThreadId: row.fromThreadId,
    toThreadId: row.toThreadId,
    task: row.task,
    status: row.status,
    createdAt: row.createdAt,
    error: row.error,
    answer: row.answer,
    completedAt: row.completedAt,
    targetRunId: row.targetRunId,
    relayRunId: row.relayRunId,
    relayStatus: row.relayStatus as RelayStatus | null,
  };
}

// -------------------------------------------------------------- projection

/**
 * Project core session history into wire messages.
 *
 * History carries no wall clock, so `createdAt` is null for hydrated entries —
 * array order is the ordering contract. Tool results are folded back into the
 * assistant message that requested them.
 */
export function projectHistory(history: readonly ContextMessage[], threadId: string, coreSessionId = 'legacy'): Message[] {
  const messages: Message[] = [];
  const toolLocations = new Map<string, { messageIndex: number; toolIndex: number }>();

  for (const [index, entry] of history.entries()) {
    if (entry.role === 'user') {
      const content = textOf(entry.content);
      if (content.length === 0) continue;
      // Platform reminders (MCP/tool guidance) are runtime instructions, not
      // something the person typed. They stay in the model context but never
      // appear in the Bot transcript.
      if (content.trimStart().startsWith('<system-reminder>')) continue;
      messages.push({
        id: `core:${threadId}:${coreSessionId}:${entry.id ?? `legacy_${index}`}`,
        coreSessionId,
        coreMessageId: entry.id ?? `legacy_${index}`,
        origin:entry.origin,
        threadId,
        role: 'user',
        content,
        createdAt: null,
      });
      continue;
    }
    if (entry.role === 'assistant') {
      const content = textOf(entry.content);
      const toolCalls: ToolCall[] = (entry.toolCalls ?? []).map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        status: 'done' as const,
        args: parseToolArgs(toolCall.arguments),
        startedAt: 0,
      }));
      if (content.length === 0 && toolCalls.length === 0) continue;
      const messageIndex = messages.length;
      messages.push({
        id: `core:${threadId}:${coreSessionId}:${entry.id ?? `legacy_${index}`}`,
        coreSessionId,
        coreMessageId: entry.id ?? `legacy_${index}`,
        origin:entry.origin,
        threadId,
        role: 'assistant',
        content,
        createdAt: null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      toolCalls.forEach((toolCall, toolIndex) => {
        toolLocations.set(toolCall.id, { messageIndex, toolIndex });
      });
      continue;
    }
    if (entry.role === 'tool' && entry.toolCallId !== undefined) {
      const location = toolLocations.get(entry.toolCallId);
      if (location === undefined) continue;
      const message = messages[location.messageIndex];
      if (message?.toolCalls === undefined) continue;
      const previous = message.toolCalls[location.toolIndex];
      if (previous === undefined) continue;
      const output = textOf(entry.content);
      const nextTools = [...message.toolCalls];
      nextTools[location.toolIndex] = {
        ...previous,
        status: entry.isError === true ? 'error' : 'done',
        output,
        endedAt: 0,
        ...(entry.isError === true ? { error: output } : {}),
      };
      messages[location.messageIndex] = { ...message, toolCalls: nextTools };
    }
  }
  return messages;
}

function textOf(content: ContextMessage['content']): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text.length > 0) parts.push(part.text);
  }
  return parts.join('\n');
}

function parseToolArgs(raw: string | null): unknown {
  if (raw === null || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  if (Array.isArray(output)) {
    const text = output
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : undefined,
      )
      .filter((part): part is string => part !== undefined)
      .join('\n');
    return text.length > 0 ? text : JSON.stringify(output);
  }
  try {
    return JSON.stringify(output);
  } catch {
    return inspect(output);
  }
}

function toSdkQuestionResult(row: QuestionRecord): QuestionResult {
  const answers = row.answers;
  if (answers === null || Object.keys(answers).length === 0) return null;
  const result: Record<string, string | true> = {};
  for (const item of row.items) {
    const raw = answers[item.id] ?? answers[item.question];
    if (raw === undefined) continue;
    const value = typeof raw === 'string' ? raw : raw.join(', ');
    if (value.length === 0) continue;
    result[item.question] = value;
  }
  return Object.keys(result).length === 0 ? null : { answers: result };
}

function toSdkApprovalResponse(decision: ApprovalDecision, feedback?: string): ApprovalResponse {
  if (decision === 'deny') {
    return { decision: 'rejected', ...(feedback === undefined ? {} : { feedback }) };
  }
  return decision === 'allow_session'
    ? { decision: 'approved', scope: 'session', ...(feedback === undefined ? {} : { feedback }) }
    : { decision: 'approved', ...(feedback === undefined ? {} : { feedback }) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
