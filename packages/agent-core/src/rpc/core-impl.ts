import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { ErrorCodes, ScreamError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import { PluginManager } from '#/plugin';
import { FetchCache } from '#/tools/providers/fetch-cache';
import { LocalFetchURLProvider } from '#/tools/providers/local-fetch-url';
import { ScreamCliFetchURLProvider } from '#/tools/providers/scream-cli-fetch-url';
import { DuckDuckGoSearchProvider } from '#/tools/providers/duckduckgo-search';
import { FallbackSearchProvider } from '#/tools/providers/fallback-search';
import { ScreamCliWebSearchProvider } from '#/tools/providers/scream-cli-web-search';
import type { PromisableMethods } from '#/utils/types';
import { getCoreVersion } from '#/version';
import { resolveThinkingLevel } from '../agent/config/thinking';
import {
  ensureScreamHome,
  loadRuntimeConfig,
  mergeConfigPatch,
  readConfigFile,
  resolveConfigPath,
  resolveScreamHome,
  writeConfigFile,
  type ScreamConfig,
  type ScreamCliServiceConfig,
} from '../config';
import {
  FLAG_DEFINITIONS,
  flags,
  type ExperimentalFlagMap,
  type FlagDefinitionInput,
  type FlagId,
} from '../flags';
import type { Logger } from '../logging/types';
import { resolveSessionMcpConfig, type SessionMcpConfig } from '../mcp';
import { Session, type SessionMeta, type SessionSkillConfig } from '../session';
import type { SkillRoot } from '../skill';
import { exportSessionDirectory } from '../session/export';
import {
  ProviderManager, type BearerTokenProvider,
  type OAuthTokenProviderResolver
} from '../session/provider-manager';
import { SessionAPIImpl } from '../session/rpc';
import { normalizeWorkDir, SessionStore } from '../session/store';
import type { CoreRPCClient } from './client';
import type {
  ActivateSkillPayload,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CloseSessionPayload,
  CoreAPI,
  CoreInfo,
  CreateSessionPayload,
  DeleteSessionPayload,
  EmptyPayload,
  ExportSessionPayload,
  ExportSessionResult,
  ForkSessionPayload,
  GetBackgroundOutputPathPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  GetScreamConfigPayload,
  GetPluginInfoPayload,
  InjectPluginPayload,
  InstallPluginPayload,
  ListSessionsPayload,
  McpServerInfo,
  McpStartupMetrics,
  PluginInfo,
  PluginSummary,
  PromptPayload,
  ReconnectMcpServerPayload,
  AddMcpServerPayload,
  StopMcpServerPayload,
  RemoveMcpServerPayload,
  RegisterToolPayload,
  ReloadPluginsResult,
  RemoveScreamProviderPayload,
  RemovePluginPayload,
  RemoveSkillPayload,
  RenameSessionPayload,
  ResumeSessionPayload,
  SessionSummary,
  SetActiveToolsPayload,
  SetScreamConfigPayload,
  SetModelPayload,
  SetModelResult,
  SetPermissionPayload,
  SetPluginEnabledPayload,
  SetPluginMcpServerEnabledPayload,
  SetThinkingPayload,
  SideQuestionPayload,
  SkillSummary,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
  CreateGoalPayload,
  UpdateGoalStatusPayload,
  SetGoalBudgetPayload,
} from './core-api';
import type { ResumedAgentState, ResumeSessionResult } from './resumed';
import type { SDKRPC } from './sdk-api';
import { proxyWithExtraPayload } from './types';
import { JianShellNotFoundError, LocalJian, type Jian } from '@scream-code/jian';
import type { WebSearchProvider } from '../tools/builtin';
import type { ToolServices } from '../tools/support/services';

const SCREAM_CODE_PROVIDER_NAME = 'managed:scream-code';

type AgentScopedPayload<T> = T & { readonly agentId: string };
type SessionScopedPayload<T> = T & { readonly sessionId: string };
type SessionAgentPayload<T> = SessionScopedPayload<AgentScopedPayload<T>>;
type RenameSessionRequest = SessionScopedPayload<RenameSessionPayload>;
type UpdateSessionMetadataRequest = SessionScopedPayload<UpdateSessionMetadataPayload>;


export interface ScreamCoreOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly runtime?: ToolServices | undefined;
  readonly screamRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  readonly skillDirs?: readonly string[];
  readonly subagentModelBindings?: () => Record<string, string | undefined>;
}

