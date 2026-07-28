export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tools: ToolMessage[];
  isError?: boolean;
  pending?: boolean;
  /** Client-side creation time (ms epoch). Absent for snapshot-restored messages. */
  ts?: number;
  /** Locally created (command results, system notices) - preserved across snapshot refresh. */
  local?: boolean;
  /** Stable id used to reconcile optimistic user messages with server snapshots. */
  clientMessageId?: string;
}

export interface ToolMessage {
  toolCallId: string;
  name: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** Tool call awaiting an external signal (e.g. approval) before it can finish. */
  suspended?: boolean;
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
