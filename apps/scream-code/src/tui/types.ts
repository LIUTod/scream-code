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
import type { NotificationsConfig, TuiConfig, TuiLikePreferences } from './config';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types';
import type { Theme } from './theme';
import type { ResolvedTheme } from './theme/colors';

export interface RecentSession {
  readonly id: string;
  readonly title?: string;
  readonly updatedAt: number;
}

export type LoopLimitConfig =
  | {
      kind: 'iterations';
      iterations: number;
    }
  | {
      kind: 'duration';
      durationMs: number;
    };

export type LoopLimitRuntime =
  | {
      kind: 'iterations';
      initial: number;
      remaining: number;
    }
  | {
      kind: 'duration';
      durationMs: number;
      deadlineMs: number;
    };

export type PlanModeState = 'off' | 'plan' | 'fusionplan';

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
  isCompacting: boolean;
  lastCompactionFinishedAt: number | undefined;
  autoCompactionCount: number;
  isReplaying: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool';
  streamingStartTime: number;
  theme: Theme;
  version: string;
  hasNewVersion: boolean;
  latestVersion: string | null;
  editorCommand: string | null;
  notifications: NotificationsConfig;
  like: TuiLikePreferences;
  fusionPlan: TuiConfig['fusionPlan'];
  subagentModels: Record<string, string>;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  goal: string | null;
  goalActive: boolean;
  goalContinuationCount: number;
  ccConnectActive: boolean;
  wolfpackMode: boolean;
  loopModeEnabled: boolean;
  loopPrompt: string | undefined;
  loopLimit: LoopLimitRuntime | undefined;
  loopVerifier: { command: string; timeoutMs: number } | undefined;
  loopIteration: number;
  loopLastVerifyPassed: boolean | undefined;
  loopVerifying: boolean;
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

export type FusionPlanPhase = 'planning' | 'synthesis' | 'completed' | 'failed';

export interface FusionPlanWorkerProgress {
  readonly index: number;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly angle: string;
  readonly label: string;
}

export interface FusionPlanStatusData {
  readonly phase: FusionPlanPhase;
  readonly completedWorkers: number;
  readonly totalWorkers: number;
  readonly failedWorkers: number;
  readonly workers: readonly FusionPlanWorkerProgress[];
  readonly detail?: string;
}

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
  detail?: string;
  toolCallData?: ToolCallBlockData;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  fusionPlanStatus?: FusionPlanStatusData;
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
