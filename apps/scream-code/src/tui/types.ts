import type {
  ModelAlias,
  PermissionMode,
  ProviderConfig,
  PromptPart,
  ThinkingEffort,
  TokenUsage,
  ToolInputDisplay,
  ToolResultDisplay,
} from '@scream-code/scream-code-sdk';
import type { ProviderBalance } from '@scream-code/agent-core';
import type { NotificationsConfig, TuiConfig, TuiLikePreferences } from './config';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types';
import type { Theme } from './theme';
import type { ResolvedTheme } from './theme/colors';

export interface RecentSession {
  readonly id: string;
  readonly title?: string;
  readonly updatedAt: number;
}

export type PlanModeState = 'off' | 'plan' | 'fusionplan';

/** Goal snapshot status, kept in sync with agent-core's GoalStatus union
 * (the wire type is plain string, hence the explicit union + normalizer). */
export const GOAL_STATUSES = ['active', 'paused', 'blocked', 'complete'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Clamp an unknown wire status to a safe display value: anything outside the
 *  four known states is rendered as paused (never as completed). */
export function normalizeGoalStatus(status: string): GoalStatus {
  return (GOAL_STATUSES as readonly string[]).includes(status) ? (status as GoalStatus) : 'paused';
}

/** Lightweight goal info for the footer badge + the sidebar Goal panel. */
export interface GoalBadgeInfo {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly wallClockMs: number;
  /** Timestamp (ms) when the TUI last received a goal snapshot. Used to keep
   * the footer wall-clock timer ticking between sparse `goal.updated` events. */
  readonly wallClockBaseAt: number;
  /** Completion criterion from the goal snapshot (sidebar "判据" display). */
  readonly completionCriterion: string | null;
  /** Cumulative tokens spent on this goal (goal snapshot `tokensUsed`). */
  readonly tokensUsed: number;
  /** Input tokens (incl. cache) since the goal started; null for goals
   *  restored from legacy records without per-direction counts. */
  readonly inputTokens: number | null;
  /** Output tokens since the goal started (null = legacy record). */
  readonly outputTokens: number | null;
}

/** Sidebar goal adjudication state, inferred TUI-side from the UpdateGoal tool
 *  lifecycle: awaiting (no grading in flight) → judging (a `complete` tool
 *  call is grading) → adjudicated (goal finished grading and was completed). */
export type GoalJudgeState = 'awaiting' | 'judging' | 'adjudicated';

export interface AppState {
  model: string;
  workDir: string;
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: PlanModeState;
  thinkingLevel: ThinkingEffort;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  /** Cumulative token usage for the current session (all turns summed). */
  sessionUsage: TokenUsage;
  /** LLM requests in the current session: each completed step and each
   * retried (failed) attempt counts once. In-process only: resets on session
   * switch and app restart. */
  sessionApiCalls: number;
  /** Current provider account balance (null = unknown / not applicable). */
  providerBalance: ProviderBalance | null;
  /** Monotonic timestamp of the last balance fetch (drives the flash). */
  balanceUpdatedAt: number;
  isCompacting: boolean;
  lastCompactionFinishedAt: number | undefined;
  autoCompactionCount: number;
  isReplaying: boolean;
  isSwitchingSession: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool';
  streamingStartTime: number;
  theme: Theme;
  version: string;
  hasNewVersion: boolean;
  latestVersion: string | null;
  editorCommand: string | null;
  language: 'zh' | 'en';
  notifications: NotificationsConfig;
  like: TuiLikePreferences;
  fusionPlan: TuiConfig['fusionPlan'];
  subagentModels: Record<string, string>;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  goal: GoalBadgeInfo | null;
  goalActive: boolean;
  /** Sidebar adjudication state (TUI-inferred from UpdateGoal tool calls). */
  goalJudge: GoalJudgeState;
  goalContinuationCount: number;
  ccConnectActive: boolean;
  wolfpackMode: boolean;
  /** RLM (persistent-python) mode is active. */
  rlmEnabled: boolean;
  /** Current retry attempt during a step retry (1-indexed); 0 = no retry in progress. */
  reconnectAttempt: number;
  /** Retry context for the status-bar reconnect label; set alongside reconnectAttempt. */
  reconnectMaxAttempts?: number;
  reconnectDelayMs?: number;
  reconnectStatusCode?: number;
  reconnectErrorName?: string;
  recentSessions: RecentSession[];
  subagentUsage: SubagentUsageMap;
}

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  display?: ToolInputDisplay;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
  result?: ToolResultBlockData;
  subagent?: SubagentReplayBlockData;
  step?: number;
  turnId?: string;
  /** Set when the step ended (e.g. max_tokens) before the tool call's
   *  arguments finished streaming. Renderer flips the header verb to
   *  "Truncated" and stops showing the in-progress argument preview. */
  truncated?: boolean;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  synthetic?: boolean;
  /**
   * Structured payload for TUI renderers. When present, renderers prefer this
   * over parsing `output`. Currently populated by Grep `content` mode as
   * `search_results`.
   */
  display?: ToolResultDisplay;
  /**
   * Optional human-readable side channel for tool-result metadata that should
   * not be folded into `output` (e.g. LSP diagnostics after Write/Edit).
   * Rendered separately by tool-call.ts so it doesn't trigger a second
   * collapse alongside the content preview.
   */
  message?: string;
}

export interface SubagentReplayToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
}

export type SubagentUsageMap = Record<string, TokenUsage>;

export interface SubagentReplayBlockData {
  id: string;
  name?: string;
  text?: string;
  toolCalls?: readonly SubagentReplayToolCallData[];
}

export interface BackgroundAgentMetadata {
  readonly agentId: string;
  readonly parentToolCallId: string;
  readonly agentName?: string;
  readonly description?: string;
}

export type BackgroundAgentStatusPhase = 'started' | 'completed' | 'failed';

export interface BackgroundAgentStatusData {
  readonly phase: BackgroundAgentStatusPhase;
  readonly headline: string;
  readonly detail?: string;
}

export interface CompactionTranscriptData {
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly instruction?: string;
}

export interface CronTranscriptData {
  readonly jobId?: string;
  readonly cron?: string;
  readonly recurring?: boolean;
  readonly coalescedCount?: number;
  readonly stale?: boolean;
  readonly missedCount?: number;
}

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'status'
  | 'skill_activation'
  | 'cron';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: 'markdown' | 'plain' | 'notice';
  content: string;
  color?: string;
  /**
   * Tint for the interjection marker (`▸ `) on a `notice` row. Absent means a
   * plain notice — which is how every command-feedback row renders.
   */
  noticeMarkerColor?: string;
  detail?: string;
  toolCallData?: ToolCallBlockData;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  compactionData?: CompactionTranscriptData;
  cronData?: CronTranscriptData;
  imageAttachmentIds?: readonly number[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
  skillTrigger?: 'user-slash' | 'model-tool' | 'nested-skill';
}

export interface LivePaneState {
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
}

export interface QueuedMessage {
  readonly text: string;
  readonly agentId?: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
}

export interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  pendingApproval: null,
  pendingQuestion: null,
};

// ---------------------------------------------------------------------------
// TUI startup / options types (extracted from scream-tui.ts)
// ---------------------------------------------------------------------------

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly plan: boolean;
  readonly wolfpack: boolean;
  readonly model?: string;
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface ScreamTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
  resolvedTheme?: ResolvedTheme;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LoginProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
  setLabel(label: string): void;
}

export type ProgressSpinnerHandle = LoginProgressSpinnerHandle;
