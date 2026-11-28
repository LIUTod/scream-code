import type { AgentConfigData } from '#/agent/config';
import type { AgentContextData } from '#/agent/context';
import type { PermissionData, PermissionMode } from '#/agent/permission';
import type { PlanData } from '#/agent/plan';
import type { SessionTokenBudget } from '#/agent/usage/token-meter';
import type { ToolInfo } from '#/agent/tool';
import type { ScreamConfig, ScreamConfigPatch } from '#/config';
import type { McpServerConfig } from '#/config/schema';
import type { McpAuthenticateResult } from '#/mcp/connection-manager';
import type { ExperimentalFlagMap } from '#/flags';
import type { ResumeSessionResult } from '#/rpc/resumed';
import type { SessionMeta } from '#/session';
import type { TodoItem } from '#/todo';
import type { BackgroundTaskInfo } from '#/tools/builtin';
import type { ContentPart } from '@scream-code/ltod';

import type { PluginInfo, PluginSummary, ReloadSummary } from '#/plugin';
import type { UsageStatus } from './events';
import type { WithAgentId, WithSessionId } from './types';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

export type { ScreamConfig, ScreamConfigPatch };

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export type EmptyPayload = {};
export type SessionMetadataPatch = Partial<Omit<SessionMeta, 'agents'>>;

/**
 * Serializable subset of an agent profile a host can pin to a session.
 *
 * The core composes it onto `DEFAULT_AGENT_PROFILES['agent']`: `systemPrompt`
 * is appended to the rendered base prompt, `activeTools` replaces the base
 * tool list. Everything here must survive JSON — it is persisted in session
 * metadata and re-applied on resume so a pinned profile survives restarts.
 */
export interface SessionAgentProfile {
  readonly name?: string | undefined;
  readonly systemPrompt?: string | undefined;
  readonly activeTools?: readonly string[] | undefined;
}

export interface CreateSessionPayload {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  /**
   * Tool-name patterns injected as project-scope DENY rules on the main agent
   * (the scope `UserConfiguredDenyPermissionPolicy` consults). The session host
   * uses this for CLI-compat deny lists: deny rules fire in every permission
   * mode, unlike the approval handler, which no longer sees tool calls.
   */
  readonly permissionDenyRules?: readonly string[] | undefined;
  /**
   * False when the host process ends with this run (a one-off `scream -p`):
   * scheduled tasks are refused and none fire. A resumed session is rebuilt,
   * so the host sends it again on every resume. Defaults to true.
   */
  readonly scheduledTasks?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
  /** Session-scoped agent profile (name / system prompt / tool subset). Omitted ⇒ default agent profile. */
  readonly profile?: SessionAgentProfile | undefined;
  /**
   * Root the session at exactly `workDir` instead of walking up to the nearest
   * `.git` / `package.json` ancestor. Defaults to the ancestor walk.
   */
  readonly exactWorkDir?: boolean | undefined;
  /**
   * False for a session that only probes the model (`scream host check`): no
   * MCP servers are started and no plugin session hooks run, so a check does
   * not launch a browser or a plugin's side effects. Defaults to true.
   */
  readonly extensions?: boolean | undefined;
}

export interface CloseSessionPayload {
  readonly sessionId: string;
}

export interface DeleteSessionPayload {
  readonly sessionId: string;
}

export interface ResumeSessionPayload {
  readonly sessionId: string;
  /**
   * Tool-name patterns to inject as project-scope DENY rules when the session
   * is restored. A resumed session is rebuilt from scratch, so a host that
   * enforces a CLI-compat deny list must send it again on every resume.
   */
  readonly permissionDenyRules?: readonly string[] | undefined;
  /**
   * False when the host process ends with this run (a one-off `scream -p`):
   * scheduled tasks are refused and none fire. A resumed session is rebuilt,
   * so the host sends it again on every resume. Defaults to true.
   */
  readonly scheduledTasks?: boolean | undefined;
}

export interface ForkSessionPayload {
  readonly sessionId: string;
  readonly id?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
  /** As on resume: `false` opens the fork with scheduled tasks held (see `startScheduledTasks`). */
  readonly scheduledTasks?: boolean | undefined;
}

export interface ShellEnvironment {
  readonly term?: string | undefined;
  readonly termProgram?: string | undefined;
  readonly termProgramVersion?: string | undefined;
  readonly multiplexer?: string | undefined;
  readonly shell?: string | undefined;
}

