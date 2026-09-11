import { ref, computed, type ComputedRef, type Ref } from 'vue';
import type {
  ApprovalRequest,
  ChatMessage,
  ExperimentalFlagMap,
  GitStatus,
  GoalSnapshot,
  LikePreferences,
  McpServerInfo,
  McpStartupMetrics,
  ModelInfo,
  PluginInfo,
  PluginSummary,
  ScreamConfig,
  SessionListItem,
  SessionPlan,
  SessionStatus,
  SkillSummary,
  BackgroundTaskInfo,
  TodoItem,
  WsMessage,
} from '../../types';
import { useToast } from '../useToast';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'idle';

export const API_BASE = '/api/v1';
const HEARTBEAT_TIMEOUT_MS = 2 * 30000;
/** Auto-reconnect gives up after this many consecutive failures; the
 *  connection banner's manual retry re-arms the budget via reconnectNow(). */
export const MAX_RECONNECT_ATTEMPTS = 8;

export { HEARTBEAT_TIMEOUT_MS };

export type WsHandler = (msg: WsMessage) => void;

/** Register a WS-frame handler for one message type. Domains register their
 *  handlers during module assembly; dispatch looks them up by frame type. */
export function onWsMessage<T extends WsMessage['type']>(
  s: ClientSharedState,
  type: T,
  fn: (msg: Extract<WsMessage, { type: T }>) => void,
): void {
  s.wsHandlers.set(type, fn as WsHandler);
}

/** Mutable per-instance state shared explicitly between the domain modules.
 *  Everything that more than one domain reads or writes lives here (refs and
 *  plain counters alike) so modules never share state through module-level
 *  singletons. */
export interface ClientSharedState {
  // ── Reactive state (facade exposure) ──────────────────────────────────
  connectionStatus: Ref<ConnectionStatus>;
  messages: Ref<ChatMessage[]>;
  /** Older history exists beyond the loaded window. */
  olderAvailable: Ref<boolean>;
  /** Seq cursor of the oldest loaded message (before-cursor for older pages). */
  oldestSeq: Ref<number | undefined>;
  pendingApprovals: Ref<ApprovalRequest[]>;
  status: Ref<SessionStatus>;
  goal: Ref<GoalSnapshot | null>;
  todos: Ref<TodoItem[]>;
  goalRequestPending: Ref<boolean>;
  goalRequestError: Ref<string | null>;
  promptPending: Ref<boolean>;
  error: Ref<string | null>;
  sessionId: Ref<string | null>;
  workDir: Ref<string | null>;
  isBusy: ComputedRef<boolean>;
  sessions: Ref<SessionListItem[]>;
  currentSessionId: Ref<string | null>;
  isArchived: ComputedRef<boolean>;
  gitStatus: Ref<GitStatus | null>;
  models: Ref<ModelInfo[]>;
  like: Ref<LikePreferences>;
  // Session-control / resource / global state mirrors (server.ts exposure).
  sessionPlan: Ref<SessionPlan | null>;
  skills: Ref<SkillSummary[]>;
  plugins: Ref<PluginSummary[]>;
  pluginInfo: Ref<PluginInfo | null>;
  mcpServers: Ref<McpServerInfo[]>;
  mcpStartupMetrics: Ref<McpStartupMetrics | null>;
  backgroundTasks: Ref<BackgroundTaskInfo[]>;
  backgroundTaskOutput: Ref<string>;
  config: Ref<ScreamConfig | null>;
  experimentalFlags: Ref<ExperimentalFlagMap | null>;
  preflightOk: Ref<boolean>;
  /** Non-exposed mirror of whether the current session is active (drives isArchived). */
  sessionActive: Ref<boolean>;

  // ── Connection bookkeeping ────────────────────────────────────────────
  ws: WebSocket | null;
  heartbeatTimer: number | null;
  reconnectTimer: number | null;
  snapshotRetryTimer: number | null;
  lastPongAt: number;
  seq: number;
  epoch: number;
  reconnectAttempt: number;
  sessionGeneration: number;
  connectionGeneration: number;
  promptGeneration: number;
  liveGeneration: number;
  sessionMutationGeneration: number;
  goalMutationGeneration: number;
  goalAwaitingMutation: { generation: number } | null;
  goalRequestInFlight: boolean;
  snapshotRetryGoalGeneration: number | null;
  pendingPromptAccepted: boolean;
  disposed: boolean;
  sentMessageIds: Map<string, { messageId: string; connectionGeneration: number; queueText?: string }>;

  // ── Per-turn runtime stats ────────────────────────────────────────────
  turnNumber: number;
  turnStartAt: number;
  turnFirstTokenAt: number | null;
  activeToolMs: number;

  // ── Streaming coalescing buffers ──────────────────────────────────────
  streamDisposed: boolean;
  pendingAssistantDelta: string;
  pendingThinkingDelta: string;
  pendingToolProgress: Map<string, string>;

  // ── WS dispatch registry ──────────────────────────────────────────────
  wsHandlers: Map<string, WsHandler>;
}

