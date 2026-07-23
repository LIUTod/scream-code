import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'pathe';
import type { Jian } from '@scream-code/jian';

import { ErrorCodes, ScreamError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import type { Logger, SessionLogHandle } from '#/logging/types';
import type { RuntimeSystemPrompt, ScreamConfig, SDKSessionRPC } from '#/rpc';
import { proxyWithExtraPayload } from '#/rpc/types';

import { Agent, type AgentOptions, type AgentType } from '../agent';
import { HookEngine, type HookDef } from './hooks';
import type { PermissionManagerOptions, PermissionRule } from '../agent/permission';
import { parseBooleanEnv, resolveConfigValue, type BackgroundConfig } from '../config';
import { makeErrorPayload } from '../errors';
import {
  McpConnectionManager,
  McpOAuthService,
  type McpServerEntry,
  type SessionMcpConfig,
} from '../mcp';
import type { EnabledPluginSessionStart } from '../plugin';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_INIT_PROMPT,
  loadAgentsMd,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import type { ProviderManager } from './provider-manager';
import {
  registerBuiltinSkills,
  resolveSkillInstallUnit,
  resolveSkillRoots,
  SkillRegistry,
  summarizeSkill,
  type SkillRoot,
  type SkillSummary,
} from '../skill';
import { SessionSubagentHost } from './subagent-host';
import type { ToolServices } from '../tools/support/services';

export interface SessionOptions {
  readonly jian: Jian;
  readonly config?: ScreamConfig;
  readonly id?: string | undefined;
  readonly homedir: string;
  readonly screamHomeDir?: string;
  readonly rpc: SDKSessionRPC;
  readonly toolServices?: ToolServices;
  readonly initializeMainAgent?: boolean | undefined;
  readonly providerManager?: ProviderManager | undefined;
  readonly background?: BackgroundConfig | undefined;
  readonly hooks?: readonly HookDef[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly skills?: SessionSkillConfig;
  readonly mcpConfig?: SessionMcpConfig;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly subagentModelBindings?: () => Record<string, string | undefined>;
}

export interface SessionSkillConfig {
  readonly userHomeDir?: string;
  readonly explicitDirs?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly pluginSkillRoots?: readonly SkillRoot[];
  readonly mergeAllAvailableSkills?: boolean;
  readonly builtinDir?: string;
}

export interface AgentMeta {
  readonly homedir: string;
  readonly type: AgentType;
  readonly parentAgentId: string | null;
}

export interface SessionMeta {
  createdAt: string;
  updatedAt: string;
  title: string;
  isCustomTitle: boolean;
  lastPrompt?: string;
  forkedFrom?: string;
  agents: Record<string, AgentMeta>;
  custom: Record<string, any>;
}

const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'SCREAM_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';

export class Session {
  readonly rpc: SDKSessionRPC;
  readonly skills: SkillRegistry;
  readonly agents: Map<string, Agent> = new Map();
  readonly mcp: McpConnectionManager;
  readonly log: Logger;
  private readonly logHandle: SessionLogHandle | undefined;
  readonly hookEngine: HookEngine;
  private agentIdCounter = 0;
  private readonly skillsReady: Promise<void>;
  private readonly mcpReady: Promise<void>;
  metadata: SessionMeta = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
  };
  private writeMetadataPromise = Promise.resolve();
  private runtimeSystemPrompt: RuntimeSystemPrompt = {};

  constructor(public readonly options: SessionOptions) {
    // Attach the per-session log sink up front so the constructor's
    // awaited `loadSkills` / `loadMcpServers` failures land in the session
    // log, not just global.
    this.logHandle =
      options.id === undefined
        ? undefined
        : getRootLogger().attachSession({
            sessionId: options.id,
            sessionDir: options.homedir,
          });
    this.log =
      this.logHandle?.logger ??
      (options.id === undefined ? log : log.createChild({ sessionId: options.id }));
    this.rpc = options.rpc;
    this.hookEngine = new HookEngine(options.hooks, {
      cwd: options.jian.getcwd(),
      sessionId: options.id,
    });
    this.skills = new SkillRegistry({ sessionId: options.id });
    this.mcp = new McpConnectionManager({
      oauthService: new McpOAuthService({ screamHomeDir: options.screamHomeDir }),
      log: this.log,
    });
    this.mcp.onStatusChange((entry) => {
      this.onMcpServerStatusChange(entry);
    });
    this.skillsReady = this.loadSkills()
      .catch((error: unknown) => {
        this.log.error('skills load failed', error);
      })
      .then(() => {
        this.refreshAgentBuiltinTools();
      });
    this.mcpReady = this.loadMcpServers().catch((error: unknown) => {
      this.emitInitialMcpLoadError(error);
    });
  }
  async createMain() {
    const { agent } = await this.createAgent({ type: 'main' }, DEFAULT_AGENT_PROFILES['agent']);
    await agent.memoStoreReady;
    await agent.knowledgeStoreReady;
    await this.triggerSessionStart('startup');
    return agent;
  }

  async resume(): Promise<{ warning?: string }> {
    await this.skillsReady;
    const { agents } = await this.readMetadata();
    this.agents.clear();
    let warning: string | undefined;
    const resumeTasks = Object.keys(agents).map(async (id) => {
      const agent = this.ensureResumeAgentInstantiated(id, agents);
      await agent.memoStoreReady;
      await agent.knowledgeStoreReady;
      const result = await agent.resume();
      if (result.warning !== undefined && warning === undefined) {
        warning = result.warning;
      }
    });
    await Promise.all(resumeTasks);
    const resumeWarning = warning;
    // A session migrated from an external tool ships a wire without the
    // `config.update` bootstrap events a natively-created agent writes, so the
    // main agent comes back with an empty system prompt and no tools. Apply the
    // default profile so the resumed session is usable. Native sessions always
    // replay a non-empty system prompt and never enter this branch.
    const main = this.agents.get('main');
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    // Reload AGENTS.md on every resume so edits take effect
    // without requiring session deletion / recreation.
    if (main !== undefined && profile !== undefined) {
      await this.bootstrapAgentProfile(main, profile);
    }
    if (main !== undefined && this.metadata.custom?.['recap']) {
      main.context.appendSystemReminder(this.metadata.custom['recap'] as string, {
        kind: 'injection',
        variant: 'recap',
      });
    }
    await this.triggerSessionStart('resume');
    return { warning: resumeWarning };
  }

  async close(): Promise<void> {
    const main = this.agents.get('main');
    if (main !== undefined) {
      const recap = main.sessionMemory.getSessionSummary();
      if (recap.length > 0) {
        this.metadata.custom = { ...this.metadata.custom, recap };
        this.writeMetadata().catch((error: unknown) => {
          this.log.error('failed to write session recap metadata', error);
        });
      }
    }
    try {
      // Cancel any in-flight turn so the session can be resumed or have its
      // model switched without inheriting a stuck/partial tool exchange.
      for (const agent of this.agents.values()) {
        if (agent.turn.hasActiveTurn) {
          agent.turn.cancel();
        }
      }
      await Promise.allSettled(
        Array.from(this.agents.values(), async (agent) => agent.cron?.stop()),
      );
      await this.stopBackgroundTasksOnExit();
      await this.flushMetadata();
      await this.triggerSessionEnd('exit');
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  private async stopBackgroundTasksOnExit(): Promise<void> {
    const keepAliveOnExit = resolveConfigValue({
      env: process.env,
      envKey: BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV,
      configValue: this.options.background?.keepAliveOnExit,
      defaultValue: true,
      parseEnv: parseBooleanEnv,
    });
    if (keepAliveOnExit) return;
    await Promise.all(
      Array.from(this.agents.values(), (agent) =>
        agent.background.stopAll('Session closed'),
      ),
    );
  }

  async createAgent(
    config: Partial<AgentOptions>,
    profile?: ResolvedAgentProfile,
    parentAgentId?: string | undefined,
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    await this.skillsReady;
    const type = config.type ?? 'main';
    const id = type === 'main' ? 'main' : this.nextGeneratedAgentId();
    const homedir = config.homedir ?? join(this.options.homedir, 'agents', id);
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId ?? null);
    if (profile) {
      await this.bootstrapAgentProfile(agent, profile);
    }

    this.agents.set(id, agent);
    this.metadata.agents[id] = {
      homedir,
      type,
      parentAgentId: parentAgentId ?? null,
    };
    this.writeMetadata().catch((error: unknown) => {
      this.log.error('failed to write session metadata after agent creation', error);
    });

    return { id, agent };
  }

  /**
   * Applies a profile's derived config — cwd, system prompt, active tools — to
   * an agent. Fresh creation and resume-of-an-incomplete-wire both route
   * through here so the two paths cannot drift apart.
   */
  private async bootstrapAgentProfile(
    agent: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    const context = await prepareSystemPromptContext(agent.jian);
    agent.useProfile(profile, context);
  }

  async generateAgentsMd(targetDir?: string): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();

    try {
      const workDir = mainAgent.jian.getcwd();
      const strictCurrentDir = targetDir !== undefined && resolve(targetDir) === resolve(workDir);
      const scopeHint = strictCurrentDir
        ? 'Strictly analyze only <TARGET_DIR>. Do NOT explore any parent directories or sibling directories outside <TARGET_DIR>.'
        : 'You may explore from the current working directory upward to <TARGET_DIR> as needed to understand the whole project.';
      const prompt = DEFAULT_INIT_PROMPT
        .replaceAll('<TARGET_DIR>', targetDir ?? 'the project root')
        .replaceAll('<SCOPE_HINT>', scopeHint);
      const handle = await mainAgent.subagentHost!.spawn('coder', {
        parentToolCallId: 'generate-agents-md',
        prompt,
        description: 'Initialize AGENTS.md',
        runInBackground: false,
        origin: { kind: 'system_trigger', name: 'init' },
        signal: new AbortController().signal,
      });
      await handle.completion;

      const agentsMd = await loadAgentsMd(mainAgent.jian);
      mainAgent.context.appendSystemReminder(initCompletionReminder(agentsMd), {
        kind: 'injection',
        variant: 'init',
      });
      await mainAgent.records.flush();
    } catch (error) {
      throw new ScreamError(
        ErrorCodes.SESSION_INIT_FAILED,
        error instanceof Error ? error.message : 'Init failed',
        { cause: error },
      );
    }
  }

  setRuntimeSystemPrompt(prompt: RuntimeSystemPrompt): void {
    this.runtimeSystemPrompt = {
      replace: normalizeRuntimePromptPart(prompt.replace),
      append: normalizeRuntimePromptPart(prompt.append),
    };
  }

  private effectiveSystemPrompt(basePrompt: string): string {
    const base = this.runtimeSystemPrompt.replace ?? basePrompt;
    const append = this.runtimeSystemPrompt.append;
    return append === undefined ? base : `${base}\n\n${append}`;
  }

  get hasActiveTurn(): boolean {
    for (const agent of this.agents.values()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  protected get metadataPath() {
    return join(this.options.homedir, 'state.json');
  }

  writeMetadata() {
    const text = JSON.stringify(this.metadata, null, 2);
    const write = async () => {
      await this.options.jian.mkdir(this.options.homedir, { parents: true, existOk: true });
      await this.options.jian.writeText(this.metadataPath, text);
    };
    // Recover from a rejected link: without the rejection arm, one failed
    // write would latch the chain and silently stop all future metadata
    // persistence for the session's lifetime.
    this.writeMetadataPromise = this.writeMetadataPromise.then(
      () => write(),
      () => write(),
    );
    return this.writeMetadataPromise;
  }

  async readMetadata() {
    const text = await this.options.jian.readText(this.metadataPath);
    this.metadata = JSON.parse(text);
    return this.metadata;
  }

  async flushMetadata() {
    await this.skillsReady;
    await this.writeMetadataPromise;
    await Promise.all(Array.from(this.agents.values()).map((agent) => agent.records.flush()));
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    await this.skillsReady;
    return this.skills.listSkills().map(summarizeSkill);
  }

  /**
   * Dynamically load additional skill roots into the running session.
   * Used after a plugin is installed so its skills become available
   * without requiring the user to create a new session.
   */
  async injectSkillRoots(roots: readonly SkillRoot[]): Promise<void> {
    await this.skillsReady;
    await this.skills.loadRoots(roots);
    this.refreshAgentBuiltinTools();
  }
  /**
   * Remove skills contributed by a plugin from the running session.
   * Called automatically when a plugin is uninstalled while the session is active.
   */
  ejectPlugin(pluginId: string): void {
    this.skills.ejectPlugin(pluginId);
    this.refreshAgentBuiltinTools();
  }
  /**
   * Delete a manually installed skill from disk and remove it (and any bundled
   * sub-skills) from the running session. Plugin-provided skills must be
   * uninstalled via removePlugin instead.
   */
  async removeSkill(skillName: string): Promise<void> {
    await this.skillsReady;
    const skill = this.skills.getSkill(skillName);
    if (skill === undefined) {
      throw new ScreamError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${skillName}" was not found`);
    }
    if (skill.source === 'builtin' || skill.plugin !== undefined) {
      throw new ScreamError(
        ErrorCodes.REQUEST_INVALID,
        `Skill "${skillName}" cannot be removed this way; use removePlugin for plugin skills`,
      );
    }
    const installUnit = resolveSkillInstallUnit(skill.path);
    await rm(installUnit, { recursive: true, force: true });
    this.skills.removeSkillPath(installUnit);
    this.refreshAgentBuiltinTools();
  }


  private async loadSkills(): Promise<void> {
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: this.options.skills?.userHomeDir ?? homedir(),
        workDir: this.options.jian.getcwd(),
      },
      explicitDirs: this.options.skills?.explicitDirs,
      extraDirs: this.options.skills?.extraDirs,
      pluginSkillRoots: this.options.skills?.pluginSkillRoots,
      mergeAllAvailableSkills: this.options.skills?.mergeAllAvailableSkills,
      builtinDir: this.options.skills?.builtinDir,
    });
    await this.skills.loadRoots(roots);
    registerBuiltinSkills(this.skills);
  }

  private async loadMcpServers(): Promise<void> {
    const servers = this.options.mcpConfig?.servers;
    if (servers === undefined || Object.keys(servers).length === 0) return;
    await this.mcp.connectAll(servers);
    const entries = this.mcp.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.log.info('mcp servers connected', { connectedCount, totalCount });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.log.warn('mcp servers failed', { failedCount, totalCount });
    }
  }

  private emitInitialMcpLoadError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('mcp initial load failed', error);
    void this.rpc.emitEvent({
      type: 'error',
      agentId: 'main',
      ...makeErrorPayload(ErrorCodes.MCP_STARTUP_FAILED, message),
    });
  }

  private onMcpServerStatusChange(entry: McpServerEntry): void {
    // Always surface server-level status changes to clients so the TUI/SDK
    // can keep its dashboard in sync, even before the main agent exists.
    void this.rpc.emitEvent({
      type: 'mcp.server.status',
      agentId: 'main',
      server: {
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        error: entry.error,
      },
    });
  }

  private backgroundTaskTimeoutMs(): number | undefined {
    const timeoutS = this.options.background?.agentTaskTimeoutS;
    return timeoutS === undefined ? undefined : timeoutS * 1000;
  }

  private refreshAgentBuiltinTools(): void {
    for (const agent of this.agents.values()) {
      if (!agent.config.hasProvider) continue;
      agent.tools.initializeBuiltinTools();
    }
  }

  private instantiateAgent(
    id: string,
    homedir: string,
    type: AgentType,
    config: Partial<AgentOptions> = {},
    parentAgentId: string | null = null,
  ): Agent {
    const parentAgent = parentAgentId !== null ? this.agents.get(parentAgentId) : undefined;
    const cwd = parentAgent?.config.cwd ?? this.options.jian.getcwd();
    return new Agent({
      ...config,
      type,
      jian: this.options.jian.withCwd(cwd),
      toolServices: this.options.toolServices,
      config: this.options.config,
      homedir,
      screamHomeDir: this.options.screamHomeDir,
      skills: this.skills,
      rpc: proxyWithExtraPayload(this.rpc, { agentId: id }),
      modelProvider: this.options.providerManager,
      hookEngine: config.hookEngine ?? this.hookEngine,
      subagentHost:
        config.subagentHost ?? new SessionSubagentHost(this, id, this.backgroundTaskTimeoutMs(), this.options.subagentModelBindings),
      mcp: this.mcp,
      permission: this.permissionOptions(parentAgentId, config.permission),
      log: this.log.createChild({ agentId: id }),
      pluginSessionStarts: type === 'main' ? this.options.pluginSessionStarts : undefined,
      resolveRuntimeSystemPrompt: (basePrompt) => this.effectiveSystemPrompt(basePrompt),
    });
  }

  private permissionOptions(
    parentAgentId: string | null,
    input?: PermissionManagerOptions | undefined,
  ): PermissionManagerOptions {
    if (parentAgentId === null) {
      return {
        ...input,
        initialRules: input?.initialRules ?? this.options.permissionRules,
      };
    }
    return {
      ...input,
      parent: input?.parent ?? this.agents.get(parentAgentId)?.permission,
    };
  }

  private ensureResumeAgentInstantiated(
    id: string,
    agents: Record<string, AgentMeta>,
    stack: readonly string[] = [],
  ): Agent {
    const existing = this.agents.get(id);
    if (existing !== undefined) return existing;
    if (stack.includes(id)) {
      throw new ScreamError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session agent parent chain contains a cycle: ${[...stack, id].join(' -> ')}`,
      );
    }

    const meta = agents[id];
    if (meta === undefined) {
      throw new ScreamError(ErrorCodes.SESSION_STATE_INVALID, `Session agent "${id}" is missing`);
    }

    const parentAgentId = meta.parentAgentId ?? null;
    if (parentAgentId !== null) {
      this.ensureResumeAgentInstantiated(parentAgentId, agents, [...stack, id]);
    }

    const agent = this.instantiateAgent(id, meta.homedir, meta.type, {}, parentAgentId);
    this.agents.set(id, agent);
    return agent;
  }

  private nextGeneratedAgentId(): string {
    while (true) {
      const id = `agent-${this.agentIdCounter++}`;
      if (this.agents.has(id)) continue;
      if (this.metadata.agents[id] !== undefined) continue;
      return id;
    }
  }

  private requireMainAgent(): Agent {
    const agent = this.agents.get('main');
    if (agent === undefined) {
      throw new ScreamError(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return agent;
  }

  private async triggerSessionStart(source: 'startup' | 'resume'): Promise<void> {
    await this.hookEngine.trigger('SessionStart', {
      matcherValue: source,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: 'exit'): Promise<void> {
    await this.hookEngine.trigger('SessionEnd', {
      matcherValue: reason,
      inputData: { reason },
    });
  }
}

export * from './subagent-host';

function normalizeRuntimePromptPart(value: string | undefined): string | undefined {
  if (value === undefined) return;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function initCompletionReminder(agentsMd: string): string {
  const latest =
    agentsMd.trim().length === 0
      ? 'No AGENTS.md content was found after `/init` completed.'
      : agentsMd;
  return [
    'The user just ran `/init` slash command.',
    'The system has analyzed the codebase and generated an `AGENTS.md` file.',
    '',
    'Latest AGENTS.md file content:',
    latest,
  ].join('\n');
}
