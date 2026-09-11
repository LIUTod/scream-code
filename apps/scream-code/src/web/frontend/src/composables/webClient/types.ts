import type { Ref } from 'vue';
import type {
  ApprovalRequest,
  ChatMessage,
  CreateGoalRequest,
  GitStatus,
  GoalSnapshot,
  LikePreferences,
  ModelInfo,
  ReloadSummary,
  SessionListItem,
  SessionPlan,
  SessionStatus,
  SkillSummary,
  PluginInfo,
  PluginSummary,
  McpServerInfo,
  McpStartupMetrics,
  ScreamConfig,
  ScreamConfigPatch,
  TodoItem,
  UpdateGoalRequest,
  BackgroundTaskInfo,
  ExperimentalFlagMap,
} from '../../types';
import type { ConnectionStatus } from './state';

/** Public contract of useScreamWebClient() — the facade keys every consumer
 *  component binds to. Splitting the implementation into webClient/ domains
 *  must never change this shape. */
export interface UseScreamWebClientReturn {
  connectionStatus: Ref<ConnectionStatus>;
  messages: Ref<ChatMessage[]>;
  /** Older history exists beyond the loaded window. */
  olderAvailable: Ref<boolean>;
  /** Seq cursor of the oldest loaded message (before-cursor for older pages). */
  oldestSeq: Ref<number | undefined>;
  loadOlderMessages: () => Promise<number>;
  pendingApprovals: Ref<ApprovalRequest[]>;
  status: Ref<SessionStatus>;
  goal: Ref<GoalSnapshot | null>;
  todos: Ref<TodoItem[]>;
  goalRequestPending: Ref<boolean>;
  goalRequestError: Ref<string | null>;
  error: Ref<string | null>;
  sessionId: Ref<string | null>;
  workDir: Ref<string | null>;
  isBusy: Ref<boolean>;
  isArchived: Ref<boolean>;
  sessions: Ref<SessionListItem[]>;
  currentSessionId: Ref<string | null>;
  gitStatus: Ref<GitStatus | null>;
  models: Ref<ModelInfo[]>;
  like: Ref<LikePreferences>;
  fetchLike: () => Promise<void>;
  updateLike: (prefs: LikePreferences) => Promise<boolean>;
  sendPrompt: (text: string) => void;
  sendCommand: (command: string, args?: string) => void;
  clearMessages: () => void;
  appendSystemMessage: (text: string) => void;
  abort: () => void;
  resolveApproval: (id: string, decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session') => void;
  fetchSessions: () => Promise<void>;
  fetchGitStatus: () => Promise<void>;
  fetchModels: () => Promise<void>;
  reconnectNow: () => void;
  switchModel: (alias: string) => Promise<void>;
  switchThinking: (level: string) => Promise<void>;
  refineGoal: (description: string) => Promise<string | null>;
  createGoal: (request: CreateGoalRequest) => Promise<boolean>;
  updateGoal: (request: UpdateGoalRequest) => Promise<boolean>;
  pauseGoal: () => Promise<boolean>;
  resumeGoal: () => Promise<boolean>;
  cancelGoal: () => Promise<boolean>;
  createSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  exportSession: (sessionId: string) => Promise<void>;
  fetchSnapshot: () => Promise<void>;
  // ── Session-control / resource / global REST methods (server.ts exposure) ──
  fetchSessionStatus: () => Promise<void>;
  fetchSessionUsage: () => Promise<void>;
  fetchSessionContext: () => Promise<void>;
  fetchSessionPlan: () => Promise<void>;
  sessionPlan: Ref<SessionPlan | null>;
  clearPlan: () => Promise<boolean>;
  switchPermission: (mode: string) => Promise<boolean>;
  switchPlanMode: (enabled: boolean, strategy?: 'normal' | 'fusion') => Promise<boolean>;
  switchWolfpack: (enabled: boolean) => Promise<boolean>;
  switchRlm: (enabled: boolean, maxDepth?: number) => Promise<boolean>;
  undoHistory: (count?: number) => Promise<boolean>;
  compact: (instruction?: string) => Promise<boolean>;
  skills: Ref<SkillSummary[]>;
  fetchSkills: () => Promise<void>;
  activateSkill: (name: string, args?: string) => Promise<boolean>;
  removeSkill: (name: string) => Promise<boolean>;
  plugins: Ref<PluginSummary[]>;
  pluginInfo: Ref<PluginInfo | null>;
  fetchPlugins: () => Promise<void>;
  fetchPluginInfo: (id: string) => Promise<void>;
  installPlugin: (source: string) => Promise<PluginSummary | null>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  setPluginMcpServerEnabled: (id: string, server: string, enabled: boolean) => Promise<boolean>;
  removePlugin: (id: string) => Promise<boolean>;
  reloadPlugins: () => Promise<ReloadSummary | null>;
  activatePlugin: (id: string) => Promise<boolean>;
  deactivatePlugin: (id: string) => Promise<boolean>;
  injectPlugin: (id: string) => Promise<boolean>;
  mcpServers: Ref<McpServerInfo[]>;
  mcpStartupMetrics: Ref<McpStartupMetrics | null>;
  fetchMcpServers: () => Promise<void>;
  fetchMcpStartupMetrics: () => Promise<void>;
  addMcpServer: (name: string, config: Record<string, unknown>) => Promise<boolean>;
  reconnectMcpServer: (name: string) => Promise<boolean>;
  stopMcpServer: (name: string) => Promise<boolean>;
  removeMcpServer: (name: string) => Promise<boolean>;
  backgroundTasks: Ref<BackgroundTaskInfo[]>;
  backgroundTaskOutput: Ref<string>;
  fetchBackgroundTasks: (activeOnly?: boolean, limit?: number) => Promise<void>;
  fetchBackgroundTaskOutput: (taskId: string, tail?: number) => Promise<void>;
  stopBackgroundTask: (taskId: string, reason?: string) => Promise<boolean>;
  config: Ref<ScreamConfig | null>;
  fetchConfig: () => Promise<void>;
  setConfig: (patch: ScreamConfigPatch) => Promise<boolean>;
  removeProvider: (providerId: string) => Promise<boolean>;
  experimentalFlags: Ref<ExperimentalFlagMap | null>;
  fetchExperimentalFlags: () => Promise<void>;
  preflightOk: Ref<boolean>;
  preflight: () => Promise<void>;
}
