import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { join } from 'pathe';

import { ErrorCodes, ScreamError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import {
  ExtensionRuntime,
  PluginManager,
  isPluginMcpRuntimeName,
  pluginIdFromMcpRuntimeName,
  type PluginSyncApplied,
  type PluginSyncFailure,
  type PluginSyncReport,
} from '#/plugin';
import { FetchCache } from '#/tools/providers/fetch-cache';
import { LocalFetchURLProvider } from '#/tools/providers/local-fetch-url';
import { DuckDuckGoSearchProvider } from '#/tools/providers/duckduckgo-search';
import { BaiduSearchProvider, So360SearchProvider, SogouSearchProvider } from '#/tools/providers/domestic-search';
import { FallbackSearchProvider } from '#/tools/providers/fallback-search';
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
} from '../config';
import {
  FLAG_DEFINITIONS,
  flags,
  type ExperimentalFlagMap,
  type FlagDefinitionInput,
  type FlagId,
} from '../flags';
import type { Logger } from '../logging/types';
import { LspProcessSupervisor } from '../lsp/process-supervisor';
import { resolveSessionMcpConfig, type SessionMcpConfig } from '../mcp';
import type { McpServerConfig } from '../config/schema';
import { Session, type SessionMeta, type SessionSkillConfig } from '../session';
import type { SkillRoot } from '../skill';
import { exportSessionDirectory } from '../session/export';
import {
  ProviderManager,
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
  SetRlmEnabledPayload,
  SetRlmMaxDepthPayload,
  SetScreamConfigPayload,
  SetModelPayload,
  SetModelResult,
  SetPermissionPayload,
  SetRuntimeSystemPromptPayload,
  SetPluginEnabledPayload,
  SetPluginMcpServerEnabledPayload,
  EnterPlanPayload,
  SetPlanStrategyPayload,
  SetThinkingPayload,
  SideQuestionPayload,
  GenerateTextPayload,
  SkillSummary,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
  CreateGoalPayload,
  UpdateGoalStatusPayload,
  UpdateGoalObjectivePayload,
  SetGoalBudgetPayload,
} from './core-api';
import type { ResumedAgentState, ResumeSessionResult } from './resumed';
import type { SDKRPC } from './sdk-api';
import { proxyWithExtraPayload } from './types';
import { JianShellNotFoundError, LocalJian, type Environment, type Jian } from '@scream-code/jian';
import type { WebSearchProvider } from '../tools/builtin';
import type { ToolServices } from '../tools/support/services';

type AgentScopedPayload<T> = T & { readonly agentId: string };
type SessionScopedPayload<T> = T & { readonly sessionId: string };
type SessionAgentPayload<T> = SessionScopedPayload<AgentScopedPayload<T>>;
type RenameSessionRequest = SessionScopedPayload<RenameSessionPayload>;
type UpdateSessionMetadataRequest = SessionScopedPayload<UpdateSessionMetadataPayload>;
type SetRuntimeSystemPromptRequest = SessionScopedPayload<SetRuntimeSystemPromptPayload>;


export interface ScreamCoreOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly runtime?: ToolServices | undefined;
  readonly screamRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  readonly skillDirs?: readonly string[];
  readonly subagentModelBindings?: () => Record<string, string | undefined>;
}

const ENV_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface EnvironmentCacheEntry extends Environment {
  /** Unix ms timestamp of when this entry was written. */
  cachedAt: number;
}

/**
 * Reads a previously detected host environment from the scream home dir.
 * Windows environment detection walks PATH and stats dozens of candidates
 * (~60-110 filesystem probes), so every fresh process paid that cost at
 * startup. Returns `undefined` when the cache is missing, expired, or the
 * entry's shell no longer exists (verified with a single stat).
 */
export async function readEnvironmentCache(homeDir: string): Promise<Environment | undefined> {
  try {
    const raw = await readFile(join(homeDir, 'environment-cache.json'), 'utf8');
    const entry = JSON.parse(raw) as EnvironmentCacheEntry;
    if (typeof entry?.cachedAt !== 'number' || Date.now() - entry.cachedAt >= ENV_CACHE_TTL_MS) {
      return undefined;
    }
    if (entry.osVersion !== release()) {
      return undefined;
    }
    if (typeof entry.shellPath !== 'string' || entry.shellPath.length === 0) {
      return undefined;
    }
    // SCREAM_SHELL_PATH is a documented explicit override (see
    // detectEnvironment). If it is set and differs from the cached shell,
    // the cache must not win — treat it as a miss. Compare like the
    // detector does: trimmed, and case-insensitively on Windows where
    // paths are case-insensitive.
    const explicitShell = process.env['SCREAM_SHELL_PATH']?.trim();
    if (explicitShell !== undefined && explicitShell.length > 0) {
      const same =
        process.platform === 'win32'
          ? explicitShell.toLowerCase() === entry.shellPath.toLowerCase()
          : explicitShell === entry.shellPath;
      if (!same) {
        return undefined;
      }
    }
    const st = await stat(entry.shellPath);
    if (!st.isFile()) {
      return undefined;
    }
    const { cachedAt: _cachedAt, ...env } = entry;
    return env;
  } catch {
    return undefined;
  }
}

