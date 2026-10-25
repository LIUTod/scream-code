/**
 * Scream Bot wire contract.
 *
 * The gateway owns bots, threads, runs, approvals, questions, handoffs and
 * rooms. The UI consumes only these shapes over REST + SSE; it never reads
 * core session types directly, so the transport can change without touching
 * components.
 */

export type BotStatus = 'idle' | 'working' | 'needs_you' | 'paused' | 'error';
/** Bot permission is two-tier: `bot` (safe, reversible only) or `auto` (full).
 * Any other stored value is normalised to `bot`; there is no third tier. */
export type BotPermission = 'auto' | 'bot';
export type RunStatus = 'queued' | 'running' | 'waiting_user' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type RecoveryDecision = 'continue_queue' | 'retry' | 'cancel_queue';
export type RunKind = 'prompt' | 'observed';
export type MessageRole = 'user' | 'assistant' | 'system';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';
export type HandoffStatus = 'queued' | 'running' | 'awaiting_relay' | 'delivered' | 'failed' | 'refused' | 'interrupted' | 'cancelled';
export type RelayStatus = 'pending' | 'claimed' | 'delivered' | 'failed' | 'interrupted';
export type ConfigApplyState = 'pending' | 'applied' | 'failed' | 'requires_new_thread';
export interface BotConfigResult {
  readonly revision: number;
  readonly threads: readonly { readonly threadId: string; readonly state: ConfigApplyState; readonly appliedRevision: number; readonly error: string | null }[];
}
export type RoomSpeakerKind = 'user' | 'bot' | 'system';
export type RoomMessageVia = 'direct' | 'handoff';

export interface ToolPolicy {
  /** Tool name patterns the bot may use. Undefined = all core defaults. */
  readonly allow?: readonly string[];
  /** Tool name patterns the bot may never use. Deny wins over allow. */
  readonly deny?: readonly string[];
  /** Whether this bot may use `message_bot`. */
  readonly handoff?: boolean;
}

export interface Bot {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly rolePrompt: string;
  readonly avatarSeed: string;
  readonly workspace: string;
  readonly model: string | undefined;
  readonly thinking: string | undefined;
  readonly permission: BotPermission;
  readonly toolPolicy: ToolPolicy;
  readonly paused: boolean;
  readonly status: BotStatus;
  readonly unread: number;
  readonly needsYou: number;
  readonly lastActiveAt: number | null;
  /** Newest message in this Bot's 1:1 history, for the roster preview. */
  readonly lastMessage?: string | null;
  readonly lastMessageAt?: number | null;
  readonly configRevision?: number;
}

export interface Thread {
  readonly id: string;
  readonly botId: string;
  readonly title: string;
  readonly lastActiveAt: number;
  readonly runStatus: RunStatus | null;
  readonly unread: number;
  readonly archivedAt: number | null;
  readonly blockedByRunId?: string | null;
  readonly workspace?: string;
  readonly appliedConfigRevision?: number;
  readonly configApplyState?: ConfigApplyState;
  readonly configError?: string | null;
}

export interface Run {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly error: string | null;
  readonly kind?: RunKind;
  readonly origin?: unknown;
  readonly requestKey?: string | null;
  readonly dispatchStartedAt?: number | null;
  readonly retryOfRunId?: string | null;
  readonly recoveryDecision?: RecoveryDecision | null;
  readonly recoveryAt?: number | null;
  readonly roomRequestId?: string | null;
  readonly roomId?: string | null;
  readonly handoffId?: string | null;
  readonly relayHandoffId?: string | null;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly status: 'running' | 'done' | 'error';
  readonly args?: unknown;
  readonly output?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly error?: string;
}

export interface Handoff {
  readonly id: string;
  readonly fromBotId: string;
  readonly toBotId: string;
  readonly fromThreadId: string;
  readonly toThreadId: string | null;
  readonly task: string;
  readonly status: HandoffStatus;
  readonly createdAt: number;
  readonly error: string | null;
  /** The target Bot's final answer, filled in when the hand-off completes. */
  readonly answer: string | null;
  readonly completedAt: number | null;
  readonly targetRunId?: string | null;
  readonly relayRunId?: string | null;
  readonly relayStatus?: RelayStatus | null;
}

/** A file the person handed to a Bot; `path` is relative to the Bot workspace. */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mime: string;
}