export function createClientSharedState(): ClientSharedState {
  const connectionStatus = ref<ConnectionStatus>('connecting');
  const messages = ref<ChatMessage[]>([]);
  const olderAvailable = ref(false);
  const oldestSeq = ref<number | undefined>(undefined);
  const pendingApprovals = ref<ApprovalRequest[]>([]);
  const status = ref<SessionStatus>({ busy: false });
  const goal = ref<GoalSnapshot | null>(null);
  const todos = ref<TodoItem[]>([]);
  const goalRequestPending = ref(false);
  const goalRequestError = ref<string | null>(null);
  const promptPending = ref(false);
  const error = ref<string | null>(null);
  const sessionId = ref<string | null>(null);
  const workDir = ref<string | null>(null);
  const sessions = ref<SessionListItem[]>([]);
  const currentSessionId = ref<string | null>(null);
  const sessionActive = ref(false);
  const isBusy = computed(() => status.value.busy || promptPending.value);
  const isArchived = computed(() => sessionId.value !== null && !sessionActive.value);
  const gitStatus = ref<GitStatus | null>(null);
  const models = ref<ModelInfo[]>([]);
  const like = ref<LikePreferences>({});
  // Session-control / resource / global state mirrors (server.ts exposure).
  const sessionPlan = ref<SessionPlan | null>(null);
  const skills = ref<SkillSummary[]>([]);
  const plugins = ref<PluginSummary[]>([]);
  const pluginInfo = ref<PluginInfo | null>(null);
  const mcpServers = ref<McpServerInfo[]>([]);
  const mcpStartupMetrics = ref<McpStartupMetrics | null>(null);
  const backgroundTasks = ref<BackgroundTaskInfo[]>([]);
  const backgroundTaskOutput = ref('');
  const config = ref<ScreamConfig | null>(null);
  const experimentalFlags = ref<ExperimentalFlagMap | null>(null);
  const preflightOk = ref(false);

  return {
    connectionStatus,
    messages,
    olderAvailable,
    oldestSeq,
    pendingApprovals,
    status,
    goal,
    todos,
    goalRequestPending,
    goalRequestError,
    promptPending,
    error,
    sessionId,
    workDir,
    isBusy,
    sessions,
    currentSessionId,
    isArchived,
    gitStatus,
    models,
    like,
    sessionPlan,
    skills,
    plugins,
    pluginInfo,
    mcpServers,
    mcpStartupMetrics,
    backgroundTasks,
    backgroundTaskOutput,
    config,
    experimentalFlags,
    preflightOk,
    sessionActive,
    ws: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    snapshotRetryTimer: null,
    lastPongAt: Date.now(),
    seq: 0,
    epoch: 0,
    reconnectAttempt: 0,
    sessionGeneration: 0,
    connectionGeneration: 0,
    promptGeneration: 0,
    liveGeneration: 0,
    sessionMutationGeneration: 0,
    goalMutationGeneration: 0,
    goalAwaitingMutation: null,
    goalRequestInFlight: false,
    snapshotRetryGoalGeneration: null,
    pendingPromptAccepted: false,
    disposed: false,
    sentMessageIds: new Map<string, { messageId: string; connectionGeneration: number; queueText?: string }>(),
    turnNumber: 0,
    turnStartAt: 0,
    turnFirstTokenAt: null,
    activeToolMs: 0,
    streamDisposed: false,
    pendingAssistantDelta: '',
    pendingThinkingDelta: '',
    pendingToolProgress: new Map<string, string>(),
    wsHandlers: new Map<string, WsHandler>(),
  };
}

/** Cross-domain runtime registry. The domain factories in
 *  useScreamWebClient() install every method before connect() runs; nothing
 *  may call a registry method before assembly completes (the cast below is
 *  the single deliberate seam that keeps the modules decoupled without
 *  module-level singletons). */
export interface ClientContext {
  s: ClientSharedState;
  showToast: ReturnType<typeof useToast>['showToast'];
  connect(): void;
  send(obj: Record<string, unknown>): void;
  stopHeartbeat(): void;
  setConnectionStatus(status: ConnectionStatus): void;
  fetchSessions(): Promise<void>;
  fetchGitStatus(): Promise<void>;
  fetchModels(): Promise<void>;
  fetchSnapshot(goalGeneration?: number): Promise<void>;
  activateSession(targetSessionId: string): Promise<boolean>;
  appendSystemMessage(text: string): void;
  resetGoalRequestState(): void;
  syncGoalRequestPending(): void;
  onEvent(payload: { type: string; [key: string]: unknown }): void;
  flushQueue(): void;
  flushQueueNext(): void;
  enqueueOfflinePrompt(text: string): void;
  removeOfflineQueueItem(text: string): void;
  recordRecentPrompt(text: string): void;
  postSessionAction(path: string, body?: Record<string, unknown>): Promise<boolean>;
}

export function createClientContext(): ClientContext {
  const { showToast } = useToast();
  const s = createClientSharedState();
  return { s, showToast } as ClientContext;
}

export function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function eventErrorMessage(value: unknown, fallback: string): string {
  if (value !== null && typeof value === 'object') {
    const message = (value as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return fallback;
}