export class ScreamCore implements PromisableMethods<CoreAPI> {
  readonly sdk: Promise<SDKRPC>;
  readonly homeDir: string;
  readonly configPath: string;
  readonly sessions = new Map<string, Session>();

  private jian: Promise<Jian>;
  private runtime: ToolServices | undefined;
  private config: ScreamConfig;
  private readonly userHomeDir: string;
  private readonly screamRequestHeaders: Record<string, string> | undefined;
  private readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver | undefined;
  private readonly skillDirs: readonly string[];
  private subagentModelBindings?: () => Record<string, string | undefined>;
  private readonly sessionStore: SessionStore;
  readonly plugins: PluginManager;
  private pluginsReady: Promise<void>;
  private pluginsLoadError: Error | undefined;

  constructor(
    protected readonly rpcClient: CoreRPCClient,
    options: ScreamCoreOptions = {},
  ) {
    this.homeDir = resolveScreamHome(options.homeDir);
    this.userHomeDir = homedir();
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.jian = LocalJian.create().catch((error: unknown) => {
      if (error instanceof JianShellNotFoundError) {
        throw new ScreamError(ErrorCodes.SHELL_GIT_BASH_NOT_FOUND, error.message);
      }
      throw error;
    });
    this.runtime = options.runtime;
    this.screamRequestHeaders = options.screamRequestHeaders;
    this.resolveOAuthTokenProvider = options.resolveOAuthTokenProvider;
    this.skillDirs = options.skillDirs ?? [];
    this.subagentModelBindings = options.subagentModelBindings;
    ensureScreamHome(this.homeDir);
    this.config = loadRuntimeConfig(this.configPath);
    this.sessionStore = new SessionStore(this.homeDir);
    this.plugins = new PluginManager({ screamHomeDir: this.homeDir });
    // Capture the error rather than swallow it: mutators and explicit /plugins
    // reads rethrow so the user sees what's wrong; createSession/resumeSession
    // degrade silently (no plugin skills, no sessionStart injections) so the harness still
    // starts. Reload clears the error on success.
    this.pluginsReady = this.plugins.load().catch((error: unknown) => {
      this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
    });

    this.sdk = rpcClient(this);
  }

  /** Live TUI-owned per-profile model bindings; called at subagent spawn time. */
  setSubagentModelBindings(getter: (() => Record<string, string | undefined>) | undefined): void {
    this.subagentModelBindings = getter;
  }

  /** Resolve the shell environment so missing Git Bash is surfaced early. */
  async preflight(): Promise<void> {
    await this.jian;
  }