export interface Message {
  readonly id: string;
  readonly threadId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: number | null;
  readonly coreSessionId?: string;
  readonly coreMessageId?: string;
  readonly runId?: string;
  readonly turnId?: number;
  readonly stepId?: string;
  readonly origin?: unknown;
  readonly projectionVersion?: number;
  readonly toolCalls?: readonly ToolCall[];
  readonly handoff?: Handoff;
  readonly attachments?: readonly Attachment[];
}

export interface Approval {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly toolName: string;
  readonly action: string;
  readonly reasons: readonly string[];
  readonly grantOptions: readonly ('once' | 'session')[];
  readonly status: ApprovalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Set when the thread backing this approval belongs to a room. */
  readonly roomId?: string | null;
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly QuestionOption[];
  readonly multiple: boolean;
  readonly allowOther: boolean;
}

export interface Question {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly items: readonly QuestionItem[];
  readonly status: 'pending' | 'answered' | 'expired';
  readonly createdAt: number;
  /** Set when the thread backing this question belongs to a room. */
  readonly roomId?: string | null;
}

export interface Room {
  readonly id: string;
  readonly name: string;
  readonly leadBotId: string | null;
  readonly memberIds: readonly string[];
  readonly createdAt: number;
  /** Newest message in the room, for the roster preview. */
  readonly lastMessage?: string | null;
  readonly lastMessageAt?: number | null;
  readonly lastSpeakerKind?: RoomSpeakerKind | null;
}

export interface RoomMessage {
  readonly roomRequestId?: string | null;
  readonly runId?: string | null;
  readonly sourceMessageId?: string | null;
  readonly speakerName?: string;
  readonly id: string;
  readonly roomId: string;
  readonly speakerKind: RoomSpeakerKind;
  readonly speakerId: string;
  readonly content: string;
  readonly via: RoomMessageVia;
  readonly answeredBy: string | null;
  readonly createdAt: number;
  readonly attachments?: readonly Attachment[];
}

export interface AuditEntry {
  readonly id: number;
  readonly actor: string;
  readonly initiator: 'person' | 'handoff' | 'routine' | 'system';
  readonly action: string;
  readonly payload?: unknown;
  readonly decision: string | null;
  readonly botId: string | null;
  readonly threadId: string | null;
  readonly createdAt: number;
}

export interface TranscriptSnapshot {
  readonly epoch: string;
  readonly threadId: string;
  readonly version: number;
  readonly messages: readonly Message[];
}

/** Process epoch + workbench-global sequence, never a per-Bot cursor. */
export interface ServerEvent {
  readonly epoch: string;
  readonly seq: number;
  readonly type:
    | 'resync'
    | 'bot.updated'
    | 'thread.updated'
    | 'run.updated'
    | 'message.created'
    | 'assistant.delta'
    | 'tool.updated'
    | 'approval.requested'
    | 'approval.decided'
    | 'question.requested'
    | 'question.answered'
    | 'handoff.updated'
    | 'room.message'
    | 'room.delta';
  readonly botId?: string;
  readonly threadId?: string;
  readonly roomId?: string;
  readonly data: unknown;
}

export interface CreateBotInput {
  readonly name: string;
  readonly title?: string;
  readonly rolePrompt?: string;
  readonly workspace: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: BotPermission;
  readonly toolPolicy?: ToolPolicy;
}

export interface UpdateBotInput {
  readonly name?: string;
  readonly title?: string;
  readonly rolePrompt?: string;
  readonly workspace?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: BotPermission;
  readonly toolPolicy?: ToolPolicy;
  readonly paused?: boolean;
}

export interface CreateThreadInput {
  readonly title?: string;
}

export interface PromptInput {
  readonly text: string;
  readonly mode?: 'steer' | 'queue';
  readonly attachments?: readonly Attachment[];
  readonly requestKey?: string;
}

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly feedback?: string;
}

export interface QuestionResponse {
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
}

export interface CreateRoomInput {
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly leadBotId?: string;
}

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

/** Options accepted by the Bot gateway entry point (CLI + tests). */
export interface BotServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly model?: string;
  readonly permission?: BotPermission;
  readonly skillsDirs?: readonly string[];
  readonly lan?: boolean;
  readonly token?: string;
  readonly idleMinutes?: number;
  /** Override the Scream home for tests; production uses the default. */
  readonly homeDir?: string;
  readonly configPath?: string;
}

export interface BotServerHandle {
  readonly url: string;
  close(): Promise<void>;
}
