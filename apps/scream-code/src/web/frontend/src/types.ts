/** User preferences from /like (nickname/tone/other/doNot), shared with the TUI. */
export interface LikePreferences {
  nickname?: string;
  tone?: string;
  other?: string;
  doNot?: string;
}

export interface ChatMessage {  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tools: ToolMessage[];
  isError?: boolean;
  pending?: boolean;
  /** Message creation time (ms epoch). Server-populated on finalized turns. */
  ts?: number;
  /** Locally created (command results, system notices) - preserved across snapshot refresh. */
  local?: boolean;
  /** Model that produced this assistant turn (header label). */
  model?: string;
  /** Stable id used to reconcile optimistic user messages with server snapshots. */
  clientMessageId?: string;
  /** Server journal seq — used for older-history pagination. */
  seq?: number;
  /** Turn predates durable snapshots: body/thinking unrecoverable after a server restart. */
  degraded?: boolean;
  /** Per-turn runtime stats (round/step/timing/tokens). */
  turnStats?: TurnStats;
}

/** Per-assistant-turn runtime statistics, shown as the turn tail row. */
export interface TurnStats {
  turn: number;
  step: number;
  /** Live-turn indicator; set to 'done' once the turn settles. */
  status: 'running' | 'done';
  /** Wall time from turn start to first model token (ms). */
  firstTokenMs: number | null;
  /** Accumulated LLM wall time (ms). */
  llmMs: number | null;
  /** Accumulated tool execution wall time (ms). */
  toolMs: number | null;
  /** Total tokens consumed this turn (from usage.currentTurn when available). */
  tokens: number | null;
  /** Tokens per second of LLM wall time. */
  tokensPerSec: number | null;
}

export interface ToolMessage {
  toolCallId: string;
  name: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** Tool call awaiting an external signal (e.g. approval) before it can finish. */
  suspended?: boolean;
  /** Set when the thinking entry was truncated in a snapshot (full text on demand). */
  truncated?: boolean;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  action?: string;
  display?: unknown;
}

export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

export interface SessionUsage {
  byModel?: Record<string, TokenUsage>;
  currentTurn?: TokenUsage;
  total?: TokenUsage;
}

export interface SessionStatus {
  busy: boolean;
  model?: string;
  thinkingLevel?: string;
  permission?: 'manual' | 'auto' | 'yolo' | string;
  planMode?: boolean;
  wolfpackMode?: boolean;
  rlmEnabled?: boolean;
  contextTokens?: number;
  maxContextTokens?: number;
  /** Context usage fraction (0..1) or percent (0..100). */
  contextUsage?: number;
  usage?: SessionUsage;
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';
export interface GoalBudgetReport {
  tokenBudget: number | null;
  turnBudget: number | null;
  wallClockBudgetMs: number | null;
  remainingTokens: number | null;
  remainingTurns: number | null;
  remainingWallClockMs: number | null;
  overBudget: boolean;
}

export interface GoalNote {
  content: string;
  time: number;
}

export interface GoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budget: GoalBudgetReport;
  terminalReason?: string;
  notes: GoalNote[];
}

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  title: string;
  status: TodoStatus;
  phase?: string;
}

export type GoalBudgetUnit = 'turns' | 'tokens' | 'milliseconds' | 'seconds' | 'minutes' | 'hours';

export interface GoalBudgetInput {
  value: number;
  unit: GoalBudgetUnit;
}

export interface CreateGoalRequest {
  objective: string;
  completionCriterion?: string;
  replace?: boolean;
  budgets: GoalBudgetInput[];
}

export interface UpdateGoalRequest {
  objective?: string;
  budgets?: GoalBudgetInput[];
}

export interface SessionSnapshot {
  sessionId: string;
  workDir: string;
  seq: number;
  epoch: number;
  messages: ChatMessage[];
  /** True when older history exists beyond `messages` (tail-window snapshot). */
  olderAvailable?: boolean;
  /** Journal seq of the oldest message in `messages` — pagination cursor for older history. */
  oldestSeq?: number;
  pendingApprovals: ApprovalRequest[];
  status: SessionStatus;
  busy: boolean;
  createdAt: number;
  title: string;
  model: string;
  permission: string;
  goal: GoalSnapshot | null;
  todos: TodoItem[];
}

export interface SessionListItem {
  sessionId: string;
  workDir: string;
  title: string;
  createdAt: number;
  messageCount: number;
  active: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Files with changes (staged + unstaged + untracked). */
  changed?: number;
  adds?: number;
  dels?: number;
  /** `git diff --stat HEAD` summary text. */
  diffStat?: string;
  /** per-file porcelain status entries */
  files?: GitFileChange[];
}