/** Persists a detected host environment so the next process can skip detection. */
export async function writeEnvironmentCache(homeDir: string, env: Environment): Promise<void> {
  const entry: EnvironmentCacheEntry = { ...env, cachedAt: Date.now() };
  await writeFile(join(homeDir, 'environment-cache.json'), JSON.stringify(entry), 'utf8');
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
  /** Tracks/reaps LSP child processes for every session in this core. */
  readonly lspSupervisor: LspProcessSupervisor;
  readonly plugins: PluginManager;
  /** Loads/activates code-entry plugins (manifest `entryPoint`). */
  readonly extensionRuntime = new ExtensionRuntime();
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
    this.jian = this.resolveLocalJian().catch((error: unknown) => {
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
    // Reap stale LSP owners left by crashed hosts before any new session can
    // start a server. The sweep is async (ps scans) and never blocks startup.
    this.lspSupervisor = new LspProcessSupervisor({ screamHomeDir: this.homeDir });
    void this.lspSupervisor.recoverStaleOwners().catch((error: unknown) => {
      log.error('lsp owner recovery failed', error);
    });
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

  /**
   * Resolve the shell environment so missing Git Bash is surfaced early.
   */
  async preflight(): Promise<void> {
    await this.jian;
  }

  /**
   * Builds the LocalJian, preferring a cached host environment so Windows
   * startups skip the expensive PATH/filesystem detection. On a cache miss
   * the full detection runs once and the result is persisted for the next
   * process.
   */
  private async resolveLocalJian(): Promise<LocalJian> {
    const cached = await readEnvironmentCache(this.homeDir);
    if (cached !== undefined) {
      return LocalJian.create(undefined, undefined, cached);
    }
    const jian = await LocalJian.create();
    await writeEnvironmentCache(this.homeDir, jian.osEnv).catch(() => {
      // Cache writes are best-effort: a read-only home dir just means the
      // next startup re-detects.
    });
    return jian;
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
      lspSupervisor: this.lspSupervisor,
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
      lspSupervisor: this.lspSupervisor,
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

  setRuntimeSystemPrompt({ sessionId, ...payload }: SetRuntimeSystemPromptRequest) {
    return this.sessionApi(sessionId).setRuntimeSystemPrompt(payload);
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

  enterPlan({ sessionId, ...payload }: SessionAgentPayload<EnterPlanPayload>) {
    return this.sessionApi(sessionId).enterPlan(payload);
  }

  setPlanStrategy({ sessionId, ...payload }: SessionAgentPayload<SetPlanStrategyPayload>) {
    return this.sessionApi(sessionId).setPlanStrategy(payload);
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

  /**
   * Activate a code plugin (one with a manifest `entryPoint`) on the session's
   * main agent: injects declared manifest hooks into the agent's HookEngine and
   * calls the plugin's `activate(context)`.
   */
  async activatePlugin({
    sessionId,
    pluginId,
  }: {
    sessionId: string;
    pluginId: string;
  }): Promise<void> {
    await this.pluginsReady;
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new ScreamError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
        details: { sessionId },
      });
    }
    const agent = session.agents.get('main');
    if (agent === undefined) {
      throw new ScreamError(
        ErrorCodes.AGENT_NOT_FOUND,
        `Session "${sessionId}" has no main agent`,
        { details: { sessionId } },
      );
    }
    const plugin = this.plugins.list().find((record) => record.id === pluginId);
    if (plugin === undefined) {
      throw new ScreamError(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin "${pluginId}" was not found`, {
        details: { pluginId },
      });
    }
    const [extension] = this.extensionRuntime.discover([plugin]);
    if (extension === undefined) {
      throw new ScreamError(
        ErrorCodes.PLUGIN_NOT_FOUND,
        `Plugin "${pluginId}" has no code entry point`,
        { details: { pluginId } },
      );
    }
    try {
      await this.extensionRuntime.activate(agent, extension);
    } catch (error) {
      // Keep the user-visible failure, but first put the reason on the plugin
      // record so `/plugin info` explains why it is unusable.
      await this.markPluginError(pluginId, error);
      throw error;
    }
    // Activation is the user's code-execution approval; the plugin's skills
    // and MCP servers now hot-apply to every live session.
    await this.syncSessionsBestEffort([pluginId]);
  }

  /**
   * Best-effort bookkeeping for a failed activation: a `markError` failure must
   * not replace the activation error the caller is about to see.
   */
  private async markPluginError(pluginId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.plugins.markError(pluginId, message);
    } catch (markError: unknown) {
      log.warn('failed to record plugin activation error', {
        pluginId,
        reason: markError instanceof Error ? markError.message : String(markError),
      });
    }
  }

  /** Deactivate a code plugin (removes its hooks and runs its deactivate). */
  async deactivatePlugin({ pluginId }: { pluginId: string }): Promise<void> {
    await this.pluginsReady;
    await this.extensionRuntime.deactivate(pluginId);
    // A deactivated plugin's code is gone, so its in-process tools must stop
    // being offered; leaving them registered would present a broken limb to
    // the model. Skills and MCP servers stay until disable/remove.
    for (const session of this.sessions.values()) {
      for (const agent of session.agents.values()) {
        try {
          agent.tools.unregisterToolsByOwner(pluginId);
        } catch {
          // Per-agent isolation; the deactivation itself already succeeded.
        }
      }
    }
  }

  /** Code plugins the runtime can load, with their activation state. */
  async pluginExtensionStatus(): Promise<
    readonly { pluginId: string; entryPoint: string; active: boolean }[]
  > {
    await this.pluginsReady;
    return this.extensionRuntime
      .discover(this.plugins.list())
      .map((extension) => ({
        pluginId: extension.pluginId,
        entryPoint: extension.entryPoint,
        active: this.extensionRuntime.isActive(extension.pluginId),
      }));
  }

  unregisterTool({ sessionId, ...payload }: SessionAgentPayload<UnregisterToolPayload>) {
    return this.sessionApi(sessionId).unregisterTool(payload);
  }

  setActiveTools({ sessionId, ...payload }: SessionAgentPayload<SetActiveToolsPayload>) {
    return this.sessionApi(sessionId).setActiveTools(payload);
  }

  setRlmEnabled({ sessionId, ...payload }: SessionAgentPayload<SetRlmEnabledPayload>) {
    return this.sessionApi(sessionId).setRlmEnabled(payload);
  }

  setRlmMaxDepth({ sessionId, ...payload }: SessionAgentPayload<SetRlmMaxDepthPayload>) {
    return this.sessionApi(sessionId).setRlmMaxDepth(payload);
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

  generateText({ sessionId, ...payload }: SessionAgentPayload<GenerateTextPayload>) {
    return this.sessionApi(sessionId).generateText(payload);
  }

  createGoal({ sessionId, ...payload }: SessionAgentPayload<CreateGoalPayload>) {
    return this.sessionApi(sessionId).createGoal(payload);
  }

  updateGoalStatus({ sessionId, ...payload }: SessionAgentPayload<UpdateGoalStatusPayload>) {
    return this.sessionApi(sessionId).updateGoalStatus(payload);
  }

  updateGoalObjective({ sessionId, ...payload }: SessionAgentPayload<UpdateGoalObjectivePayload>) {
    return this.sessionApi(sessionId).updateGoalObjective(payload);
  }

  cancelGoal({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).cancelGoal(payload);
  }

  getGoal({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getGoal(payload);
  }

  getTodos({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getTodos(payload);
  }

  setGoalBudget({ sessionId, ...payload }: SessionAgentPayload<SetGoalBudgetPayload>) {
    return this.sessionApi(sessionId).setGoalBudget(payload);
  }

  getWolfpackMode({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getWolfpackMode(payload);
  }

  getRlmEnabled({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getRlmEnabled(payload);
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

  /**
   * Push the current plugin table into every live session: plugin MCP servers,
   * plugin skills, and in-process code/tool teardown for plugins that stopped
   * being live. This is the hot-apply path behind `ToolServices.pluginSync`
   * and the plugin write RPCs.
   *
   * Contract:
   * - MCP edits are confined to plugin-owned runtime names (`plugin-<id>:<server>`);
   *   user-configured servers are never touched.
   * - `skipMcpAdd` honors "install never executes": skill data hot-applies, but
   *   no plugin MCP process is started until an explicit enable/activate/reload.
   * - A changed id whose record is gone, disabled, or errored gets its code
   *   deactivated and its owned user tools dropped before its capabilities are
   *   pulled from sessions. A live id is never activated here — running code
   *   still requires an explicit, separately approved `activate`.
   * - Every sub-action is isolated: failures accumulate in `failed[]` and this
   *   returns a report; it never throws back to a caller whose plugin mutation
   *   already succeeded.
   */
  async applyPluginChangesToSessions(
    changedIds?: readonly string[],
    options?: { skipMcpAdd?: boolean },
  ): Promise<PluginSyncReport> {
    await this.pluginsReady;
    const applied: PluginSyncApplied[] = [];
    const failed: PluginSyncFailure[] = [];
    const messageOf = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    let desired: Record<string, McpServerConfig> = {};
    // If the desired table cannot be read, MCP deletions must stop too: an
    // empty-by-fallback map would read as "remove everything" and tear the
    // healthy plugins' servers down along with it.
    let desiredUnknown = false;
    try {
      desired = this.plugins.enabledMcpServers();
    } catch (error) {
      desiredUnknown = true;
      failed.push({ step: 'mcp.add', message: messageOf(error) });
    }

    // Targets: explicit ids, or (full rescan) everything installed plus every
    // plugin still represented inside a session (stale MCP entries the table
    // no longer wants must still be found to be removed).
    const targets = new Set<string>(changedIds ?? []);
    if (changedIds === undefined) {
      try {
        for (const record of this.plugins.list()) targets.add(record.id);
      } catch (error) {
        failed.push({ step: 'mcp.add', message: messageOf(error) });
      }
      for (const [sessionId, session] of this.sessions) {
        try {
          for (const entry of session.mcp.list()) {
            if (!isPluginMcpRuntimeName(entry.name)) continue;
            const id = pluginIdFromMcpRuntimeName(entry.name);
            if (id !== undefined) targets.add(id);
          }
        } catch (error) {
          failed.push({ step: 'mcp.remove', message: `session ${sessionId}: ${messageOf(error)}` });
        }
      }
    }

    const isLive = (id: string): boolean => {
      const record = this.plugins.get(id);
      return record !== undefined && record.enabled && record.state === 'ok';
    };

    // Process-level unwind first: the extension runtime and user-tool
    // ownership are per-process state with no per-session copy.
    for (const id of targets) {
      if (isLive(id)) continue;
      if (this.extensionRuntime.isActive(id)) {
        try {
          await this.extensionRuntime.deactivate(id);
          applied.push({ kind: 'plugin.deactivate', name: id, session: 'host' });
        } catch (error) {
          failed.push({ step: 'plugin.deactivate', pluginId: id, message: messageOf(error) });
        }
      }
      for (const [sessionId, session] of this.sessions) {
        for (const agent of session.agents.values()) {
          try {
            const removed = agent.tools.unregisterToolsByOwner(id);
            if (removed > 0) applied.push({ kind: 'tools.remove', name: id, session: sessionId });
          } catch (error) {
            failed.push({ step: 'tools.remove', pluginId: id, message: messageOf(error) });
          }
        }
      }
    }

    // Per-session capability sync: MCP diff, then skills (eject → inject).
    for (const [sessionId, session] of this.sessions) {
      let actualNames = new Set<string>();
      try {
        actualNames = new Set(session.mcp.list().map((entry) => entry.name));
      } catch (error) {
        failed.push({ step: 'mcp.add', message: messageOf(error) });
      }
      for (const id of targets) {
        const live = isLive(id);
        // MCP add/remove are only safe while the desired table is known;
        // a corrupt table must freeze capability edits, not invert them.
        if (!desiredUnknown) {
          for (const name of actualNames) {
            if (!isPluginMcpRuntimeName(name)) continue;
            if (pluginIdFromMcpRuntimeName(name) !== id) continue;
            if (live && desired[name] !== undefined) continue;
            try {
              await session.mcp.removeServer(name);
              applied.push({ kind: 'mcp.remove', name, session: sessionId });
              actualNames.delete(name);
            } catch (error) {
              failed.push({ step: 'mcp.remove', pluginId: id, message: messageOf(error) });
            }
          }
          if (live && options?.skipMcpAdd !== true) {
            for (const [name, config] of Object.entries(desired)) {
              if (pluginIdFromMcpRuntimeName(name) !== id) continue;
              if (actualNames.has(name)) continue;
              try {
                await session.mcp.addServer(name, config);
                applied.push({ kind: 'mcp.add', name, session: sessionId });
                actualNames.add(name);
              } catch (error) {
                failed.push({ step: 'mcp.add', pluginId: id, message: messageOf(error) });
              }
            }
          }
        }
        try {
          session.ejectPlugin(id);
          applied.push({ kind: 'skills.eject', name: id, session: sessionId });
          if (live) {
            const roots = this.plugins
              .pluginSkillRoots()
              .filter((root) => root.plugin?.id === id);
            if (roots.length > 0) {
              await session.injectSkillRoots(roots);
              applied.push({ kind: 'skills.inject', name: id, session: sessionId });
            }
          }
        } catch (error) {
          failed.push({
            step: live ? 'skills.inject' : 'skills.eject',
            pluginId: id,
            message: messageOf(error),
          });
        }
      }
    }

    return { ok: failed.length === 0, sessions: this.sessions.size, applied, failed };
  }

  /**
   * Best-effort wrapper for hot-apply after a successful plugin write: the
   * mutation already landed, so a sync surprise must never fail the RPC or
   * the tool call that triggered it.
   */
  private async syncSessionsBestEffort(
    changedIds?: readonly string[],
    options?: { skipMcpAdd?: boolean },
  ): Promise<void> {
    try {
      await this.applyPluginChangesToSessions(changedIds, options);
    } catch (error) {
      log.warn('plugin hot-apply failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async removePlugin({ id }: RemovePluginPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.remove(id);
    // Full teardown in one place: the sync deactivates the plugin's code,
    // drops its in-process tools, and removes its MCP servers and skills from
    // every live session (replacing the previous best-effort eject loop).
    await this.applyPluginChangesToSessions([id]);
  }

  generateAgentsMd({ sessionId, ...payload }: SessionScopedPayload<{ targetDir?: string | undefined }>): Promise<void> {
    return this.sessionApi(sessionId).generateAgentsMd(payload);
  }

  async installPlugin(payload: InstallPluginPayload): Promise<PluginSummary> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const record = await this.plugins.install(payload.source);
    // Install-only hot-apply: the plugin's skills become visible now, but no
    // MCP process is started — that would cross the "install never executes"
    // boundary. enable/activate/reload complete the capability picture.
    await this.syncSessionsBestEffort([record.id], { skipMcpAdd: true });
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
    // Enable hot-adds the plugin's capabilities; disable tears the whole
    // surface down (code, tools, MCP, skills) through the same sync pass.
    await this.syncSessionsBestEffort([id]);
  }

  async setPluginMcpServerEnabled({
    id,
    server,
    enabled,
  }: SetPluginMcpServerEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setMcpServerEnabled(id, server, enabled);
    await this.syncSessionsBestEffort([id]);
  }


  async reloadPlugins(_: EmptyPayload): Promise<ReloadPluginsResult> {
    try {
      const summary = await this.plugins.reload();
      this.pluginsLoadError = undefined;
      // The table just re-read from disk: full rescan so anything added,
      // removed, or broken on disk converges in every live session.
      await this.syncSessionsBestEffort();
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
    const base = this.runtime ?? (await createRuntimeConfig({ config }));
    this.runtime = base;
    // The live PluginManager is handed to tools so a plugin installed from
    // inside the process registers on the shared table instead of writing
    // installed.json through a second, disconnected instance. The matching
    // ExtensionRuntime rides along for the same reason: activation state for
    // code plugins has exactly one owner per process.
    return {
      ...base,
      plugins: this.plugins,
      extensionRuntime: this.extensionRuntime,
      // Tools that mutate plugins push the change into live sessions through
      // this host-owned entry point (the host owns the session table).
      pluginSync: (changedIds, syncOptions) =>
        this.applyPluginChangesToSessions(changedIds, syncOptions),
    };
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
}): Promise<ToolServices> {
  const fetchCache = new FetchCache();

  return {
    urlFetcher: new LocalFetchURLProvider({ cache: fetchCache }),
    webSearcher: buildWebSearcher(input),
  };
}

function buildWebSearcher(input: {
  readonly config: ScreamConfig;
}): WebSearchProvider | undefined {
  const services = input.config.services;

  // Chain order: global engine first, then domestic (China-reachable)
  // engines as the tail — Baidu is the final always-on fallback.
  const providers: WebSearchProvider[] = [];
  if (services?.duckduckgo?.enabled !== false) providers.push(new DuckDuckGoSearchProvider());
  if (services?.sogou?.enabled !== false) providers.push(new SogouSearchProvider());
  if (services?.so360?.enabled !== false) providers.push(new So360SearchProvider());
  if (services?.baidu?.enabled !== false) providers.push(new BaiduSearchProvider());

  if (providers.length === 0) return undefined;
  return providers.length === 1 ? providers[0] : new FallbackSearchProvider(providers);
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