  async createSession(input: CreateSessionPayload): Promise<SessionSummary> {
    const options = input;
    const workDir = requiredWorkDir('createSession', options.workDir);
    const config = this.reloadProviderManager();
    const id = options.id ?? createSessionId();
    const thinkingLevel = resolveThinkingLevel(options.thinking, config);
    const permissionMode = options.permission ?? config.defaultPermissionMode;
    const baseMcpConfig = await resolveSessionMcpConfig({
      cwd: workDir,
      homeDir: this.homeDir,
    });
    const summary = await this.sessionStore.create({
      id,
      workDir,
    });
    const result: SessionSummary = {
      ...summary,
      metadata: options.metadata,
    };

    await this.pluginsReady;
    const pluginSessionStarts = this.plugins.enabledSessionStarts();
    const mcpConfig = this.mergePluginMcpConfig(baseMcpConfig);

    // Session ctor attaches its own log sink. If anything in the setup-after-
    // ctor block throws, `session.close()` releases the sink (and mcp).
    const runtime = await this.resolveRuntime(config);
    const session = new Session({
      jian: (await this.jian).withCwd(workDir),
      toolServices: runtime,
      config,
      id,
      homedir: summary.sessionDir,
      screamHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      providerManager: this.resolveProviderManager(summary.id),
      background: config.background,
      hooks: config.hooks,
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      mcpConfig,
      pluginSessionStarts,
      subagentModelBindings: this.subagentModelBindings,
    });
    try {
      session.metadata = {
        ...session.metadata,
        createdAt: new Date(summary.createdAt).toISOString(),
        updatedAt: new Date(summary.updatedAt).toISOString(),
        ...(summary.title !== undefined
          ? {
              title: summary.title,
              isCustomTitle: true,
            }
          : {}),
        custom: options.metadata === undefined ? {} : { ...options.metadata },
      };
      const mainAgent = await session.createMain();
      mainAgent.config.update({
        modelAlias: options.model ?? config.defaultModel,
        thinkingLevel,
      });
      if (permissionMode !== undefined) {
        mainAgent.permission.setMode(permissionMode);
      }
      // Honor config.defaultPlanMode for fresh sessions. Resumed sessions
      // restore their own plan state from records and never re-apply this.
      if (config.defaultPlanMode === true) {
        await mainAgent.planMode.enter();
      }
      await session.writeMetadata();
      await session.flushMetadata();
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
    this.sessions.set(id, session);
    return result;
  }

  getCoreInfo(): CoreInfo {
    return { version: getCoreVersion() };
  }

  getExperimentalFlags(): ExperimentalFlagMap {
    const defs: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS;
    return Object.fromEntries(defs.map((def) => [def.id, flags.enabled(def.id as FlagId)]));
  }

  async closeSession({ sessionId }: CloseSessionPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.close();
      this.sessions.delete(sessionId);
    }
  }

  async deleteSession({ sessionId }: DeleteSessionPayload): Promise<void> {
    const active = this.sessions.get(sessionId);
    if (active) {
      await active.close();
      this.sessions.delete(sessionId);
    }
    await this.sessionStore.delete(sessionId);
  }

  async resumeSession(input: ResumeSessionPayload): Promise<ResumeSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(summary.id);
    if (active !== undefined) {
      return resumeSessionResult(summary, active);
    }

    const config = this.reloadProviderManager();
    const baseMcpConfig = await resolveSessionMcpConfig({
      cwd: summary.workDir,
      homeDir: this.homeDir,
    });
    await this.pluginsReady;
    const pluginSessionStarts = this.plugins.enabledSessionStarts();
    const mcpConfig = this.mergePluginMcpConfig(baseMcpConfig);
    const runtime = await this.resolveRuntime(config);
    const session = new Session({
      jian: (await this.jian).withCwd(summary.workDir),
      toolServices: runtime,
      config,
      id: summary.id,
      homedir: summary.sessionDir,
      screamHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      providerManager: this.resolveProviderManager(summary.id),
      background: config.background,
      hooks: config.hooks,
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      mcpConfig,
      initializeMainAgent: false,
      pluginSessionStarts,
      subagentModelBindings: this.subagentModelBindings,
    });
    let warning: string | undefined;
    try {
      const resumeResult = await session.resume();
      warning = resumeResult.warning;
      await this.refreshSessionRuntimeConfig(session, config);
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
    this.sessions.set(summary.id, session);
    return resumeSessionResult(summary, session, warning);
  }

  async forkSession(input: ForkSessionPayload): Promise<ResumeSessionResult> {
    const source = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(source.id);
    if (active !== undefined) {
      await active.flushMetadata();
    }

    const id = input.id ?? createSessionId();
    await this.sessionStore.fork({
      sourceId: source.id,
      targetId: id,
      title: input.title,
      metadata: input.metadata,
    });
    return this.resumeSession({ sessionId: id });
  }

