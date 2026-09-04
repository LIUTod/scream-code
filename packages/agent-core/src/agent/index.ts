import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'pathe';

import { ErrorCodes, ScreamError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { AgentAPI, AgentEvent, ScreamConfig, SDKAgentRPC, UsageStatus } from '#/rpc';
import {
  generate,
  isRetryableGenerateError,
  type ChatProvider,
  type Message,
  type Tool,
} from '@scream-code/ltod';

import type { EnabledPluginSessionStart } from '#/plugin';

import { computeDelayMs, retryBackoffDelays } from '../loop/retry';

import type { McpConnectionManager } from '../mcp';
import type { PreparedSystemPromptContext, ResolvedAgentProfile } from '../profile';
import type { LspProcessSupervisor } from '../lsp/process-supervisor';
import type { ModelProvider } from '../session/provider-manager';
import type { SessionSubagentHost } from '../session/subagent-host';
import type { SkillRegistry } from '../skill';
import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../utils/tokens';
import type { PromisableMethods } from '../utils/types';
import { BackgroundManager } from './background';
import { EventSubscriptionBus } from './events';
import { FullCompaction, MicroCompaction, type CompactionStrategy } from './compaction';
import { CronManager } from './cron';
import { ConfigState } from './config';
import { ContextMemory } from './context';
import { USER_PROMPT_ORIGIN } from './context/types';
import { GoalMode } from './goal';
import { HookEngine } from '../session/hooks';
import { InjectionManager } from './injection/manager';
import { DreamTracker, EXIT_EXTRACTION_SYSTEM_PROMPT, MemoryMemoStore, buildExitExtractionPrompt, createFastEmbedEngine, parseMemoryMemos, type EmbeddingEngine } from '@scream-code/memory';
import { KnowledgeStore } from '@scream-code/knowledge';
import { PermissionManager, type PermissionManagerOptions } from './permission';
import { PlanMode } from './plan';
import { DEFAULT_SECRET_PATTERNS, SecretObfuscator } from './secrets';
import { WolfPackMode } from './wolfpack';
import { SessionMemory } from './session-memory';
import { WorkingSet } from './working-set';
import {
  AgentRecords,
  BlobStore,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
} from './records';
import { ReplayBuilder } from './replay';
import { SkillManager } from './skill';
import { ToolManager } from './tool/index';
import { TurnFlow } from './turn';
import {
  GENERATE_REQUEST_LOG_CONTEXT,
  LtodLLM,
  type GenerateOptionsWithRequestLog,
} from './turn/ltod-llm';
import { UsageRecorder } from './usage';
import { resolveCompletionBudget } from '../utils/completion-budget';
import type { Jian } from '@scream-code/jian';
import type { ToolServices } from '../tools/support/services';

export type { AgentRecord, AgentRecordPersistence } from './records';
export { REPLAY_TURN_LIMIT } from './replay';
export type { BuiltinTool, ToolInfo, ToolSource, UserToolRegistration } from './tool';

export type AgentType = 'main' | 'sub' | 'independent';

const SIDE_QUESTION_SYSTEM =
  'You are a helpful coding assistant answering a quick side question. The user is in the middle of a coding session and needs a fast, concise answer. Keep your response short and focused — this is a side question, not the main task.';

export interface AgentOptions {
  readonly jian: Jian;
  readonly config?: ScreamConfig;
  readonly homedir?: string;
  readonly screamHomeDir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly persistence?: AgentRecordPersistence;
  readonly type?: AgentType;
  readonly generate?: typeof generate;
  readonly toolServices?: ToolServices;
  readonly compactionStrategy?: CompactionStrategy;
  readonly modelProvider?: ModelProvider | undefined;
  readonly subagentHost?: SessionSubagentHost | undefined;
  readonly skills?: SkillRegistry;
  readonly mcp?: McpConnectionManager;
  readonly hookEngine?: HookEngine;
  readonly permission?: PermissionManagerOptions | undefined;
  readonly log?: Logger;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly resolveRuntimeSystemPrompt?: ((basePrompt: string) => string) | undefined;
  /** Process supervisor tracking this agent's LSP children (session-scoped). */
  readonly lspSupervisor?: LspProcessSupervisor | undefined;
}

/**
 * Stable service manifest for the agent runtime. Lists the core engine
 * subsystems that extensions may need to reach (future plugin adapters, SDK
 * consumers, subagent hosts). Modeled after the `inject` contract used by
 * plugin-based harnesses: a consumer declares what it needs and gets a stable,
 * documented handle instead of reaching into Agent internals. The Agent still
 * owns the subsystems; `services` is the read-only manifest view.
 */
export interface AgentServices {
  readonly records: AgentRecords;
  readonly context: ContextMemory;
  readonly config: ConfigState;
  readonly turn: TurnFlow;
  readonly injection: InjectionManager;
  readonly permission: PermissionManager;
  readonly planMode: PlanMode;
  readonly usage: UsageRecorder;
  readonly tools: ToolManager;
  readonly skills: SkillManager | null;
  readonly background: BackgroundManager;
  readonly goal: GoalMode;
  readonly sessionMemory: SessionMemory;
  readonly workingSet: WorkingSet;
  readonly fullCompaction: FullCompaction;
  readonly microCompaction: MicroCompaction;
  /** Resolve the runtime system prompt (base profile prompt + configured hook). */
  systemPrompt(): string;
}

export class Agent {
  readonly type: AgentType;
  readonly jian: Jian;
  readonly screamConfig?: ScreamConfig;
  readonly homedir?: string;
  readonly screamHomeDir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly toolServices?: ToolServices;
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  readonly rawGenerate: typeof generate;
  readonly modelProvider?: ModelProvider;
  readonly subagentHost?: SessionSubagentHost;
  readonly mcp?: McpConnectionManager;
  readonly hooks?: HookEngine;
  /** Process supervisor tracking this agent's LSP children (session-scoped). */
  readonly lspSupervisor: LspProcessSupervisor | undefined;
  readonly log: Logger;
  /** In-process event bus for extensions running inside the agent process. */
  readonly eventBus: EventSubscriptionBus;

  readonly blobStore: BlobStore | undefined;
  readonly records: AgentRecords;
  readonly fullCompaction: FullCompaction;
  readonly microCompaction: MicroCompaction;
  readonly context: ContextMemory;
  readonly config: ConfigState;
  readonly turn: TurnFlow;
  readonly injection: InjectionManager;
  readonly permission: PermissionManager;
  readonly planMode: PlanMode;
  readonly wolfpackMode: WolfPackMode;
  readonly usage: UsageRecorder;
  readonly skills: SkillManager | null;
  readonly tools: ToolManager;
  readonly background: BackgroundManager;
  readonly cron: CronManager | null;
  readonly goal: GoalMode;
  readonly memoStore: MemoryMemoStore | undefined;
  readonly knowledgeStore: KnowledgeStore | undefined;
  readonly sessionMemory: SessionMemory;
  readonly workingSet: WorkingSet;
  readonly dreamTracker: DreamTracker;
  readonly replayBuilder: ReplayBuilder;

  /** Read-only manifest of the core engine subsystems (see {@link AgentServices}). */
  readonly services: AgentServices;

  private lastLlmConfigLogSignature?: string;
  private readonly sharedEmbeddingEngine: EmbeddingEngine;
  private readonly resolveRuntimeSystemPrompt: (basePrompt: string) => string;

  constructor(options: AgentOptions) {
    // ── Group 1: external dependencies (injected via AgentOptions) ────────────
    this.type = options.type ?? 'main';
    this.jian = options.jian;
    this.screamConfig = options.config;
    this.homedir = options.homedir;
    this.screamHomeDir = options.screamHomeDir;
    this.rpc = options.rpc;
    this.toolServices = options.toolServices;
    this.pluginSessionStarts = options.pluginSessionStarts ?? [];
    this.resolveRuntimeSystemPrompt = options.resolveRuntimeSystemPrompt ?? ((basePrompt) => basePrompt);
    this.rawGenerate = options.generate ?? generate;
    this.modelProvider = options.modelProvider;
    this.subagentHost = options.subagentHost;
    this.mcp = options.mcp;
    this.hooks = options.hookEngine;
    this.lspSupervisor = options.lspSupervisor;
    this.eventBus = new EventSubscriptionBus();
    const embedCacheDir = options.screamHomeDir !== undefined
      ? join(options.screamHomeDir, 'cache', 'fastembed')
      : undefined;
    this.sharedEmbeddingEngine = createFastEmbedEngine(embedCacheDir);
    this.log = options.log ?? log;

    // ── Group 2: infrastructure (blob store → wire persistence → compaction) ──
    // Order matters: records is created first because every later subsystem
    // logs state changes through it; full/micro compaction depend on context,
    // which is created in Group 3 — they only hold a hub reference and are
    // driven on demand, so their position here is safe.
    this.blobStore = options.homedir
      ? new BlobStore({ blobsDir: join(options.homedir, 'blobs') })
      : undefined;
    this.records = new AgentRecords(
      this,
      options.persistence ??
        (options.homedir
          ? new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), {
              onError: (error) => {
                this.emitRecordsWriteError(error);
              },
              blobStore: this.blobStore,
            })
          : undefined),
    );
    this.fullCompaction = new FullCompaction(this, options.compactionStrategy);
    this.microCompaction = new MicroCompaction(this);

    // ── Group 3: core session services (context/config/turn/injection/…) ─────
    // context is the heart: it owns history/token gauge and is consumed by
    // turn, injection and planMode. skills feeds tools; permission guards runs.
    this.context = new ContextMemory(this);
    this.config = new ConfigState(this);
    this.turn = new TurnFlow(this);
    this.injection = new InjectionManager(this);
    this.planMode = new PlanMode(this);
    this.wolfpackMode = new WolfPackMode(this);
    this.permission = new PermissionManager(this, options.permission);
    this.usage = new UsageRecorder(this);
    this.skills = options.skills ? new SkillManager(this, options.skills) : null;
    this.tools = new ToolManager(this);

    // ── Group 4: derived services (background/goal/stores/dream/replay) ───────
    // Dependent on Groups 1-3; memoStore/knowledgeStore are async-initialized
    // (memoStoreReady/knowledgeStoreReady) and shared across sessions.
    this.background = new BackgroundManager(this);
    this.cron = this.type === 'sub' ? null : new CronManager(this);
    this.goal = new GoalMode(this);
    // Use a global memory store shared across all sessions/workDirs.
    const screamHomeDir = options.screamHomeDir;
    this.memoStore = screamHomeDir
      ? new MemoryMemoStore(screamHomeDir, this.log)
      : undefined;
    this.memoStoreReady = this.initMemoStore(screamHomeDir);
    // Knowledge store is main-agent-only — subagents don't need retrieval access.
    this.knowledgeStore =
      screamHomeDir !== undefined && this.type === 'main'
        ? new KnowledgeStore(screamHomeDir)
        : undefined;
    this.knowledgeStoreReady = this.initKnowledgeStore(this.knowledgeStore);
    this.sessionMemory = new SessionMemory(this);
    this.workingSet = new WorkingSet();
    this.dreamTracker = new DreamTracker(screamHomeDir ?? '');
    this.replayBuilder = new ReplayBuilder(this);
    this.services = {
      records: this.records,
      context: this.context,
      config: this.config,
      turn: this.turn,
      injection: this.injection,
      permission: this.permission,
      planMode: this.planMode,
      usage: this.usage,
      tools: this.tools,
      skills: this.skills,
      background: this.background,
      goal: this.goal,
      sessionMemory: this.sessionMemory,
      workingSet: this.workingSet,
      fullCompaction: this.fullCompaction,
      microCompaction: this.microCompaction,
      systemPrompt: () => this.getRuntimeSystemPrompt(),
    };
  }

  /**
   * Promise that resolves once the shared memory store (and any legacy migration)
   * has been initialized. Session startup awaits this so memory tools are ready
   * before the first turn runs.
   */
  readonly memoStoreReady: Promise<void>;

  /**
   * Promise that resolves once the knowledge store (and its embedding engine)
   * has been initialized. Main-agent-only.
   */
  readonly knowledgeStoreReady: Promise<void>;

  private initMemoStore(screamHomeDir: string | undefined): Promise<void> {
    if (screamHomeDir === undefined || this.memoStore === undefined) {
      return Promise.resolve();
    }
    return (async () => {
      try {
        await this.memoStore!.init();
      } catch (error: unknown) {
        this.log.error('memory store init failed', error);
      }
      try {
        await MemoryMemoStore.migrateLegacyStores(screamHomeDir);
      } catch (error: unknown) {
        this.log.error('memory legacy migration failed', error);
      }
      try {
        this.memoStore!.setEmbeddingEngine(this.sharedEmbeddingEngine);
      } catch (error: unknown) {
        this.log.warn('embedding engine init failed; falling back to keyword search', error);
      }
    })();
  }

  private rlmEnabled = false;
  /** RLM recursion depth: 0 for the root agent, +1 per spawned subagent. */
  private rlmDepth = 0;
  /** Maximum allowed RLM recursion depth. `Infinity` (the default) means
   * unlimited recursion. Set to a positive integer via /rlm-max-depth to
   * cap the chain (e.g. 1 = root may spawn children, children may not spawn
   * grandchildren); 0 is treated as unlimited as well. */
  private rlmMaxDepth = Infinity;

  getRlmDepth(): number {
    return this.rlmDepth;
  }

  /** The system prompt the agent actually sends after runtime resolution
   *  (a custom `resolveRuntimeSystemPrompt` hook may replace/append to the
   *  base profile prompt — compaction must reuse this exact string so its
   *  request shares the routed prefix and hits the KV cache). */
  getRuntimeSystemPrompt(): string {
    return this.resolveRuntimeSystemPrompt(this.config.systemPrompt);
  }

  setRlmDepth(depth: number): void {
    this.rlmDepth = Math.max(0, depth);
  }

  getRlmMaxDepth(): number {
    return this.rlmMaxDepth;
  }

  setRlmMaxDepth(maxDepth: number): void {
    if (!Number.isFinite(maxDepth) || maxDepth <= 0) {
      this.rlmMaxDepth = Infinity;
      return;
    }
    this.rlmMaxDepth = Math.trunc(maxDepth);
  }

  /** Disposes the persistent python kernel (if any) and resets RLM mode.
   * Called on session close so no orphaned kernel process is left behind.
   * Only touches state when RLM was actually enabled — a session that never
   * used /rlm must not emit a spurious setActiveTools record (which would
   * pollute the wire log and, on a subagent that does not re-apply a profile
   * on resume, could strip MCP access patterns). */
  disposeRlm(): void {
    if (!this.rlmEnabled) return;
    this.rlmEnabled = false;
    const withoutPython = this.tools.getActiveTools().filter((name) => name !== 'python');
    this.tools.setActiveTools(withoutPython);
    (this.tools.getBuiltinTool('python') as { dispose?: () => void } | undefined)?.dispose?.();
    // Symmetric with setRlmEnabled(false): persist rlm.exit so a close →
    // resume replay restores rlmEnabled=false (and the python tool removal
    // above stays consistent). Without this, replay would see only rlm.enter
    // → badge lit, python tool removed by the close record → broken state.
    this.records.logRecord({ type: 'rlm.exit' });
  }

  /**
   * Enables or disables the /rlm persistent-python mode. On enable, the
   * `python` tool is added to the active tools; on disable it is removed and
   * its kernel is disposed. Default state (disabled) leaves the tool list and
   * default behaviour untouched.
   */
  private setRlmEnabled(enabled: boolean): void {
    this.rlmEnabled = enabled;
    const current = this.tools.getActiveTools();
    if (enabled) {
      if (!current.includes('python')) {
        this.tools.setActiveTools([...current, 'python']);
      }
    } else {
      const withoutPython = current.filter((name) => name !== 'python');
      if (withoutPython.length !== current.length) {
        this.tools.setActiveTools(withoutPython);
      }
      (this.tools.getBuiltinTool('python') as { dispose?: () => void } | undefined)?.dispose?.();
    }
    this.records.logRecord({ type: enabled ? 'rlm.enter' : 'rlm.exit' });
    this.emitStatusUpdated();
  }

  /** Returns whether RLM (persistent python mode) is currently enabled. */
  getRlmEnabled(): boolean {
    return this.rlmEnabled;
  }

  /**
   * Lets a subagent inherit RLM mode from its parent at spawn time: mounts
   * the python tool (so the child can keep recursing) and records rlm.enter,
   * mirroring setRlmEnabled(true). The rlm.enter record keeps enter/exit
   * symmetric: the child's disposeRlm (triggered by session close) emits
   * rlm.exit, so a subagent's records must contain the matching enter or the
   * pair is unbalanced. A status event is NOT emitted here — the child's own
   * turn is about to start and the parent's record already represents this
   * recursion chain. Non-RLM parents never call this.
   */
  inheritRlm(): void {
    this.rlmEnabled = true;
    const current = this.tools.getActiveTools();
    if (!current.includes('python')) {
      this.tools.setActiveTools([...current, 'python']);
    }
    this.records.logRecord({ type: 'rlm.enter' });
  }

  /** Restores RLM mode from a persisted record during replay. Does not log
   * a new record and does not emit a status update (both are suppressed while
   * records are restoring). */
  restoreRlm(enabled: boolean): void {
    this.rlmEnabled = enabled;
    const current = this.tools.getActiveTools();
    if (enabled) {
      if (!current.includes('python')) {
        this.tools.setActiveTools([...current, 'python']);
      }
    } else {
      const withoutPython = current.filter((name) => name !== 'python');
      if (withoutPython.length !== current.length) {
        this.tools.setActiveTools(withoutPython);
      }
    }
  }

  private initKnowledgeStore(store: KnowledgeStore | undefined): Promise<void> {
    if (store === undefined) return Promise.resolve();
    return (async () => {
      try {
        await store.init();
      } catch (error: unknown) {
        this.log.error('knowledge store init failed', error);
      }
      try {
        store.setEmbeddingEngine(this.sharedEmbeddingEngine);
      } catch (error: unknown) {
        this.log.warn('knowledge embedding engine init failed', error);
      }
    })();
  }
  get generate(): typeof generate {
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      if (options?.auth !== undefined) {
        this.logLlmRequest(provider, systemPrompt, tools, history, options);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, options);
      }
      const modelAlias = this.config.modelAlias;
      const withAuth =
        modelAlias === undefined
          ? undefined
          : this.modelProvider?.resolveAuth?.(modelAlias, { log: this.log });
      if (withAuth === undefined) {
        this.logLlmRequest(provider, systemPrompt, tools, history, options);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, options);
      }
      return withAuth((auth) => {
        const requestOptions = { ...options, auth };
        this.logLlmRequest(provider, systemPrompt, tools, history, requestOptions);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, requestOptions);
      });
    };
  }

  /**
   * Bounded-retry wrapper around `generate` for auxiliary LLM calls (exit
   * memory extraction, side questions, knowledge-base text generation, skill
   * plan generation). These call the model directly, outside the loop's
   * step-retry layer, and SDK-level retries are disabled — without this they
   * would hard-fail on any transient 429/5xx. Mirrors the main loop's policy:
   * only retryable errors, exponential backoff, bounded attempts.
   */
  async generateWithRetry(
    provider: ChatProvider,
    systemPrompt: string,
    tools: readonly Tool[],
    messages: readonly Message[],
    maxAttempts = 3,
  ): Promise<Awaited<ReturnType<typeof generate>>> {
    const delays = retryBackoffDelays(maxAttempts);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.generate(provider, systemPrompt, [...tools], [...messages]);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableGenerateError(error)) throw error;
        const delayMs = computeDelayMs(error, delays, attempt);
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
  }

  get llm(): LtodLLM {
    const model = this.config.model;
    const provider = this.config.provider.withThinking(this.config.thinkingLevel);
    const loopControl = this.screamConfig?.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      reservedContextSize: loopControl?.reservedContextSize,
    });
    return new LtodLLM({
      provider,
      modelName: model,
      systemPrompt: this.resolveRuntimeSystemPrompt(this.config.systemPrompt),
      capability: this.config.modelCapabilities,
      generate: this.generate,
      completionBudgetConfig,
      obfuscator: this.obfuscator,
    });
  }

  private _obfuscator: SecretObfuscator | undefined;
  private _obfuscatorConfigRef: ScreamConfig | undefined;

  private get obfuscator(): SecretObfuscator | undefined {
    if (this._obfuscatorConfigRef === this.screamConfig && this._obfuscator !== undefined) {
      return this._obfuscator;
    }
    this._obfuscatorConfigRef = this.screamConfig;
    const userEntries = this.screamConfig?.secrets ?? [];
    this._obfuscator = new SecretObfuscator([...DEFAULT_SECRET_PATTERNS, ...userEntries]);
    return this._obfuscator;
  }

  private logLlmRequest(
    provider: ChatProvider,
    systemPrompt: string,
    tools: readonly Tool[],
    history: readonly Message[],
    options: Parameters<typeof generate>[5],
  ): void {
    const context = buildLlmRequestContext(options);
    const configMetadata = buildLlmConfigMetadata(
      provider,
      this.config.modelAlias,
      systemPrompt,
      tools,
    );
    this.logLlmConfigIfChanged(
      context,
      configMetadata,
      buildLlmConfigSignature(configMetadata, systemPrompt, tools),
    );

    let partialMessageCount = 0;
    for (const message of history) {
      if (message.partial === true) partialMessageCount += 1;
    }
    const requestMetadata: LlmRequestMetadata = {
      estimatedInputTokens:
        estimateTokens(systemPrompt) +
        estimateTokensForMessages(history) +
        estimateTokensForTools(tools),
    };
    if (partialMessageCount > 0) {
      requestMetadata.partialMessageCount = partialMessageCount;
    }
    // Per-request snapshot in the wire log so the request can be rebuilt
    // later (provider identity, model, rendered system prompt, active tools,
    // message count).
    this.records.logRecord({
      type: 'request.header',
      provider: provider.name,
      model: provider.modelName,
      modelAlias: this.config.modelAlias ?? '',
      systemPrompt,
      activeTools: tools.map((t) => t.name),
      messagesCount: history.length,
      estimatedInputTokens: requestMetadata.estimatedInputTokens ?? 0,
    });
    this.log.info('llm request', {
      ...context,
      ...requestMetadata,
    });
  }

  private logLlmConfigIfChanged(
    context: LlmRequestContextFields,
    metadata: LlmConfigMetadata,
    signature: string,
  ): void {
    if (signature === this.lastLlmConfigLogSignature) return;
    this.lastLlmConfigLogSignature = signature;
    this.log.info('llm config', {
      ...context,
      ...metadata,
    });
  }

  useProfile(profile: ResolvedAgentProfile, context?: PreparedSystemPromptContext): void {
    const systemPrompt = profile.systemPrompt({
      osEnv: this.jian.osEnv,
      cwd: this.config.cwd,
      skills: this.skills?.registry,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
    });
    this.config.update({ profileName: profile.name, systemPrompt, activeTools: profile.tools });
    this.tools.setActiveTools(profile.tools);
  }

  async resume(): Promise<{ warning?: string }> {
    const result = await this.records.replay();
    this.goal.normalizeAfterReplay();
    await this.background.loadFromDisk();
    await this.background.reconcile();
    await this.cron?.loadFromDisk();
    this.turn.finishResume();
    return result;
  }

  get rpcMethods(): PromisableMethods<AgentAPI> {
    return {
      prompt: (payload) => {
        this.turn.prompt(payload.input);
      },
      steer: (payload) => {
        this.turn.steer(payload.input, USER_PROMPT_ORIGIN, { interrupt: payload.interrupt });
      },
      cancel: (payload) => {
        this.turn.cancel(payload.turnId);
      },
      setThinking: (payload) => {
        this.config.update({ thinkingLevel: payload.level });
      },
      setPermission: (payload) => {
        this.permission.setMode(payload.mode);
      },
      setModel: (payload) => {
        // Validate the alias resolves before recording it so resume / runtime
        // callers fail fast on missing aliases instead of deferring to the
        // next prompt.
        const resolved = this.modelProvider?.resolveProviderConfig(payload.model);
        if (this.config.modelAlias !== payload.model) {
          this.config.update({ modelAlias: payload.model });
        }
        return {
          model: payload.model,
          providerName: resolved?.providerName,
        };
      },
      getModel: () => {
        return this.config.modelAlias ?? '';
      },
      enterPlan: async (payload) => {
        await this.planMode.enter(undefined, false, true, payload.strategy ?? 'normal');
      },
      setPlanStrategy: (payload) => {
        this.planMode.setStrategy(payload.strategy);
      },
      enterWolfpack: () => {
        this.wolfpackMode.enter();
      },
      exitWolfpack: () => {
        this.wolfpackMode.exit();
      },
      cancelPlan: (payload) => {
        this.planMode.cancel(payload.id);
      },
      clearPlan: () => this.planMode.clear(),
      beginCompaction: (payload) => {
        this.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
      },
      cancelCompaction: () => {
        this.fullCompaction.cancel();
      },
      registerTool: (payload) => {
        this.tools.registerUserTool(payload);
      },
      unregisterTool: (payload) => {
        this.tools.unregisterUserTool(payload.name);
      },
      setActiveTools: (payload) => {
        this.tools.setActiveTools(payload.names);
      },
      setRlmEnabled: (payload) => {
        this.setRlmEnabled(payload.enabled);
      },
      setRlmMaxDepth: (payload) => {
        this.setRlmMaxDepth(payload.maxDepth);
      },
      stopBackground: (payload) => {
        void this.background.stop(payload.taskId, payload.reason);
      },
      clearContext: () => {
        this.context.clear();
      },
      undoHistory: (payload) => {
        this.context.undo(payload.count);
      },
      activateSkill: (payload) => {
        if (this.skills === null) {
          throw new ScreamError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
        }
        this.skills.activate(payload);
      },
      getBackgroundOutput: (payload) => this.background.readOutput(payload.taskId, payload.tail),
      getBackgroundOutputPath: (payload) => this.background.getOutputPath(payload.taskId),
      getContext: () => this.context.data(),
      getConfig: () => this.config.data(),
      getPermission: () => this.permission.data(),
      getPlan: () => this.planMode.data(),
      getUsage: () => this.usage.data(),
      getTools: () => this.tools.data(),
      getBackground: (payload) => this.background.list(payload.activeOnly ?? false, payload.limit),
      extractMemoriesOnExit: async () => {
        return this.extractMemoriesOnExit();
      },
      sideQuestion: async (payload) => {
        const answer = await this.sideQuestion(payload.question);
        return { answer };
      },
      generateText: async (payload) => {
        const text = await this.generateText(payload.systemPrompt, payload.userPrompt);
        return { text };
      },
      createGoal: async (payload) => {
        const snapshot = await this.goal.createGoal(
          {
            objective: payload.objective,
            completionCriterion: payload.completionCriterion,
            replace: payload.replace,
          },
          'user',
        );
        return snapshot;
      },
      updateGoalStatus: async (payload) => {
        const { status } = payload;
        if (status === 'complete') {
          return this.goal.markComplete({}, 'user');
        }
        if (status === 'blocked') {
          return this.goal.markBlocked({}, 'user');
        }
        if (status === 'paused') {
          return this.goal.pauseGoal({}, 'user');
        }
        // status === 'active'
        return this.goal.resumeGoal({}, 'user');
      },
      updateGoalObjective: async (payload) => {
        return this.goal.updateObjective({ objective: payload.objective }, 'user');
      },
      cancelGoal: async () => {
        return this.goal.cancelGoal('user');
      },
      getGoal: () => {
        return this.goal.getGoal();
      },
      getTodos: () => {
        return this.tools.getTodos();
      },
      setGoalBudget: async (payload) => {
        const { value, unit } = payload;
        let budgetLimits: import('./goal').GoalBudgetLimits;
        if (unit === 'turns') {
          budgetLimits = { turnBudget: value };
        } else if (unit === 'tokens') {
          budgetLimits = { tokenBudget: value };
        } else {
          let ms = value;
          if (unit === 'seconds') ms *= 1000;
          else if (unit === 'minutes') ms *= 60_000;
          else if (unit === 'hours') ms *= 3_600_000;
          budgetLimits = { wallClockBudgetMs: ms };
        }
        return this.goal.setBudgetLimits({ budgetLimits }, 'user');
      },
      getWolfpackMode: () => {
        return this.wolfpackMode.isActive;
      },
      getRlmEnabled: () => {
        return this.rlmEnabled;
      },
    };
  }

  /** Read session title from state.json (if available). */
  async getSessionTitle(): Promise<string | undefined> {
    if (!this.homedir) return undefined;
    const sessionDir = dirname(dirname(this.homedir));
    try {
      const text = await readFile(join(sessionDir, 'state.json'), 'utf-8');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed['title'] === 'string' && parsed['title'].length > 0) return parsed['title'];
      if (typeof parsed['customTitle'] === 'string' && parsed['customTitle'].length > 0) return parsed['customTitle'];
    } catch {
      // ignore — state.json may not exist
    }
    return undefined;
  }

  /** Extract memory memos from the full conversation history on session exit. */
  async extractMemoriesOnExit(): Promise<number> {
    if (!this.memoStore) return 0;
    await this.memoStore.init();

    const history = this.context.history;
    if (history.length < 4) return 0; // Too short to contain meaningful task loops

    // homedir = <projectDir>/<sessionId>/agents/<agentId>
    const sessionId = this.homedir
      ? basename(dirname(dirname(this.homedir)))
      : 'unknown';

    const sessionTitle = await this.getSessionTitle();

    // Sample last 50 messages to stay within reasonable token budget
    const sampleText = history
      .slice(-50)
      .map((m) => {
        const text = m.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
        return `[${m.role}] ${text.slice(0, 300)}`;
      })
      .join('\n');

    const userPrompt = buildExitExtractionPrompt(sessionId, history.length, sampleText);

    try {
      const response = await this.generateWithRetry(
        this.config.provider,
        EXIT_EXTRACTION_SYSTEM_PROMPT,
        [], // no tools — extraction only
        [
          {
            role: 'user',
            content: [{ type: 'text', text: userPrompt }],
            toolCalls: [],
          },
        ],
      );

      const summary = typeof response.message.content === 'string'
        ? response.message.content
        : response.message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

      const memos = parseMemoryMemos(summary);
      if (memos.length === 0) return 0;

      const store = this.memoStore;
      const results = await Promise.allSettled(
        memos.map((memo) => {
          memo.sourceSessionId = sessionId;
          memo.sourceSessionTitle = sessionTitle ?? '';
          memo.extractionSource = 'exit';
          memo.projectDir = this.config.cwd;
          return store.append(memo);
        }),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        this.log.warn('Some memory memos failed to store from exit extraction', {
          failed,
          total: memos.length,
        });
      }

      const stored = memos.length - failed;
      this.log.info('Extracted memory memos on session exit', {
        count: stored,
        sessionId,
      });
      return stored;
    } catch (error) {
      this.log.warn('Exit memory extraction failed', { error: String(error) });
      throw error;
    }
  }

  async sideQuestion(question: string): Promise<string> {
    const contextParts: string[] = [];
    let charBudget = 2000;

    for (let i = this.context.history.length - 1; i >= 0 && charBudget > 0; i--) {
      const msg = this.context.history[i];
      if (msg === undefined) continue;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (!text) continue;
      const snippet = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      contextParts.unshift(`[${msg.role}]: ${snippet}`);
      charBudget -= snippet.length;
    }

    const conversationContext = contextParts.join('\n\n');

    const system = conversationContext
      ? `${SIDE_QUESTION_SYSTEM}\n\n<conversation_context>\n${conversationContext}\n</conversation_context>`
      : SIDE_QUESTION_SYSTEM;

    if (!this.config.hasModel) {
      return 'No model configured. Run `scream config` or use `/model` to set a default model.';
    }

    const response = await this.generateWithRetry(
      this.config.provider,
      system,
      [],
      [{ role: 'user', content: [{ type: 'text' as const, text: question }], toolCalls: [] }],
    );

    const text = response.message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

    return text || '(no response)';
  }

  /**
   * Call the configured LLM with a custom system prompt and single user message.
   * Returns the text response. No tools, no conversation history, no side effects.
   * Used by the knowledge base for extraction / rerank / entity-recall calls.
   */
  async generateText(systemPrompt: string, userPrompt: string): Promise<string> {
    if (!this.config.hasModel) {
      throw new Error('No model configured. Run `scream config` or use `/model` to set a default model.');
    }
    const response = await this.generateWithRetry(
      this.config.provider,
      systemPrompt,
      [],
      [{ role: 'user', content: [{ type: 'text', text: userPrompt }], toolCalls: [] }],
    );
    return response.message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }

  emitEvent(event: AgentEvent): void {
    if (this.records.restoring) return;
    // Deliver to in-process subscribers (extensions) first, then broadcast to
    // the host. Subscriber errors are swallowed by the bus itself.
    this.eventBus.dispatch(event);
    // Fire-and-forget: a non-serializable event must not surface as an
    // unhandledRejection (Node >=15 terminates on those).
    void this.rpc?.emitEvent?.(event)?.catch(() => {});
  }

  emitStatusUpdated(): void {
    if (this.records.restoring) return;
    if (!this.config.hasModel) return;

    const contextTokens = this.context.tokenCount;
    const maxContextTokens = this.config.modelCapabilities.max_context_tokens;
    const contextUsage =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    const usage: UsageStatus | undefined = this.usage.status();
    const model = this.config.model;

    this.emitEvent({
      type: 'agent.status.updated',
      model,
      thinkingLevel: this.config.thinkingLevel,
      contextTokens,
      maxContextTokens,
      contextUsage,
      planMode: this.planMode.isActive,
      planStrategy: this.planMode.isActive ? this.planMode.strategy : undefined,
      wolfpackMode: this.wolfpackMode.isActive,
      rlmEnabled: this.rlmEnabled,
      permission: this.permission.mode,
      usage,
    });
  }

  private emitRecordsWriteError(error: unknown, record?: AgentRecord | undefined): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('wire record persist failed', {
      agentHomedir: this.homedir,
      recordType: record?.type,
      error,
    });
    this.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.RECORDS_WRITE_FAILED,
        `Failed to write agent records: ${message}`,
        {
          details: { recordType: record?.type },
        },
      ),
    });
  }
}