export interface GitFileChange {
  /** Repository-root-relative — the canonical key to send back to `/git/diff`. */
  path: string;
  /** Work-dir-relative short path for display (falls back to `path`). */
  displayPath?: string;
  status: string;
  adds?: number;
  dels?: number;
  untracked?: boolean;
}

export interface ModelInfo {
  alias: string;
  provider: string;
  model: string;
  displayName?: string;
  maxContextSize: number;
  thinkingLevels?: string[];
}

export interface ModelsResponse {
  models: ModelInfo[];
  defaultModel?: string;
  defaultThinking?: boolean;
  thinkingEffort?: string;
}

export interface ServerHello {
  type: 'server_hello';
  heartbeat_ms: number;
  epoch: number;
  sessionId: string;
  workDir: string;
  active: boolean;
}

export interface JournalEvent {
  type: 'event';
  seq: number;
  epoch: number;
  payload: {
    type: string;
    [key: string]: unknown;
  };
}

export type WsMessage =
  | ServerHello
  | JournalEvent
  | { type: 'approval_request'; id: string; toolName: string; action?: string; display?: unknown }
  | { type: 'approval_resolved'; id: string }
  | { type: 'user_message'; clientMessageId?: string; text: string }
  | { type: 'command_result'; command: string; ok: boolean; message: string; pendingMsgId?: string }
  | { type: 'status'; status: SessionStatus }
  | { type: 'resync_required'; reason: string }
  | { type: 'pong' }
  | { type: 'server_empty' }
  | { type: 'error'; code?: string; message: string; clientMessageId?: string };

// ─── Session-control / resource / global mirrors (from agent-core) ──────────
// These mirror the shapes returned by the REST endpoints exposed in server.ts.
// The frontend does not import @scream-code/agent-core; these are local copies.

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  readonly agentId?: string;
  readonly turn?: number;
}

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}

export interface PlanInfo {
  id: string;
  content: string;
  path: string;
  strategy: 'normal' | 'fusion';
}

export type SessionPlan = PlanInfo | null;

export type SkillSource = 'builtin' | 'user' | 'extra' | 'project';

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  type?: string;
  disableModelInvocation?: boolean;
  /** Plugin id when this skill is provided by a plugin package. */
  pluginId?: string;
}

export interface PluginMcpServerInfo {
  name: string;
  runtimeName: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: readonly string[];
  cwd?: string;
  url?: string;
  envKeys?: readonly string[];
  headerKeys?: readonly string[];
}

export type PluginState = 'ok' | 'error';
export type PluginSource = 'local-path' | 'zip-url' | 'github';
export type PluginManifestKind = 'scream-plugin-root' | 'scream-plugin-dir' | 'claude-plugin-dir' | 'bare-skill';

export interface PluginSkillSummary {
  name: string;
  description: string;
}

export interface PluginGithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export interface PluginGithubMetadata {
  owner: string;
  repo: string;
  ref: PluginGithubRef;
  installedSha?: string;
}

export interface PluginSummary {
  id: string;
  displayName: string;
  version?: string;
  enabled: boolean;
  state: PluginState;
  skillCount: number;
  skills: readonly PluginSkillSummary[];
  mcpServerCount: number;
  enabledMcpServerCount: number;
  hasErrors: boolean;
  source: PluginSource;
  originalSource?: string;
  github?: PluginGithubMetadata;
}

export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly message: string;
}

export interface PluginInfo extends PluginSummary {
  root: string;
  installedAt: string;
  updatedAt?: string;
  manifestKind?: PluginManifestKind;
  manifestPath?: string;
  manifest?: unknown;
  mcpServers: readonly PluginMcpServerInfo[];
  shadowedManifestPath?: string;
  diagnostics: readonly PluginDiagnostic[];
}

export interface ReloadSummary {
  added: readonly string[];
  removed: readonly string[];
  errors: ReadonlyArray<{ id: string; message: string }>;
}

export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'http';
  status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  toolCount: number;
  error?: string;
}

export interface McpStartupMetrics {
  durationMs: number;
}

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'lost' | 'awaiting_approval';

export interface BackgroundTaskInfo {
  taskId: string;
  command: string;
  description: string;
  status: BackgroundTaskStatus;
  pid: number;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  approvalReason?: string;
  timedOut?: boolean;
  stopReason?: string;
  timeoutMs?: number;
  agentId?: string;
  subagentType?: string;
  failureReason?: string;
}

export type ExperimentalFlagMap = Record<string, boolean>;

export interface ScreamConfigPatch {
  [key: string]: unknown;
}

export interface ScreamConfig {
  [key: string]: unknown;
}