export interface ExportSessionPayload {
  readonly sessionId: string;
  readonly outputPath?: string | undefined;
  /**
   * When true, the active global diagnostic log (`$SCREAM_CODE_HOME/logs/scream-code.log`)
   * is copied into the zip at `logs/global/scream-code.log`. Off by default to
   * avoid bundling events from concurrent sessions / other projects.
   */
  readonly includeGlobalLog?: boolean | undefined;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly screamCodeVersion: string;
  readonly wireProtocolVersion: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly sessionFirstActivity?: string | undefined;
  readonly sessionLastActivity?: string | undefined;
  readonly title?: string | undefined;
  readonly workspaceDir?: string | undefined;
  /** zip-relative path to the session diagnostic log when present. */
  readonly sessionLogPath?: string | undefined;
  /** zip-relative path to the bundled global diagnostic log (only when --include-global-log). */
  readonly globalLogPath?: string | undefined;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ListSessionsPayload {
  readonly workDir?: string;
  readonly sessionId?: string;
}

export interface CoreInfo {
  readonly version: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface PromptPayload {
  readonly input: readonly ContentPart[];
}
export interface SteerPayload {
  readonly input: readonly ContentPart[];
  /**
   * When false, the steer joins at the next step boundary without
   * interrupting an in-flight tool batch (auto-drained queue). Default
   * (undefined) interrupts immediately, as an explicit user steer should.
   */
  readonly interrupt?: boolean | undefined;
}
export interface CancelPayload {
  readonly turnId?: number;
}
export interface SetThinkingPayload {
  readonly level: string;
}
export interface SetPermissionPayload {
  readonly mode: PermissionMode;
}
export interface RuntimeSystemPrompt {
  readonly replace?: string | undefined;
  readonly append?: string | undefined;
}
export interface SetRuntimeSystemPromptPayload {
  readonly prompt: RuntimeSystemPrompt;
}
export interface SetModelPayload {
  readonly model: string;
}
export interface SetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}
export interface EnterPlanPayload {
  readonly strategy?: 'normal' | 'fusion';
}
export interface SetPlanStrategyPayload {
  readonly strategy: 'normal' | 'fusion';
}
export interface CancelPlanPayload {
  readonly id?: string;
}
export interface BeginCompactionPayload {
  readonly instruction?: string;
}
export interface RegisterToolPayload {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}
export interface UnregisterToolPayload {
  readonly name: string;
}
export interface SetActiveToolsPayload {
  readonly names: readonly string[];
}

export interface SetRlmEnabledPayload {
  readonly enabled: boolean;
}
export interface SetScriptEnabledPayload {
  /** Target state; omitted toggles the mode. */
  readonly enabled?: boolean | undefined;
}
export interface SetRlmMaxDepthPayload {
  readonly maxDepth: number;
}
export interface StopBackgroundPayload {
  readonly taskId: string;
  /** Free-form human-readable reason persisted with the task record. */
  readonly reason?: string;
}
export interface GetBackgroundOutputPayload {
  readonly taskId: string;
  readonly tail?: number;
}
export interface GetBackgroundOutputPathPayload {
  readonly taskId: string;
}
export interface GetBackgroundPayload {
  /**
   * When omitted, returns all tasks (including terminal/lost). Pass
   * `true` to filter down to active-only — useful for model-facing
   * surfaces. UI/TUI consumers should leave it undefined.
   */
  readonly activeOnly?: boolean;
  /** Caps the number of tasks returned. When omitted, returns all matching tasks. */
  readonly limit?: number;
}
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: 'builtin' | 'user' | 'extra' | 'project';
  readonly type?: string | undefined;
  readonly disableModelInvocation?: boolean | undefined;
  /** Plugin id when this skill is provided by a plugin package. */
  readonly pluginId?: string | undefined;
}

export interface ActivateSkillPayload {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface RemoveSkillPayload {
  readonly skillName: string;
}

export interface RevokeSessionApprovalGrantPayload {
  readonly pattern: string;
}

export interface McpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
  /** Optional at the wire boundary so older clients/servers coexist. */
  readonly capabilities?: readonly string[];
  /** Optional for the same reason; `serverInfo.version` when the server sent it. */
  readonly serverVersion?: string;
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}

export interface CronTaskInfo {
  readonly id: string;
  /** Verbatim 5-field expression, exactly as stored. */
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  /** `true` unless the task was explicitly created with `recurring: false`. */
  readonly recurring: boolean;
  /** Mirrors `CronManager.isStale`: recurring and past the 7-day cutoff. */
  readonly stale: boolean;
  readonly lastFiredAt?: number | undefined;
  /** Post-jitter next fire, or `null` when nothing fires within 5 years. */
  readonly nextFireAt: number | null;
  /** The task runs without a "fired" notice. */
  readonly silent?: boolean | undefined;
  /** The task delivers nothing at all. */
  readonly mute?: boolean | undefined;
  /** Failure text from the latest delivery; cleared by a clean run. */
  readonly lastError?: string | null | undefined;
}