interface LlmRequestContextFields {
  turnStep?: string;
  attempt?: string;
}

interface LlmRequestMetadata {
  estimatedInputTokens: number;
  partialMessageCount?: number;
}

/**
 * Fields that identify an LLM configuration for deduplication.
 * Keep this interface simple and avoid dynamic keys — the shape is
 * serialized with `JSON.stringify` to produce a stable signature in
 * `logLlmConfigIfChanged`.
 */
interface LlmConfigMetadata {
  provider: string;
  model: string;
  modelAlias?: string;
  thinkingEffort?: string;
  systemPromptChars: number;
  toolCount: number;
}

function buildLlmRequestContext(options: Parameters<typeof generate>[5]): LlmRequestContextFields {
  const context = requestLogContext(options);
  if (context === undefined) return {};

  const fields: LlmRequestContextFields = {
    turnStep:
      context.turnId === undefined || context.step === undefined
        ? undefined
        : `${context.turnId}.${String(context.step)}`,
  };
  if (
    context.attempt !== undefined &&
    context.maxAttempts !== undefined &&
    context.attempt > 1
  ) {
    fields.attempt = `${String(context.attempt)}/${String(context.maxAttempts)}`;
  }
  return fields;
}

function buildLlmConfigMetadata(
  provider: ChatProvider,
  modelAlias: string | undefined,
  systemPrompt: string,
  tools: readonly Tool[],
): LlmConfigMetadata {
  return {
    provider: provider.name,
    model: provider.modelName,
    modelAlias,
    thinkingEffort: provider.thinkingEffort ?? undefined,
    systemPromptChars: systemPrompt.length,
    toolCount: tools.length,
  };
}

function buildLlmConfigSignature(
  metadata: LlmConfigMetadata,
  systemPrompt: string,
  tools: readonly Tool[],
): string {
  const toolsForSignature = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return JSON.stringify({
    ...metadata,
    systemPromptHash: fingerprint(systemPrompt),
    toolsHash: fingerprint(JSON.stringify(toolsForSignature)),
  });
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function requestLogContext(options: Parameters<typeof generate>[5]) {
  return (options as GenerateOptionsWithRequestLog | undefined)?.[GENERATE_REQUEST_LOG_CONTEXT];
}