  async listSessions(input: ListSessionsPayload = {}): Promise<readonly SessionSummary[]> {
    return this.sessionStore.list(input);
  }

  async renameSession({ sessionId, ...payload }: RenameSessionRequest): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      await new SessionAPIImpl(session).renameSession(payload);
      return;
    }
    await this.sessionStore.rename(sessionId, payload.title);
  }

  async exportSession(input: ExportSessionPayload): Promise<ExportSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(input.sessionId);
    // Closed sessions have no `Session.log`; create an ad-hoc child bound to
    // their id so the entries still route to the session log file.
    const exportLog =
      active?.log ?? log.createChild({ sessionId: input.sessionId });
    if (active !== undefined) {
      try {
        await active.flushMetadata();
      } catch (error) {
        exportLog.warn('flushMetadata failed before export', { error });
      }
    }
    await warnIfLogFlushFails(exportLog, 'export session log flush failed', () =>
      getRootLogger().flushSession(input.sessionId),
    );
    if (input.includeGlobalLog === true) {
      await warnIfLogFlushFails(exportLog, 'export global log flush failed', () =>
        getRootLogger().flushGlobal(),
      );
    }
    const result = await exportSessionDirectory({
      request: input,
      summary,
      homeDir: this.homeDir,
      globalLogPath: getRootLogger().getConfig()?.globalLogPath,
    });
    return result;
  }

  async getScreamConfig(input?: GetScreamConfigPayload): Promise<ScreamConfig> {
    if (input?.reload) {
      this.config = loadRuntimeConfig(this.configPath);
    }
    return this.config;
  }

  async setScreamConfig(input: SetScreamConfigPayload): Promise<ScreamConfig> {
    const config = mergeConfigPatch(readConfigFile(this.configPath), input);
    await writeConfigFile(this.configPath, config);
    return this.config = loadRuntimeConfig(this.configPath);
  }

  async removeScreamProvider(input: RemoveScreamProviderPayload): Promise<ScreamConfig> {
    const config = readConfigFile(this.configPath);
    delete config.providers[input.providerId];

    let removedDefault = false;
    const existingModels = config.models ?? {};
    for (const [key, model] of Object.entries(existingModels)) {
      if (
        typeof model === 'object' &&
        model !== null &&
        !Array.isArray(model) &&
        model['provider'] === input.providerId
      ) {
        delete existingModels[key];
        if (config.defaultModel === key) removedDefault = true;
      }
    }
    config.models = existingModels;

    if (removedDefault) {
      config.defaultModel = undefined;
    }

    if (config.defaultProvider === input.providerId) {
      config.defaultProvider = undefined;
    }

    await writeConfigFile(this.configPath, config);
    return this.config = loadRuntimeConfig(this.configPath);
  }

  prompt({ sessionId, ...payload }: SessionAgentPayload<PromptPayload>) {
    return this.sessionApi(sessionId).prompt(payload);
  }

  steer({ sessionId, ...payload }: SessionAgentPayload<SteerPayload>) {
    return this.sessionApi(sessionId).steer(payload);
  }

  cancel({ sessionId, ...payload }: SessionAgentPayload<CancelPayload>) {
    return this.sessionApi(sessionId).cancel(payload);
  }

  async setModel({
    sessionId,
    ...payload
  }: SessionAgentPayload<SetModelPayload>): Promise<SetModelResult> {
    this.reloadProviderManager();
    return this.sessionApi(sessionId).setModel(payload);
  }

  setThinking({ sessionId, ...payload }: SessionAgentPayload<SetThinkingPayload>) {
    return this.sessionApi(sessionId).setThinking(payload);
  }

  setPermission({ sessionId, ...payload }: SessionAgentPayload<SetPermissionPayload>) {
    return this.sessionApi(sessionId).setPermission(payload);
  }

  getModel({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getModel(payload);
  }

  enterPlan({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).enterPlan(payload);
  }

  cancelPlan({ sessionId, ...payload }: SessionAgentPayload<CancelPlanPayload>) {
    return this.sessionApi(sessionId).cancelPlan(payload);
  }

  clearPlan({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).clearPlan(payload);
  }

  enterWolfpack({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).enterWolfpack(payload);
  }

  exitWolfpack({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).exitWolfpack(payload);
  }

  beginCompaction({ sessionId, ...payload }: SessionAgentPayload<BeginCompactionPayload>) {
    return this.sessionApi(sessionId).beginCompaction(payload);
  }

  cancelCompaction({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).cancelCompaction(payload);
  }

  registerTool({ sessionId, ...payload }: SessionAgentPayload<RegisterToolPayload>) {
    return this.sessionApi(sessionId).registerTool(payload);
  }

  unregisterTool({ sessionId, ...payload }: SessionAgentPayload<UnregisterToolPayload>) {
    return this.sessionApi(sessionId).unregisterTool(payload);
  }

  setActiveTools({ sessionId, ...payload }: SessionAgentPayload<SetActiveToolsPayload>) {
    return this.sessionApi(sessionId).setActiveTools(payload);
  }

  stopBackground({ sessionId, ...payload }: SessionAgentPayload<StopBackgroundPayload>) {
    return this.sessionApi(sessionId).stopBackground(payload);
  }

  clearContext({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).clearContext(payload);
  }

  undoHistory({ sessionId, ...payload }: SessionAgentPayload<UndoHistoryPayload>) {
    return this.sessionApi(sessionId).undoHistory(payload);
  }

  activateSkill({
    sessionId,
    ...payload
  }: SessionAgentPayload<ActivateSkillPayload>): Promise<void> {
    return this.sessionApi(sessionId).activateSkill(payload);
  }

  getBackgroundOutput({ sessionId, ...payload }: SessionAgentPayload<GetBackgroundOutputPayload>) {
    return this.sessionApi(sessionId).getBackgroundOutput(payload);
  }

  getBackgroundOutputPath({
    sessionId,
    ...payload
  }: SessionAgentPayload<GetBackgroundOutputPathPayload>) {
    return this.sessionApi(sessionId).getBackgroundOutputPath(payload);
  }

  getContext({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getContext(payload);
  }

  getConfig({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getConfig(payload);
  }

  getPermission({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getPermission(payload);
  }

  getPlan({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getPlan(payload);
  }

  getUsage({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getUsage(payload);
  }

  getTools({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getTools(payload);
  }

  getBackground({ sessionId, ...payload }: SessionAgentPayload<GetBackgroundPayload>) {
    return this.sessionApi(sessionId).getBackground(payload);
  }

  extractMemoriesOnExit({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).extractMemoriesOnExit(payload);
  }

  sideQuestion({ sessionId, ...payload }: SessionAgentPayload<SideQuestionPayload>) {
    return this.sessionApi(sessionId).sideQuestion(payload);
  }

  createGoal({ sessionId, ...payload }: SessionAgentPayload<CreateGoalPayload>) {
    return this.sessionApi(sessionId).createGoal(payload);
  }

  updateGoalStatus({ sessionId, ...payload }: SessionAgentPayload<UpdateGoalStatusPayload>) {
    return this.sessionApi(sessionId).updateGoalStatus(payload);
  }

  cancelGoal({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).cancelGoal(payload);
  }

  getGoal({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getGoal(payload);
  }

  setGoalBudget({ sessionId, ...payload }: SessionAgentPayload<SetGoalBudgetPayload>) {
    return this.sessionApi(sessionId).setGoalBudget(payload);
  }

  updateSessionMetadata({ sessionId, ...payload }: UpdateSessionMetadataRequest): Promise<void> {
    return this.sessionApi(sessionId).updateSessionMetadata(payload);
  }

  getSessionMetadata({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): SessionMeta {
    return this.sessionApi(sessionId).getSessionMetadata(payload);
  }

  listSkills({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): Promise<readonly SkillSummary[]> {
    return this.sessionApi(sessionId).listSkills(payload);
  }
  async removeSkill({
    sessionId,
    ...payload
  }: SessionScopedPayload<RemoveSkillPayload>): Promise<void> {
    return this.sessionApi(sessionId).removeSkill(payload);
  }


  async injectPlugin({ sessionId, id }: SessionScopedPayload<InjectPluginPayload>): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new ScreamError(
        ErrorCodes.SESSION_NOT_FOUND,
        `Session "${sessionId}" was not found`,
        { details: { sessionId } },
      );
    }
    const record = this.plugins.get(id);
    if (record === undefined) {
      throw new ScreamError(
        ErrorCodes.PLUGIN_NOT_FOUND,
        `Plugin "${id}" is not installed`,
        { details: { id } },
      );
    }
    if (record.state !== 'ok' || record.manifest === undefined) {
      throw new ScreamError(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Plugin "${id}" is in an error state and cannot be injected`,
        { details: { id } },
      );
    }
    const skillDirs = record.manifest.skills ?? [];
    if (skillDirs.length === 0) {
      // Nothing to inject; the plugin simply has no skills.
      return;
    }
    const roots: SkillRoot[] = skillDirs.map((dir) => ({
      path: dir,
      source: 'extra',
      plugin: { id: record.id, instructions: record.skillInstructions },
    }));
    await session.injectSkillRoots(roots);
  }
  listMcpServers({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): readonly McpServerInfo[] {
    return this.sessionApi(sessionId).listMcpServers(payload);
  }

  getMcpStartupMetrics({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): Promise<McpStartupMetrics> {
    return this.sessionApi(sessionId).getMcpStartupMetrics(payload);
  }

  reconnectMcpServer({
    sessionId,
    ...payload
  }: SessionScopedPayload<ReconnectMcpServerPayload>): Promise<void> {
    return this.sessionApi(sessionId).reconnectMcpServer(payload);
  }

  addMcpServer({
    sessionId,
    ...payload
  }: SessionScopedPayload<AddMcpServerPayload>): Promise<void> {
    return this.sessionApi(sessionId).addMcpServer(payload);
  }

  stopMcpServer({
    sessionId,
    ...payload
  }: SessionScopedPayload<StopMcpServerPayload>): Promise<void> {
    return this.sessionApi(sessionId).stopMcpServer(payload);
  }

  removeMcpServer({
    sessionId,
    ...payload
  }: SessionScopedPayload<RemoveMcpServerPayload>): Promise<void> {
    return this.sessionApi(sessionId).removeMcpServer(payload);
  }

  async removePlugin({ id }: RemovePluginPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.remove(id);
    for (const session of this.sessions.values()) {
      try {
        session.ejectPlugin(id);
      } catch {
        // Ejection is best-effort; the plugin record is already removed.
      }
    }
  }

  generateAgentsMd({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): Promise<void> {
    return this.sessionApi(sessionId).generateAgentsMd(payload);
  }

  async installPlugin(payload: InstallPluginPayload): Promise<PluginSummary> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const record = await this.plugins.install(payload.source);
    return this.plugins.summaries().find((s) => s.id === record.id)!;
  }

  async listPlugins(_: EmptyPayload): Promise<readonly PluginSummary[]> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    return this.plugins.summaries();
  }

  async setPluginEnabled({ id, enabled }: SetPluginEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setEnabled(id, enabled);
  }

  async setPluginMcpServerEnabled({
    id,
    server,
    enabled,
  }: SetPluginMcpServerEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setMcpServerEnabled(id, server, enabled);
  }


  async reloadPlugins(_: EmptyPayload): Promise<ReloadPluginsResult> {
    try {
      const summary = await this.plugins.reload();
      this.pluginsLoadError = undefined;
      return summary;
    } catch (error) {
      this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
      throw new ScreamError(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Failed to reload plugins: ${this.pluginsLoadError.message}`,
        { cause: error, details: { screamHomeDir: this.homeDir } },
      );
    }
  }

  async getPluginInfo({ id }: GetPluginInfoPayload): Promise<PluginInfo> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const info = this.plugins.info(id);
    if (info === undefined) {
      throw new ScreamError(
        ErrorCodes.PLUGIN_NOT_FOUND,
        `Plugin "${id}" is not installed`,
        { details: { id } },
      );
    }
    return info;
  }

  private assertPluginsLoaded(): void {
    if (this.pluginsLoadError === undefined) return;
    throw new ScreamError(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Plugin state failed to load: ${this.pluginsLoadError.message}. ` +
        `Fix the file at ${this.homeDir}/plugins/installed.json and run /plugins reload.`,
      { cause: this.pluginsLoadError, details: { screamHomeDir: this.homeDir } },
    );
  }

  private async resolveRuntime(config: ScreamConfig): Promise<ToolServices> {
    if (this.runtime !== undefined) {
      return this.runtime;
    }
    const runtime = await createRuntimeConfig({
      config,
      screamRequestHeaders: this.screamRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
    });
    this.runtime = runtime;
    return runtime;
  }

  private resolveSessionSkillConfig(config: ScreamConfig): SessionSkillConfig {
    const explicitDirs = this.skillDirs.length > 0 ? this.skillDirs : undefined;
    return {
      userHomeDir: this.userHomeDir,
      explicitDirs,
      extraDirs: config.extraSkillDirs,
      pluginSkillRoots: this.plugins.pluginSkillRoots(),
      mergeAllAvailableSkills: config.mergeAllAvailableSkills,
    };
  }

  private resolveProviderManager(sessionId: string): ProviderManager {
    return new ProviderManager({
      config: () => this.config,
      screamRequestHeaders: this.screamRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
      promptCacheKey: sessionId,
    });
  }

  private mergePluginMcpConfig(base: SessionMcpConfig | undefined): SessionMcpConfig | undefined {
    const pluginServers = this.plugins.enabledMcpServers();
    if (Object.keys(pluginServers).length === 0) return base;
    return {
      servers: {
        ...base?.servers,
        ...pluginServers,
      },
    };
  }

  private sessionApi(sessionId: string): SessionAPIImpl {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new ScreamError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
        details: { sessionId },
      });
    }
    return new SessionAPIImpl(session);
  }

  private reloadProviderManager(): ScreamConfig {
    return this.config = loadRuntimeConfig(this.configPath);
  }

  private async refreshSessionRuntimeConfig(
    session: Session,
    config: ScreamConfig,
  ): Promise<void> {
    const api = new SessionAPIImpl(session);
    // A session migrated from an external tool carries no model, and any
    // session may reference a model alias that no longer exists in config.toml.
    // Try the session's own model first, then fall back to the configured
    // default, so resume degrades gracefully instead of hard-failing.
    const requested = (await api.getModel({ agentId: 'main' })).trim();
    const fallback = config.defaultModel?.trim() ?? '';
    const candidates = [...new Set([requested, fallback].filter((model) => model.length > 0))];
    for (const model of candidates) {
      try {
        await api.setModel({ agentId: 'main', model });
        await session.flushMetadata();
        return;
      } catch (error) {
        // Skip a candidate only when the alias is genuinely absent from
        // config (a stale or migrated model) — that is the graceful-degrade
        // case. A *configured* alias that fails to resolve (missing provider,
        // no credentials, bad max_context_size) is an actionable config error
        // the user must see; surface it instead of silently swapping models.
        const aliasMissing = config.models?.[model] === undefined;
        if (
          aliasMissing &&
          error instanceof ScreamError &&
          error.code === ErrorCodes.CONFIG_INVALID
        ) {
          continue;
        }
        throw error;
      }
    }
  }
}


async function createRuntimeConfig(input: {
  readonly config: ScreamConfig;
  readonly screamRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
}): Promise<ToolServices> {
  const fetchCache = new FetchCache();
  const localFetcher = new LocalFetchURLProvider({ cache: fetchCache });
  const fetchService = input.config.services?.screamCliFetch;

  return {
    urlFetcher:
      fetchService?.baseUrl === undefined
        ? localFetcher
        : new ScreamCliFetchURLProvider({
            baseUrl: fetchService.baseUrl,
            localFallback: localFetcher,
            defaultHeaders: input.screamRequestHeaders,
            cache: fetchCache,
            ...serviceCredentials(fetchService, input.resolveOAuthTokenProvider),
          }),
    webSearcher: buildWebSearcher(input),
  };
}

function buildWebSearcher(input: {
  readonly config: ScreamConfig;
  readonly screamRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
}): WebSearchProvider | undefined {
  const searchService = input.config.services?.screamCliSearch;
  const ddgEnabled = input.config.services?.duckduckgo?.enabled !== false;

  const screamProvider: WebSearchProvider | undefined =
    searchService?.baseUrl !== undefined
      ? new ScreamCliWebSearchProvider({
          baseUrl: searchService.baseUrl,
          defaultHeaders: input.screamRequestHeaders,
          ...serviceCredentials(searchService, input.resolveOAuthTokenProvider),
        })
      : undefined;

  const ddgProvider: WebSearchProvider | undefined = ddgEnabled
    ? new DuckDuckGoSearchProvider()
    : undefined;

  if (screamProvider && ddgProvider) {
    return new FallbackSearchProvider([screamProvider, ddgProvider]);
  }
  return screamProvider ?? ddgProvider;
}

function serviceCredentials(
  service: ScreamCliServiceConfig,
  resolveOAuthTokenProvider: OAuthTokenProviderResolver | undefined,
): {
  readonly apiKey?: string | undefined;
  readonly tokenProvider?: BearerTokenProvider | undefined;
  readonly customHeaders?: Record<string, string> | undefined;
} {
  const apiKey = nonEmptyString(service.apiKey);
  return {
    apiKey,
    tokenProvider:
      service.oauth !== undefined
        ? resolveOAuthTokenProvider?.(SCREAM_CODE_PROVIDER_NAME, service.oauth)
        : undefined,
    customHeaders: service.customHeaders,
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function requiredWorkDir(operation: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScreamError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, `${operation} requires workDir`);
  }
  return normalizeWorkDir(value);
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}


async function resumeSessionResult(
  summary: SessionSummary,
  session: Session,
  warning?: string,
): Promise<ResumeSessionResult> {
  const api = new SessionAPIImpl(session);
  const agents: Record<string, ResumedAgentState> = {};
  for (const [agentId, agent] of session.agents) {
    const config = await api.getConfig({ agentId });
    const context = await api.getContext({ agentId });
    const permission = await api.getPermission({ agentId });
    const plan = await api.getPlan({ agentId });
    const usage = await api.getUsage({ agentId });
    agents[agentId] = {
      type: agent.type,
      config,
      context,
      replay: agent.replayBuilder.buildResult(),
      permission,
      plan,
      usage,
      tools: await api.getTools({ agentId }),
      toolStore: agent.tools.storeData(),
      background: agent.background.list(false),
    };
  }
  return {
    ...summary,
    sessionMetadata: api.getSessionMetadata({}),
    agents,
    warning,
  };
}

async function warnIfLogFlushFails(
  exportLog: Logger,
  message: string,
  flush: () => Promise<boolean>,
): Promise<void> {
  try {
    if (await flush()) return;
    exportLog.warn(message);
  } catch (error) {
    exportLog.warn(message, { error });
  }
  try {
    await flush();
  } catch {}
}