export interface CreateCronTaskPayload {
  readonly cron: string;
  readonly prompt: string;
  readonly recurring?: boolean | undefined;
  /** Skip the "fired" notice; the result still goes out. */
  readonly silent?: boolean | undefined;
  /** Deliver nothing at all — a maintenance run. */
  readonly mute?: boolean | undefined;
}

export interface RemoveCronTasksPayload {
  readonly ids: readonly string[];
}

export interface ReconnectMcpServerPayload {
  readonly name: string;
}

export interface AuthenticateMcpServerPayload {
  readonly name: string;
}

export type { McpAuthenticateResult };

export interface SetSessionTokenBudgetPayload {
  /** New session token limit; `null` turns the limit off. */
  readonly limitTokens: number | null;
}

export type { SessionTokenBudget };

export interface AddMcpServerPayload {
  readonly name: string;
  readonly config: McpServerConfig;
}

export interface StopMcpServerPayload {
  readonly name: string;
}

export interface RemoveMcpServerPayload {
  readonly name: string;
}

export interface InstallPluginPayload {
  readonly source: string;
}

export interface SetPluginEnabledPayload {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SetPluginMcpServerEnabledPayload {
  readonly id: string;
  readonly server: string;
  readonly enabled: boolean;
}

export interface RemovePluginPayload {
  readonly id: string;
}
export interface GetPluginInfoPayload {
  readonly id: string;
}

export interface InjectPluginPayload {
  readonly id: string;
}

export type ReloadPluginsResult = ReloadSummary;
export type { PluginSummary, PluginInfo };

export interface RenameSessionPayload {
  readonly title: string;
}

export interface UpdateSessionMetadataPayload {
  readonly metadata: SessionMetadataPatch;
}

export interface GetScreamConfigPayload {
  readonly reload?: boolean;
}

export type SetScreamConfigPayload = ScreamConfigPatch;

export interface RemoveScreamProviderPayload {
  readonly providerId: string;
}
export interface UndoHistoryPayload {
  readonly count: number;
  /**
   * `restore`: also put back the files the write tools changed in those turns
   * (see FileHistory); `keep` (the default): undo the conversation alone.
   */
  readonly files?: 'restore' | 'keep' | undefined;
}

export interface UndoHistoryResult {
  /** Files put back (rewritten, or deleted when those turns had created them). */
  readonly restored: readonly string[];
  /** Files left as they are: changed since by someone else, too large to have been kept, or a failed write. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: 'changed' | 'too_large' | 'failed' }>;
}

export interface SideQuestionPayload {
  readonly question: string;
}

export interface SideQuestionResult {
  readonly answer: string;
}

export interface GenerateTextPayload {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface GenerateTextResult {
  readonly text: string;
}

export interface CreateGoalPayload {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
}

export interface UpdateGoalStatusPayload {
  readonly status: 'active' | 'complete' | 'paused' | 'blocked';
}

export interface UpdateGoalObjectivePayload {
  readonly objective: string;
}

export interface SetGoalBudgetPayload {
  readonly value: number;
  readonly unit: 'turns' | 'tokens' | 'milliseconds' | 'seconds' | 'minutes' | 'hours';
}

export interface GoalSnapshotData {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: string;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly wallClockMs: number;
  readonly budget: {
    readonly tokenBudget: number | null;
    readonly turnBudget: number | null;
    readonly wallClockBudgetMs: number | null;
    readonly remainingTokens: number | null;
    readonly remainingTurns: number | null;
    readonly remainingWallClockMs: number | null;
    readonly overBudget: boolean;
  };
  readonly terminalReason?: string;
  readonly notes: readonly { readonly content: string; readonly time: number }[];
}

export interface GetGoalResult {
  readonly goal: GoalSnapshotData | null;
}

export interface AgentAPI {
  prompt: (payload: PromptPayload) => void;
  steer: (payload: SteerPayload) => void;
  cancel: (payload: CancelPayload) => void;
  setThinking: (payload: SetThinkingPayload) => void;
  setPermission: (payload: SetPermissionPayload) => void;
  setModel: (payload: SetModelPayload) => SetModelResult;
  getModel: (payload: EmptyPayload) => string;
  enterPlan: (payload: EnterPlanPayload) => void;
  setPlanStrategy: (payload: SetPlanStrategyPayload) => void;
  cancelPlan: (payload: CancelPlanPayload) => void;
  clearPlan: (payload: EmptyPayload) => void;
  enterWolfpack: (payload: EmptyPayload) => void;
  exitWolfpack: (payload: EmptyPayload) => void;
  beginCompaction: (payload: BeginCompactionPayload) => void;
  cancelCompaction: (payload: EmptyPayload) => void;
  registerTool: (payload: RegisterToolPayload) => void;
  unregisterTool: (payload: UnregisterToolPayload) => void;
  setActiveTools: (payload: SetActiveToolsPayload) => void;
  setRlmEnabled: (payload: SetRlmEnabledPayload) => void;
  setScriptEnabled: (payload: SetScriptEnabledPayload) => boolean;
  setRlmMaxDepth: (payload: SetRlmMaxDepthPayload) => void;
  stopBackground: (payload: StopBackgroundPayload) => void;
  clearContext: (payload: EmptyPayload) => void;
  undoHistory: (payload: UndoHistoryPayload) => UndoHistoryResult;
  /** The files the write tools changed in the turns an undo of `count` would remove, oldest first. */
  previewUndoFiles: (payload: UndoHistoryPayload) => readonly string[];
  activateSkill: (payload: ActivateSkillPayload) => void;
  getBackgroundOutput: (payload: GetBackgroundOutputPayload) => string;
  getBackgroundOutputPath: (payload: GetBackgroundOutputPathPayload) => string | undefined;
  getContext: (payload: EmptyPayload) => AgentContextData;
  getConfig: (payload: EmptyPayload) => AgentConfigData;
  getPermission: (payload: EmptyPayload) => PermissionData;
  getPlan: (payload: EmptyPayload) => PlanData;
  getUsage: (payload: EmptyPayload) => UsageStatus;
  getTools: (payload: EmptyPayload) => readonly ToolInfo[];
  getBackground: (payload: GetBackgroundPayload) => readonly BackgroundTaskInfo[];
  listCronTasks: (payload: EmptyPayload) => readonly CronTaskInfo[];
  createCronTask: (payload: CreateCronTaskPayload) => CronTaskInfo;
  /** Returns the ids that were actually present, matching `CronManager.removeTasks`. */
  removeCronTasks: (payload: RemoveCronTasksPayload) => readonly string[];
  /**
   * Start firing scheduled tasks for an agent opened with `scheduledTasks:
   * false`. A host that must see every fire (the IM daemon relays them to a
   * chat) opens that way, subscribes to events, then calls this — an overdue
   * task fires on the first tick and would otherwise land before anyone
   * listens. Returns true when firing was off. Idempotent.
   */
  startScheduledTasks: (payload: EmptyPayload) => boolean;
  /** `pending`: an unattended session — memories go to the inbox, not the store. */
  extractMemoriesOnExit: (payload: { readonly pending?: boolean }) => Promise<number>;
  sideQuestion: (payload: SideQuestionPayload) => Promise<SideQuestionResult>;
  generateText: (payload: GenerateTextPayload) => Promise<GenerateTextResult>;
  createGoal: (payload: CreateGoalPayload) => GoalSnapshotData;
  updateGoalStatus: (payload: UpdateGoalStatusPayload) => GoalSnapshotData | null;
  updateGoalObjective: (payload: UpdateGoalObjectivePayload) => GoalSnapshotData;
  cancelGoal: (payload: EmptyPayload) => GoalSnapshotData | null;
  getGoal: (payload: EmptyPayload) => GetGoalResult;
  getTodos: (payload: EmptyPayload) => readonly TodoItem[];
  setGoalBudget: (payload: SetGoalBudgetPayload) => GoalSnapshotData;
  getWolfpackMode: (payload: EmptyPayload) => boolean;
  getRlmEnabled: (payload: EmptyPayload) => boolean;
  /** Maximum RLM recursion depth; Infinity means unlimited. */
  getRlmMaxDepth: (payload: EmptyPayload) => number;
}

type AgentAPIWithId = WithAgentId<AgentAPI>;

export interface SessionAPI extends AgentAPIWithId {
  setRuntimeSystemPrompt: (payload: SetRuntimeSystemPromptPayload) => void;
  renameSession: (payload: RenameSessionPayload) => void;
  updateSessionMetadata: (payload: UpdateSessionMetadataPayload) => void;
  getSessionMetadata: (payload: EmptyPayload) => SessionMeta;
  listSkills: (payload: EmptyPayload) => readonly SkillSummary[];
  injectPlugin: (payload: InjectPluginPayload) => void;
  removeSkill: (payload: RemoveSkillPayload) => void;
  /** Approval patterns currently granted for the session (approve-for-session). */
  getSessionApprovalGrants: (payload: EmptyPayload) => string[];
  /** Revoke one approve-for-session grant; true when a grant was removed. */
  revokeSessionApprovalGrant: (payload: RevokeSessionApprovalGrantPayload) => boolean;
  /** Tokens this run has used against the session token limit (`limitTokens` null = no limit). */
  getSessionTokenBudget: (payload: EmptyPayload) => SessionTokenBudget;
  /** Change the session token limit on the live session (applies at the next step); returns the new state. */
  setSessionTokenBudget: (payload: SetSessionTokenBudgetPayload) => SessionTokenBudget;
  listMcpServers: (payload: EmptyPayload) => readonly McpServerInfo[];
  getMcpStartupMetrics: (payload: EmptyPayload) => McpStartupMetrics;
  reconnectMcpServer: (payload: ReconnectMcpServerPayload) => void;
  addMcpServer: (payload: AddMcpServerPayload) => void;
  stopMcpServer: (payload: StopMcpServerPayload) => void;
  removeMcpServer: (payload: RemoveMcpServerPayload) => void;
  /**
   * Start an OAuth flow for an HTTP MCP server from the UI and return the URL
   * to open; the flow completes in the background and reconnects on success.
   */
  authenticateMcpServer: (payload: AuthenticateMcpServerPayload) => Promise<McpAuthenticateResult>;
  generateAgentsMd: (payload: { targetDir?: string | undefined }) => void;
}

type SessionAPIWithId = WithSessionId<SessionAPI>;

export interface ActivatePluginPayload {
  readonly sessionId: string;
  readonly pluginId: string;
}

export interface DeactivatePluginPayload {
  readonly pluginId: string;
  /** Scope the stop to one session; omit to stop every copy (global paths). */
  readonly sessionId?: string;
}

export interface PluginExtensionSummary {
  readonly pluginId: string;
  readonly entryPoint: string;
  readonly active: boolean;
}

export interface HandOffSessionPayload {
  readonly sessionId: string;
}

export interface HandOffSessionResult {
  /** False when the session had nothing in flight to hand over. */
  readonly handedOff: boolean;
  readonly kind?: 'goal' | 'bot' | 'chat' | undefined;
}

export interface CoreAPI extends SessionAPIWithId {
  getCoreInfo: (payload: EmptyPayload) => CoreInfo;
  getExperimentalFlags: (payload: EmptyPayload) => ExperimentalFlagMap;
  getScreamConfig: (payload: GetScreamConfigPayload) => ScreamConfig;
  setScreamConfig: (payload: SetScreamConfigPayload) => ScreamConfig;
  removeScreamProvider: (payload: RemoveScreamProviderPayload) => ScreamConfig;
  createSession: (payload: CreateSessionPayload) => SessionSummary;
  closeSession: (payload: CloseSessionPayload) => void;
  /**
   * Mark the session's work for the background host before this process
   * closes it: its running-work record survives the close and tells the host
   * to continue it. Only meaningful with a turn in flight or an active goal.
   */
  handOffSession: (payload: HandOffSessionPayload) => HandOffSessionResult;
  /**
   * Let one exact action (an inbox `actionKey`) through the session's bot
   * mode once: the person approved it from the inbox.
   */
  grantOneShotApproval: (payload: { readonly sessionId: string; readonly actionKey: string }) => boolean;
  deleteSession: (payload: DeleteSessionPayload) => void;
  resumeSession: (payload: ResumeSessionPayload) => ResumeSessionResult;
  forkSession: (payload: ForkSessionPayload) => ResumeSessionResult;
  listSessions: (payload: ListSessionsPayload) => readonly SessionSummary[];
  activatePlugin: (payload: ActivatePluginPayload) => Promise<void>;
  deactivatePlugin: (payload: DeactivatePluginPayload) => Promise<void>;
  pluginExtensionStatus: (payload: { sessionId?: string }) => readonly PluginExtensionSummary[];
  exportSession: (payload: ExportSessionPayload) => ExportSessionResult;
  listPlugins: (payload: EmptyPayload) => readonly PluginSummary[];
  installPlugin: (payload: InstallPluginPayload) => PluginSummary;
  setPluginEnabled: (payload: SetPluginEnabledPayload) => void;
  setPluginMcpServerEnabled: (payload: SetPluginMcpServerEnabledPayload) => void;
  removePlugin: (payload: RemovePluginPayload) => void;
  reloadPlugins: (payload: EmptyPayload) => ReloadPluginsResult;
  getPluginInfo: (payload: GetPluginInfoPayload) => PluginInfo;
}
