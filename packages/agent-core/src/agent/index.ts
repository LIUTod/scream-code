import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'pathe';

import { ErrorCodes, ScreamError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { AgentAPI, AgentEvent, CronTaskInfo, ScreamConfig, SDKAgentRPC, UsageStatus } from '#/rpc';
import {
  generate,
  isRetryableGenerateError,
  type ChatProvider,
  type ProviderRequestAuth,
  type Message,
  type Tool,
  type TokenUsage,
} from '@scream-code/ltod';

import type { EnabledPluginSessionStart } from '#/plugin';

import { resolveScreamHome } from '../config/path';
import { computeDelayMs, retryBackoffDelays } from '../loop/retry';
import { RepetitionGuard } from '../tools/support/repetition-guard';
import { EditSnapshotStore } from '../tools/support/edit-snapshot-store';
import { EditRecoveryQueue } from '../tools/support/edit-recovery-queue';

import { CacheWarmer, createCatalogPricingLookup, DEFAULT_MIN_SAVINGS_USD, requestFingerprint, type AliasPricingLookup } from './cache-warmer';

import type { McpConnectionManager } from '../mcp';
import { systemPromptForRequest } from '../profile';
import type { PreparedSystemPromptContext, ResolvedAgentProfile } from '../profile';
import type { LspProcessSupervisor } from '../lsp/process-supervisor';
import { addMemoryItem } from '../session/inbox';
import { normalizeRlmMaxDepth } from '../session/rlm-settings';
import type { ModelProvider } from '../session/provider-manager';
import type { SessionSubagentHost } from '../session/subagent-host';
import type { SubagentCapabilityMode } from '../session/subagent-capability';
import type { SkillRegistry } from '../skill';
import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../utils/tokens';
import type { PromisableMethods } from '../utils/types';
import { BackgroundManager } from './background';
import { EventSubscriptionBus } from './events';
import type { FileHistory } from '../session/file-history';
import { FullCompaction, MicroCompaction, resolveHousekeeping, type CompactionStrategy } from './compaction';
import { CronManager } from './cron';
import { ConfigState } from './config';
import { ContextMemory } from './context';
import { USER_PROMPT_ORIGIN } from './context/types';
import { GoalMode } from './goal';
import { HookEngine } from '../session/hooks';
import { InjectionManager } from './injection/manager';
import { DreamTracker, EXIT_EXTRACTION_SYSTEM_PROMPT, MemoryMemoStore, buildExitExtractionPrompt, createEmbeddingEngine, hasEmbeddingModelCache, parseMemoryMemos, sharedMemoStore, stampProject, stripMemoryTags, type EmbeddingEngine } from '@scream-code/memory';
import { KnowledgeStore, sharedKnowledgeStore, sharedKnowledgeStoreReady } from '@scream-code/knowledge';
import { PermissionManager, type PermissionManagerOptions } from './permission';
import { PlanMode } from './plan';
import { DEFAULT_SECRET_PATTERNS, SecretObfuscator, obfuscateMessages } from './secrets';
import { WolfPackMode } from './wolfpack';
import { SessionMemory } from './session-memory';
import { MEMORY_RECALL_VARIANT } from './injection/memory-recall';
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
  type GenerateFn,
  type GenerateOptionsWithRequestLog,
} from './turn/ltod-llm';
import { UsageRecorder } from './usage';
import type { SessionTokenMeter } from './usage/token-meter';
import { resolveCompletionBudget } from '../utils/completion-budget';
import type { Jian } from '@scream-code/jian';
import type { ToolServices } from '../tools/support/services';
import { scheduleCronTask, validateCronSchedule } from '../tools/cron/schedule';
import type { CronTask } from '../tools/cron/types';
import { legacyToolName } from '../tools/tool-names';

export type { AgentRecord, AgentRecordPersistence } from './records';
export { REPLAY_TURN_LIMIT } from './replay';
export type { BuiltinTool, ToolInfo, ToolSource, UserToolRegistration } from './tool';

export type AgentType = 'main' | 'sub' | 'independent';

const SIDE_QUESTION_SYSTEM =
  'You are a helpful coding assistant answering a quick side question. The user is in the middle of a coding session and needs a fast, concise answer. Keep your response short and focused — this is a side question, not the main task.';

/** Wire representation of the RLM recursion cap: `Infinity` (unlimited) is
 *  serialized as null, since JSON has no Infinity. */
function rlmMaxDepthForWire(maxDepth: number): number | null {
  return Number.isFinite(maxDepth) ? maxDepth : null;
}

export interface AgentOptions {
  readonly jian: Jian;
  readonly config?: ScreamConfig;
  readonly homedir?: string;
  readonly screamHomeDir?: string;
  /** Stable id of this agent inside its session ('main' for the root agent).
   *  Set by `Session.instantiateAgent`; defaults to 'main'. */
  readonly agentId?: string;
  /** Id of the session that owns this agent (set by `Session.instantiateAgent`
   *  from `Session.options.id`; undefined for an agent built outside a
   *  session). Tools whose state outlives their agent — the shell tool's parked
   *  background commands live in a process-wide registry — stamp it so a
   *  session's teardown reclaims only its own. */
  readonly sessionId?: string | undefined;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly persistence?: AgentRecordPersistence;
  readonly type?: AgentType;
  readonly generate?: typeof generate;
  readonly toolServices?: ToolServices;
  readonly compactionStrategy?: CompactionStrategy;
  readonly modelProvider?: ModelProvider | undefined;
  readonly subagentHost?: SessionSubagentHost | undefined;
  /** The host of the agent that spawned this one (subagents only) — used by
   * ContactParent to reach its owner's inbox. Set by Session.instantiateAgent. */
  readonly ownerHost?: SessionSubagentHost | undefined;
  readonly skills?: SkillRegistry;
  readonly mcp?: McpConnectionManager;
  readonly hookEngine?: HookEngine;
  readonly permission?: PermissionManagerOptions | undefined;
  readonly log?: Logger;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  /**
   * False when the host process will not outlive the current run (a one-off
   * `scream -p`): scheduled tasks are refused and none fire. Main agent only.
   */
  readonly scheduledTasks?: boolean | undefined;
  readonly resolveRuntimeSystemPrompt?: ((basePrompt: string) => string) | undefined;
  /** Process supervisor tracking this agent's LSP children (session-scoped). */
  readonly lspSupervisor?: LspProcessSupervisor | undefined;
  /** Session-wide token meter behind `loop_control.max_session_tokens`
   *  (shared by every agent of the session; see SessionTokenMeter). */
  readonly tokenMeter?: SessionTokenMeter | undefined;
  /** Session-wide file history (see FileHistory); shared by every agent of the session. */
  readonly fileHistory?: FileHistory | undefined;
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

/** How long a prompt waits for a first load of the (cached) embedding model. */
const MEMORY_ENGINE_WAIT_MS = 2000;

/** Page text sent to the helper model that answers `FetchURL` questions (about 30K tokens). */
const PAGE_ANSWER_MAX_CHARS = 120_000;

const PAGE_ANSWER_SYSTEM_PROMPT = [
  'You answer one question from one web page for another assistant.',
  'Use only the page. Keep facts, numbers, names, versions, code and commands exactly as written; quote short passages where wording matters.',
  'If the page does not answer the question, say so and say what it does cover.',
  'Answer in the language of the question. Be concise: no preamble, no advice beyond the page.',
].join('\n');

export class Agent {
  readonly type: AgentType;
  /** Stable id of this agent inside its session ('main' for the root agent);
   *  status events carry it so consumers can tell main from subagents. */
  readonly agentId: string;
  /** Session that owns this agent; undefined outside a session (see
   *  {@link AgentOptions.sessionId}). */
  readonly sessionId: string | undefined;
  readonly jian: Jian;
  readonly screamConfig?: ScreamConfig;
  readonly homedir?: string;
  readonly screamHomeDir?: string;
  /** Cache dir of the shared embedding engine (undefined when no scream home). */
  readonly embeddingCacheDir: string | undefined;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly toolServices?: ToolServices;
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  readonly rawGenerate: typeof generate;
  readonly modelProvider?: ModelProvider;
  readonly subagentHost?: SessionSubagentHost;
  /** The spawning agent's host (subagents only); see OwnerHostOptions. */
  readonly ownerHost?: SessionSubagentHost;
  readonly mcp?: McpConnectionManager;
  readonly hooks?: HookEngine;
  /** Process supervisor tracking this agent's LSP children (session-scoped). */
  readonly lspSupervisor: LspProcessSupervisor | undefined;
  /** Session-wide token meter (undefined outside a session). */
  readonly tokenMeter: SessionTokenMeter | undefined;
  readonly fileHistory: FileHistory | undefined;
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
  /** Session-scoped read/search repetition counter, handed to the file tools. */
  readonly repetitionGuard: RepetitionGuard;
  /**
   * Session-scoped snapshots of what the file tools last read/wrote, backing
   * stale-anchor recovery for line-range edits. Agent-held like
   * repetitionGuard so subagent boundaries never share snapshots.
   */
  readonly editSnapshots: EditSnapshotStore;
  /**
   * Session-scoped queue of errors that edits introduced, rendered into the
   * prompt by EditRecoveryInjector until they are fixed. Agent-held like
   * editSnapshots: a subagent's edits must never leak reminders into the
   * parent's prompt.
   */
  readonly editRecoveryQueue: EditRecoveryQueue;
  readonly dreamTracker: DreamTracker;
  readonly replayBuilder: ReplayBuilder;
  /**
   * Idle prompt-cache warmer for the main loop's routed requests (see
   * ./cache-warmer.ts). Undefined for sub agents: they are per-spawn
   * instances whose context dies with their single turn, so warming their
   * prefix protects a cache entry no future request will ever read.
   */
  readonly cacheWarmer: CacheWarmer | undefined;

  /** Read-only manifest of the core engine subsystems (see {@link AgentServices}). */
  readonly services: AgentServices;

  private lastLlmConfigLogSignature?: string;
  /** Last rendered system prompt written to a request.header record. */
  private lastRequestHeaderSystemPrompt?: string;
  private readonly sharedEmbeddingEngine: EmbeddingEngine;
  private readonly resolveRuntimeSystemPrompt: (basePrompt: string) => string;
  /** Alias → price lookup over the cached model catalog (see
   *  {@link createCatalogPricingLookup}); undefined for sub agents. */
  private readonly catalogPricing: AliasPricingLookup | undefined;
  /** Handle of the warmer's pending timer, so the injected
   *  scheduleTimer/clearTimer pair stays symmetric. */
  private cacheWarmerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AgentOptions) {
    // ── Group 1: external dependencies (injected via AgentOptions) ────────────
    this.type = options.type ?? 'main';
    this.agentId = options.agentId ?? 'main';
    this.sessionId = options.sessionId;
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
    this.ownerHost = options.ownerHost;
    this.mcp = options.mcp;
    this.hooks = options.hookEngine;
    this.lspSupervisor = options.lspSupervisor;
    this.tokenMeter = options.tokenMeter;
    this.fileHistory = options.fileHistory;
    // File changes are filed under the main agent's latest real user prompt
    // (the one an undo would remove with them), whichever agent makes them.
    if (this.type === 'main') this.fileHistory?.setPromptSource(() => this.context.latestRealPromptId());
    this.eventBus = new EventSubscriptionBus();
    const embedCacheDir = options.screamHomeDir !== undefined
      ? join(options.screamHomeDir, 'cache', 'fastembed')
      : undefined;
    this.embeddingCacheDir = embedCacheDir;
    this.sharedEmbeddingEngine = createEmbeddingEngine(embedCacheDir);
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
    // loop_control.compaction_mode = "off" turns micro off entirely: the
    // context read paths must not advance the cutoff behind the caller's back.
    this.microCompaction.setEnabled(this.screamConfig?.loopControl?.compactionMode !== 'off');

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
    this.cron =
      this.type === 'sub'
        ? null
        : new CronManager(this, { firing: options.scheduledTasks !== false });
    this.goal = new GoalMode(this);
    // Use a global memory store shared across all sessions/workDirs.
    const screamHomeDir = options.screamHomeDir;
    this.memoStore = screamHomeDir
      ? sharedMemoStore(screamHomeDir, this.log)
      : undefined;
    this.memoStoreReady = this.initMemoStore(screamHomeDir);
    // Knowledge store is main-agent-only — subagents don't need retrieval access.
    this.knowledgeStore =
      screamHomeDir !== undefined && this.type === 'main'
        ? sharedKnowledgeStore(screamHomeDir)
        : undefined;
    this.knowledgeStoreReady =
      this.knowledgeStore !== undefined && screamHomeDir !== undefined
        ? sharedKnowledgeStoreReady(screamHomeDir).catch((error: unknown) => {
            // Keep the old contract: init failures are logged, never thrown
            // into session creation.
            this.log.error('knowledge store init failed', error);
          })
        : Promise.resolve();
    this.sessionMemory = new SessionMemory(this);
    this.workingSet = new WorkingSet();
    // Session-scoped: every Agent (including subagents) owns one, so
    // repetition counts never leak across agent boundaries.
    this.repetitionGuard = new RepetitionGuard();
    // Session-scoped recovery snapshots, paired with repetitionGuard above:
    // they survive micro-compaction elision by design (compaction never
    // touches files on disk, so a snapshot keeps mirroring it) and are LRU-
    // bounded instead.
    this.editSnapshots = new EditSnapshotStore();
    // Paired with the snapshots above: the reminders outlive the tool result
    // that reported the errors, which is the whole point of queueing them.
    this.editRecoveryQueue = new EditRecoveryQueue();
    // Resolve through the authoritative home resolver rather than falling back
    // to '' — an empty home would put the state file in the current working
    // directory, i.e. in whatever project the session happens to run in.
    this.dreamTracker = new DreamTracker(resolveScreamHome(screamHomeDir));
    this.replayBuilder = new ReplayBuilder(this);
    // ── Group 5: idle-time economics (cache warmer) ──────────────────────────
    // Sub agents never warm: their context is single-turn by construction.
    // `disposeRlm` — the per-agent teardown the session checklist drives —
    // releases the warmer's timer on close.
    this.catalogPricing =
      this.type === 'sub'
        ? undefined
        : createCatalogPricingLookup(resolveScreamHome(screamHomeDir));
    this.cacheWarmer =
      this.type === 'sub'
        ? undefined
        : new CacheWarmer({
            // A tripped session token cap stops the warmer too: a replay is a
            // paid request like any other.
            getEnabled: () =>
              this.screamConfig?.loopControl?.cacheWarmer?.enabled === true &&
              this.tokenMeter?.exhausted() === undefined,
            getMinSavingsUsd:
              () =>
                this.screamConfig?.loopControl?.cacheWarmer?.minSavingsUsd ??
                DEFAULT_MIN_SAVINGS_USD,
            // The replayed capture is the routed request's outbound (already
            // obfuscated) form, so no second obfuscation pass.
            generate: (provider, systemPrompt, tools, history, callbacks, options) =>
              this.authedGenerate(provider, systemPrompt, tools, history, callbacks, options),
            getFingerprint: () => this.currentRequestFingerprint(),
            isIdle: () => !this.turn.hasActiveTurn,
            recordUsage: (model, usage) => {
              // Session scope like compaction: a replay happens outside any
              // turn, and the record must land even if the wire sink is
              // already closed (best-effort, logged, never thrown).
              try {
                this.usage.record(model, usage, 'session');
              } catch (error) {
                this.log.warn('cache warmer usage record failed', error);
              }
            },
            scheduleTimer: (cb, ms) => {
              this.cacheWarmerTimer = setTimeout(cb, ms);
            },
            clearTimer: () => {
              if (this.cacheWarmerTimer !== undefined) {
                clearTimeout(this.cacheWarmerTimer);
                this.cacheWarmerTimer = undefined;
              }
            },
            log: (message) => {
              this.log.warn(message);
            },
          });
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
        if (!this.memoStore!.getEmbeddingEngine()) {
          this.memoStore!.setEmbeddingEngine(this.sharedEmbeddingEngine);
        }
      } catch (error: unknown) {
        this.log.warn('embedding engine init failed; falling back to keyword search', error);
      }
      try {
        // Memos written while vectors could not be stored (or before an engine
        // existed) are only embedded by this pass; a write is the sole other trigger.
        // Loading the engine can download the model, which stays the user's call
        // (the setup card), so it is only woken when the model is already on disk.
        const modelCached =
          this.embeddingCacheDir !== undefined && hasEmbeddingModelCache(this.embeddingCacheDir);
        await this.memoStore!.backfillMissingEmbeddings({ loadEngine: modelCached });
      } catch (error: unknown) {
        this.log.warn('memory embedding backfill failed', error);
      }
    })();
  }

  /**
   * Make the shared embedding model ready for a memory search, without ever
   * downloading it (that stays the person's call, via the setup card). It is
   * loaded only when it is already on disk and there are memos with vectors
   * to compare against, because a loaded model costs a few hundred MB of
   * memory. Any memo counts, not only this project's: memos are stamped with
   * the folder a session started in, which is often the home folder or a
   * subfolder, so a per-project count would leave memory off where it fits.
   * A first load is waited for at most a couple of seconds.
   */
  async ensureMemoryEngine(_options: { readonly projectDir?: string } = {}): Promise<boolean> {
    const store = this.memoStore;
    if (store === undefined) return false;
    await this.memoStoreReady;
    const engine = store.getEmbeddingEngine();
    if (engine === undefined) return false;
    if (engine.available) return true;
    if (this.embeddingCacheDir === undefined || !hasEmbeddingModelCache(this.embeddingCacheDir)) return false;
    if (store.countEmbedded() === 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, MEMORY_ENGINE_WAIT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([engine.ensureReady().catch(() => false), gaveUp]);
    } finally {
      clearTimeout(timer);
    }
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

  /** The system prompt in provider request form: `[static, dynamic]` blocks
   *  when the runtime prompt carries the split marker, else the plain string.
   *  All request paths (main loop, compaction) must use this form so their
   *  requests share the provider-side prefix cache. */
  getRuntimeSystemPromptBlocks(): string | string[] {
    return systemPromptForRequest(this.getRuntimeSystemPrompt());
  }

  setRlmDepth(depth: number): void {
    this.rlmDepth = Math.max(0, depth);
  }

  getRlmMaxDepth(): number {
    return this.rlmMaxDepth;
  }

  setRlmMaxDepth(maxDepth: number): void {
    const normalized = normalizeRlmMaxDepth(maxDepth);
    // No-op writes would spam the wire: every subagent spawn calls this as
    // pure inheritance, so only actual changes are recorded/emitted.
    if (normalized === this.rlmMaxDepth) return;
    this.rlmMaxDepth = normalized;
    // Persist the cap (wire null = unlimited) regardless of the current mode:
    // /rlm-max-depth can be set while RLM is off, and the setting must
    // survive resume independently of enter/exit.
    this.records.logRecord({ type: 'rlm.settings', maxDepth: rlmMaxDepthForWire(this.rlmMaxDepth) });
    this.emitStatusUpdated();
  }

  /** Disposes the persistent python kernel (if any) and resets RLM mode.
   * Called on session close so no orphaned kernel process is left behind.
   * Only touches state when RLM was actually enabled — a session that never
   * used /rlm must not emit a spurious setActiveTools record (which would
   * pollute the wire log and, on a subagent that does not re-apply a profile
   * on resume, could strip MCP access patterns). */
  disposeRlm(): void {
    // Session-close seam: `disposeRlm` is the per-agent teardown the session
    // checklist drives (Session.registerDisposables → 'rlm' step, invoked
    // for every agent), so the cache warmer's pending timer is released here
    // too — a timer firing after close must never issue a replay on a
    // torn-down agent. Cheap when the warmer was never armed.
    this.cacheWarmer?.dispose();
    if (!this.rlmEnabled) return;
    this.rlmEnabled = false;
    const withoutPython = this.activeToolsWithoutPython();
    this.tools.setActiveTools(withoutPython);
    (this.tools.getBuiltinTool('Python') as { dispose?: () => void } | undefined)?.dispose?.();
    // Symmetric with setRlmEnabled(false): persist rlm.exit so a close →
    // resume replay restores rlmEnabled=false (and the python tool removal
    // above stays consistent). Without this, replay would see only rlm.enter
    // → badge lit, python tool removed by the close record → broken state.
    this.records.logRecord({ type: 'rlm.exit' });
  }

  /**
   * The active list without the RLM `Python` tool. A list from before the
   * rename may still carry the old name `python`, which `setActiveTools`
   * would turn back into `Python`; it goes too, unless a user or plugin tool
   * really has that name.
   */
  private activeToolsWithoutPython(): string[] {
    return this.tools
      .getActiveTools()
      .filter((name) => name !== 'Python' && !(name === legacyToolName('Python') && !this.tools.hasUserTool(name)));
  }

  /**
   * Enables or disables the /rlm persistent-python mode. On enable, the
   * `Python` tool is added to the active tools; on disable it is removed and
   * its kernel is disposed. Default state (disabled) leaves the tool list and
   * default behaviour untouched.
   */
  private setRlmEnabled(enabled: boolean): void {
    this.rlmEnabled = enabled;
    const current = this.tools.getActiveTools();
    if (enabled) {
      if (!current.includes('Python')) {
        this.tools.setActiveTools([...current, 'Python']);
      }
    } else {
      const withoutPython = this.activeToolsWithoutPython();
      if (withoutPython.length !== current.length) {
        this.tools.setActiveTools(withoutPython);
      }
      (this.tools.getBuiltinTool('Python') as { dispose?: () => void } | undefined)?.dispose?.();
    }
    this.records.logRecord(
      enabled
        ? { type: 'rlm.enter', maxDepth: rlmMaxDepthForWire(this.rlmMaxDepth) }
        : { type: 'rlm.exit' },
    );
    this.emitStatusUpdated();
  }

  /** Returns whether RLM (persistent python mode) is currently enabled. */
  getRlmEnabled(): boolean {
    return this.rlmEnabled;
  }

  /**
   * Enables or disables the script execution mode (`undefined` toggles) and
   * returns the resulting state. On enable, the `RunScript` tool joins the
   * active tools; on disable it is removed.
   *
   * The main agent's profile enables `RunScript` by default, so the agent-level
   * default (not in the active list) only applies to callers that build their
   * own tool list. No dedicated enter/exit record is needed (unlike RLM): the
   * tool list itself is replayed from `tools.set_active_tools`, so resume
   * restores the state automatically.
   */
  private setScriptEnabled(enabled?: boolean): boolean {
    const current = this.tools.getActiveTools();
    const next = enabled ?? !current.includes('RunScript');
    if (next) {
      if (!current.includes('RunScript')) {
        this.tools.setActiveTools([...current, 'RunScript']);
      }
    } else {
      const withoutScript = current.filter((name) => name !== 'RunScript');
      if (withoutScript.length !== current.length) {
        this.tools.setActiveTools(withoutScript);
      }
    }
    this.emitStatusUpdated();
    return next;
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
    if (!current.includes('Python')) {
      this.tools.setActiveTools([...current, 'Python']);
    }
    this.records.logRecord({
      type: 'rlm.enter',
      depth: this.rlmDepth,
      maxDepth: rlmMaxDepthForWire(this.rlmMaxDepth),
    });
  }

  /** Capability mode this agent runs under; `all` for main agents and for
   *  subagents the parent did not restrict. The RLM python bridge forwards it
   *  when it spawns on this agent's behalf, so a restricted agent cannot end
   *  up with an unrestricted grandchild. */
  private capabilityMode: SubagentCapabilityMode = 'all';

  /** Records the capability mode applied to this agent's tool set at spawn. */
  setCapabilityMode(mode: SubagentCapabilityMode): void {
    this.capabilityMode = mode;
  }

  /** Returns the capability mode applied to this agent's tool set. */
  getCapabilityMode(): SubagentCapabilityMode {
    return this.capabilityMode;
  }

  /** Restores RLM mode from a persisted record during replay, including the
   * recursion bookkeeping the enter payload carries since wire v1.6 (missing
   * fields mean an older wire — the defaults stay). Does not log a new record
   * and does not emit a status update (both are suppressed while records are
   * restoring). */
  restoreRlm(
    enabled: boolean,
    payload: {
      readonly depth?: number | undefined;
      readonly maxDepth?: number | null | undefined;
    } = {},
  ): void {
    if (payload.depth !== undefined) this.setRlmDepth(payload.depth);
    if (payload.maxDepth !== undefined) this.restoreRlmSettings(payload.maxDepth);
    this.rlmEnabled = enabled;
    const current = this.tools.getActiveTools();
    if (enabled) {
      if (!current.includes('Python')) {
        this.tools.setActiveTools([...current, 'Python']);
      }
    } else {
      const withoutPython = this.activeToolsWithoutPython();
      if (withoutPython.length !== current.length) {
        this.tools.setActiveTools(withoutPython);
      }
    }
  }

  /** Restores the RLM recursion cap from a persisted `rlm.settings` record
   * during replay. Silent on purpose: no new record, no status event. */
  restoreRlmSettings(maxDepth: number | null): void {
    this.rlmMaxDepth = maxDepth === null ? Infinity : normalizeRlmMaxDepth(maxDepth);
  }

  /**
   * Generate for every caller that hands over history in local form —
   * compaction (default and housekeeping), side questions, exit memory
   * extraction, `generateText`, skill planning. Messages are obfuscated here,
   * at the single seam they all share, so no auxiliary path can send a
   * configured or default secret pattern to a provider in the clear. (Before
   * this, only the main loop's `LtodLLM.chat` obfuscated, and compaction sent
   * raw history — to a different provider when housekeeping was configured.)
   *
   * Obfuscation is deterministic and the main loop sends the same obfuscated
   * projection, so the compaction request still shares the main request's
   * cache prefix. Callers whose messages are already in outbound form (the
   * routed main-loop request and the cache warmer's replay of it) use
   * `authedGenerate` instead of paying for a second pass.
   */
  get generate(): typeof generate {
    const authed = this.authedGenerate;
    // `async` on purpose: this used to be an async function, and callers (the
    // retry wrapper, `.catch()` chains) rely on a failure surfacing as a rejected
    // promise — obfuscation runs before the first await, so without it a throw
    // there would escape synchronously.
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      const obfuscator = this.obfuscator;
      const outbound =
        obfuscator !== undefined && obfuscator.hasSecrets()
          ? obfuscateMessages(obfuscator, history)
          : history;
      return authed(provider, systemPrompt, tools, outbound, callbacks, options);
    };
  }

  /** Obfuscate a locally assembled string (e.g. a system prompt that embeds history). */
  obfuscateOutboundText(text: string): string {
    const obfuscator = this.obfuscator;
    return obfuscator !== undefined && obfuscator.hasSecrets() ? obfuscator.obfuscate(text) : text;
  }

  /** Restore placeholders in model output shown or returned to a local consumer. */
  deobfuscateInboundText(text: string): string {
    const obfuscator = this.obfuscator;
    return obfuscator !== undefined && obfuscator.hasSecrets() ? obfuscator.deobfuscate(text) : text;
  }

  /**
   * Auth-resolving generate with no obfuscation pass. Only for messages that
   * are already in outbound (obfuscated) form — see `generate`.
   */
  private get authedGenerate(): typeof generate {
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
   *
   * Every caller sends on the session model, so the response's usage is
   * recorded under the session alias (session scope — never the current
   * turn's HitR). Without it `/usage` silently omitted every auxiliary call,
   * and the session token cap could not see knowledge-base ingestion — which
   * may issue many of them.
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
        const result = await this.generate(provider, systemPrompt, [...tools], [...messages]);
        this.recordAuxiliaryUsage(result.usage);
        return result;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableGenerateError(error)) throw error;
        const delayMs = computeDelayMs(error, delays, attempt);
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
  }

  /**
   * Answer a question from a fetched page, for `FetchURL` with a question: the
   * page goes to the housekeeping model (the cheap one bound in `/model diy`
   * or `housekeeping_model`), or to the session model when none is set, and
   * only the answer comes back to the turn. The page text is capped at
   * {@link PAGE_ANSWER_MAX_CHARS}; usage is billed to the model that answered.
   */
  async answerFromPage(request: {
    readonly url: string;
    readonly question: string;
    readonly content: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<string> {
    const page = request.content.length > PAGE_ANSWER_MAX_CHARS
      ? `${request.content.slice(0, PAGE_ANSWER_MAX_CHARS)}\n[page cut at ${String(PAGE_ANSWER_MAX_CHARS)} characters]`
      : request.content;
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Question: ${request.question}\n\nPage: ${request.url}\n\n<page>\n${page}\n</page>`,
          },
        ],
        toolCalls: [],
      },
    ];
    const housekeeping = resolveHousekeeping(this);
    let result: Awaited<ReturnType<typeof generate>>;
    if (housekeeping === undefined) {
      const attempt = () =>
        this.generate(
          this.config.provider.withThinking(this.config.thinkingLevel),
          PAGE_ANSWER_SYSTEM_PROMPT,
          [],
          messages,
          undefined,
          { signal: request.signal },
        );
      try {
        result = await attempt();
      } catch (error) {
        if (!isRetryableGenerateError(error) || request.signal?.aborted === true) throw error;
        result = await attempt();
      }
      this.recordAuxiliaryUsage(result.usage);
    } else {
      const send = (auth: ProviderRequestAuth) =>
        this.generate(
          // Carry the session's thinking level: always-thinking models reject 'off'.
          housekeeping.provider.withThinking(this.config.thinkingLevel),
          PAGE_ANSWER_SYSTEM_PROMPT,
          [],
          messages,
          undefined,
          { signal: request.signal, auth },
        );
      const attempt = () =>
        // An explicit empty auth keeps the session model's OAuth wrapper away
        // from another provider (see the housekeeping path in compaction).
        housekeeping.authRequest === undefined ? send({}) : housekeeping.authRequest(send);
      try {
        result = await attempt();
      } catch (error) {
        if (!isRetryableGenerateError(error) || request.signal?.aborted === true) throw error;
        result = await attempt();
      }
      try {
        if (result.usage !== null && result.usage !== undefined) {
          this.usage.record(housekeeping.modelName, result.usage, 'session');
        }
      } catch (error) {
        this.log.warn('page answer usage record failed', error);
      }
    }
    const content = result.message.content;
    const answer = typeof content === 'string'
      ? content
      : content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return this.deobfuscateInboundText(answer.trim());
  }

  /**
   * Usage of an auxiliary (non-loop) request. Best-effort like the cache
   * warmer's: exit memory extraction runs while the session is closing, when
   * the wire sink may already be gone — accounting must never fail the call.
   */
  private recordAuxiliaryUsage(usage: TokenUsage | null | undefined): void {
    const alias = this.config.modelAlias;
    if (usage === null || usage === undefined || alias === undefined) return;
    try {
      this.usage.record(alias, usage, 'session');
    } catch (error) {
      this.log.warn('auxiliary usage record failed', error);
    }
  }

  get llm(): LtodLLM {
    const model = this.config.model;
    const provider = this.config.provider.withThinking(this.config.thinkingLevel);
    const loopControl = this.screamConfig?.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      reservedContextSize: loopControl?.reservedContextSize,
    });
    const systemPrompt = this.resolveRuntimeSystemPrompt(this.config.systemPrompt);
    return new LtodLLM({
      provider,
      modelName: model,
      systemPrompt,
      systemPromptBlocks: systemPromptForRequest(systemPrompt),
      capability: this.config.modelCapabilities,
      // Wrapped so every main-loop routed request is captured for the idle
      // cache-warmer (see routedGenerateWithCapture). The getter's only
      // consumer is the turn loop, so auxiliary paths — compaction,
      // housekeeping, side questions, which call `this.generate` directly —
      // never capture.
      generate: (provider, systemPrompt, tools, history, callbacks, options) =>
        this.routedGenerateWithCapture(provider, systemPrompt, tools, history, callbacks, options),
      completionBudgetConfig,
      obfuscator: this.obfuscator,
    });
  }

  /**
   * The fallback model's LLM, built like {@link llm} from the alias bound in
   * `/model` (the live `fallback` tier). Undefined when none is set, when it is
   * the session model itself, or when the alias no longer resolves. It
   * authenticates with its own provider and is not captured for the cache
   * warmer: it only stands in while the session model is down.
   */
  resolveFallbackLlm(): LtodLLM | undefined {
    const alias = this.subagentHost?.resolveModelTier('fallback');
    if (alias === undefined || alias === this.config.modelAlias) return undefined;
    const resolved = this.modelProvider?.tryResolveChatModel(alias);
    if (resolved === undefined) {
      this.log.warn('fallback model does not resolve in the provider registry; staying on the session model', {
        fallbackModel: alias,
      });
      return undefined;
    }
    const loopControl = this.screamConfig?.loopControl;
    const systemPrompt = this.resolveRuntimeSystemPrompt(this.config.systemPrompt);
    const authRequest = resolved.authRequest;
    const generate: GenerateFn = async (provider, prompt, tools, history, callbacks, options) => {
      if (authRequest === undefined) {
        this.logLlmRequest(provider, prompt, tools, history, options);
        return this.rawGenerate(provider, prompt, tools, history, callbacks, options);
      }
      return authRequest((auth) => {
        const requestOptions = { ...options, auth };
        this.logLlmRequest(provider, prompt, tools, history, requestOptions);
        return this.rawGenerate(provider, prompt, tools, history, callbacks, requestOptions);
      });
    };
    return new LtodLLM({
      // A model that cannot think rejects a thinking level; one that can carries the session's.
      provider: resolved.provider.withThinking(resolved.capabilities.thinking ? this.config.thinkingLevel : 'off'),
      modelName: resolved.modelName,
      systemPrompt,
      systemPromptBlocks: systemPromptForRequest(systemPrompt),
      capability: resolved.capabilities,
      generate,
      completionBudgetConfig: resolveCompletionBudget({ reservedContextSize: loopControl?.reservedContextSize }),
      obfuscator: this.obfuscator,
    });
  }

  /**
   * The main loop's routed generate, wrapped to capture the exact request
   * (provider instance, system blocks, tool table, messages, reported usage)
   * the loop just sent, so the idle cache-warmer can replay it verbatim at
   * ~90% of the declared cache TTL. Capture is latest-wins: each step
   * replaces the previous capture, so the request held at tick time is
   * always the turn's last routed one.
   */
  private readonly routedGenerateWithCapture: GenerateFn = async (
    provider,
    systemPrompt,
    tools,
    history,
    callbacks,
    options,
  ) => {
    // LtodLLM.chat already obfuscated `history`; skip the second pass.
    const result = await this.authedGenerate(provider, systemPrompt, tools, history, callbacks, options);
    this.noteRoutedCacheWarmRequest(provider, systemPrompt, tools, history, result);
    return result;
  };

  private noteRoutedCacheWarmRequest(
    provider: ChatProvider,
    systemPrompt: string | string[],
    tools: readonly Tool[],
    history: readonly Message[],
    result: { readonly usage: TokenUsage | null },
  ): void {
    const warmer = this.cacheWarmer;
    if (warmer === undefined) return;
    // Zero-cost early-out while the feature is off: no fingerprinting, no
    // alias resolution, no catalog read.
    if (this.screamConfig?.loopControl?.cacheWarmer?.enabled !== true) return;
    const aliasName = this.config.modelAlias;
    const alias =
      aliasName === undefined ? undefined : this.screamConfig?.models?.[aliasName];
    warmer.noteRoutedRequest({
      provider,
      aliasName,
      systemPromptBlocks: systemPrompt,
      tools,
      messages: history,
      usage: result.usage ?? undefined,
      cacheRetention: alias?.cacheRetention,
      price:
        alias === undefined || this.catalogPricing === undefined
          ? undefined
          : this.catalogPricing({ provider: alias.provider, model: alias.model }),
      fingerprint: requestFingerprint(tools, history),
    });
  }

  /**
   * Fingerprint of what the NEXT routed request would send right now — the
   * live offered tool table plus the LLM-bound message projection. The
   * warmer's tick compares this with the capture-time fingerprint to verify
   * the captured prefix is still intact (prefix-wise, so legitimate tail
   * appends from finished turns pass and real mutations fail).
   *
   * Computed in the same outbound form the request layer sends (secrets
   * obfuscated) so it is comparable with the capture-time fingerprint, which
   * is taken from the exact arrays the loop handed to the provider. Uses the
   * read-only `context.messages` projection rather than `messagesForLLM` so
   * an idle-time observation cannot synthesize tool results into the
   * context; the standard micro-compaction detect() pass every LLM-bound
   * read performs still runs, which only ever advances the cutoff the next
   * turn would advance anyway.
   */
  private currentRequestFingerprint(): string | undefined {
    try {
      const tools = this.tools.loopTools;
      const messages = this.context.messages;
      const obfuscator = this.obfuscator;
      const outbound =
        obfuscator !== undefined && obfuscator.hasSecrets()
          ? obfuscateMessages(obfuscator, messages)
          : messages;
      return requestFingerprint(tools, outbound);
    } catch {
      return undefined;
    }
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
    systemPrompt: string | string[],
    tools: readonly Tool[],
    history: readonly Message[],
    options: Parameters<typeof generate>[5],
  ): void {
    const context = buildLlmRequestContext(options);
    // Wire logging and token estimation work on the full text; block
    // boundaries are a request-shaping detail the stored header does not need
    // (see profile/system-prompt-parts.ts).
    const systemPromptText =
      typeof systemPrompt === 'string' ? systemPrompt : systemPrompt.join('\n\n');
    const configMetadata = buildLlmConfigMetadata(
      provider,
      this.config.modelAlias,
      systemPromptText,
      tools,
    );
    this.logLlmConfigIfChanged(
      context,
      configMetadata,
      buildLlmConfigSignature(configMetadata, systemPromptText, tools),
    );

    let partialMessageCount = 0;
    for (const message of history) {
      if (message.partial === true) partialMessageCount += 1;
    }
    const requestMetadata: LlmRequestMetadata = {
      estimatedInputTokens:
        estimateTokens(systemPromptText) +
        estimateTokensForMessages(history) +
        estimateTokensForTools(tools),
    };
    if (partialMessageCount > 0) {
      requestMetadata.partialMessageCount = partialMessageCount;
    }
    // Per-request snapshot in the wire log so the request can be rebuilt
    // later (provider identity, model, rendered system prompt, active tools,
    // message count). The rendered system prompt is the single largest field
    // (~50KB) and is almost always byte-identical to the previous request, so
    // it is stored only when it changed — otherwise a long-lived session
    // accumulates one full copy of the prompt per request.
    const systemPromptReused = systemPromptText === this.lastRequestHeaderSystemPrompt;
    this.lastRequestHeaderSystemPrompt = systemPromptText;
    this.records.logRecord({
      type: 'request.header',
      provider: provider.name,
      model: provider.modelName,
      modelAlias: this.config.modelAlias ?? '',
      ...(systemPromptReused ? { systemPromptReused: true } : { systemPrompt: systemPromptText }),
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
      // Without this the `{{ ROLE_ADDITIONAL }}` block in system.md never
      // renders, and user-prefs.md only survives through the per-turn
      // reminder injector instead of living in the (cacheable) system prompt.
      roleAdditional: context?.roleAdditional,
      ...(this.screamHomeDir === undefined ? {} : { screamHomeDir: this.screamHomeDir }),
    });
    // An explicit `tools:` contract (SDK callers, subagent profiles, pinned
    // session bots) is applied EXACTLY. The default resolved set has no such
    // contract, so the deferred-tool portal shapes it: low-frequency group
    // names held back, `DiscoverTools` offered instead, groups enabled
    // earlier this session kept. `setActiveTools` never shapes on its own.
    const activeTools = profile.toolsExplicit
      ? profile.tools
      : this.tools.defaultShapedToolNames(profile.tools);
    this.config.update({ profileName: profile.name, systemPrompt, activeTools });
    this.tools.setActiveTools(activeTools);


    // Rebuild the builtin registry AFTER the profile name is on the config and
    // the active names are set. Which collaboration tools exist is
    // profile-dependent — canSpawn reads the `spawns` whitelist of
    // `config.profileName` — and setActiveTools only records names, so a tool
    // the profile lists but the registry never constructed would be dropped by
    // loopToolsFor. A spawned child triggers a rebuild before its profile is
    // applied, which left plan/reviewer children without their `Agent` tool for
    // the whole run; this second pass fixes that for every profile-gated tool
    // (Agent / SendSubagentMessage / WolfPack). Same provider guard as
    // ConfigState.update: agents without a usable provider (tests, migrated
    // sessions) must not blow up while building tools.
    if (this.config.hasProvider) {
      this.tools.initializeBuiltinTools();
      // An EXPLICIT list is exact, so it is never reshaped by the portal —
      // but the construction gate above skipped every deferred group, which
      // left a listed deferred name without an instance (loopToolsFor then
      // dropped it, and the portal tool is not in an explicit list either).
      // Re-register the owning group's instances without touching the
      // enabled set: the list stays verbatim, and a name whose group has no
      // backing runtime stays inert instead of pretending to work.
      if (profile.toolsExplicit) {
        this.tools.registerExplicitDeferredTools(activeTools);
      }
    }
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

  /**
   * The cron manager is null for sub agents (see the field initializer), so
   * every cron entry point funnels through here — same shape as the
   * `skills === null` guard in `activateSkill`.
   */
  private requireCron(): CronManager {
    if (this.cron === null) {
      throw new ScreamError(
        ErrorCodes.CRON_UNAVAILABLE,
        'Cron scheduling is not available for this agent',
      );
    }
    return this.cron;
  }

  /** Shape one stored task for the wire; `nextFireAt` is re-queried unless given. */
  private cronTaskInfo(
    manager: CronManager,
    task: CronTask,
    nextFireAt?: number | null,
  ): CronTaskInfo {
    return {
      id: task.id,
      cron: task.cron,
      prompt: task.prompt,
      createdAt: task.createdAt,
      recurring: task.recurring !== false,
      stale: manager.isStale(task),
      lastFiredAt: task.lastFiredAt,
      nextFireAt:
        nextFireAt === undefined ? manager.getNextFireForTask(task.id) : nextFireAt,
      ...(task.silent === true ? { silent: true } : {}),
      ...(task.mute === true ? { mute: true } : {}),
      ...(task.lastError === undefined || task.lastError === null
        ? {}
        : { lastError: task.lastError }),
    };
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
        // SDK callers reach the exact list through here rather than
        // `useProfile`, so the same gap applies: on a portal-active registry
        // the deferred group's instances were never built and the listed name
        // would be dropped by loopToolsFor. Register them AFTER the list
        // lands — the list itself stays exact.
        if (this.config.hasProvider) {
          this.tools.registerExplicitDeferredTools(payload.names);
        }
      },
      setRlmEnabled: (payload) => {
        this.setRlmEnabled(payload.enabled);
      },
      setScriptEnabled: (payload) => this.setScriptEnabled(payload.enabled),
      setRlmMaxDepth: (payload) => {
        this.setRlmMaxDepth(payload.maxDepth);
      },
      stopBackground: (payload) => {
        void this.background.stop(payload.taskId, payload.reason);
      },
      clearContext: () => {
        this.context.clear();
      },
      undoHistory: async (payload) => {
        // The prompts this undo removes, before it removes them: their file
        // changes are taken back (or forgotten) with them.
        const promptIds = this.context.promptIdsToUndo(payload.count);
        this.context.undo(payload.count);
        const history = this.type === 'main' ? this.fileHistory : undefined;
        if (history === undefined || promptIds.length === 0) return { restored: [], skipped: [] };
        if (payload.files === 'restore') return history.restore(promptIds);
        await history.discard(promptIds);
        return { restored: [], skipped: [] };
      },
      previewUndoFiles: async (payload) => {
        const history = this.type === 'main' ? this.fileHistory : undefined;
        if (history === undefined) return [];
        return history.changedFiles(this.context.promptIdsToUndo(payload.count));
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
      listCronTasks: () => {
        const manager = this.requireCron();
        return manager.store.list().map((task) => this.cronTaskInfo(manager, task));
      },
      createCronTask: (payload) => {
        // Same gates as the model-facing CronCreate tool (see
        // tools/cron/schedule.ts); a rejection surfaces the tool's exact
        // sentence as the error message.
        const manager = this.requireCron();
        const accepted = validateCronSchedule(manager, payload);
        if (!accepted.ok) {
          throw new ScreamError(ErrorCodes.CRON_INVALID, accepted.error);
        }
        const created = scheduleCronTask(manager, accepted, payload);
        if (!created.ok) {
          throw new ScreamError(ErrorCodes.CRON_INVALID, created.error);
        }
        return this.cronTaskInfo(manager, created.task, created.nextFireAt);
      },
      removeCronTasks: (payload) => this.requireCron().removeTasks(payload.ids),
      startScheduledTasks: () => this.requireCron().enableFiring(),
      extractMemoriesOnExit: async (payload) => {
        return this.extractMemoriesOnExit({ pending: payload.pending === true });
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
      getRlmMaxDepth: () => {
        return this.rlmMaxDepth;
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
  /**
   * Extract what the session learned. `pending` (an unattended session: a
   * background job, continued work) puts the memories in the "waiting for
   * you" inbox instead of the store, so nothing learned without the person
   * reaches later sessions until they save it.
   */
  async extractMemoriesOnExit(options: { readonly pending?: boolean } = {}): Promise<number> {
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
    // Recalled memories are already stored: leave them out of the sample so
    // they are not extracted again as this session's experience.
    const sampleText = history
      .slice(-50)
      .filter((m) => m.origin?.kind !== 'injection' || m.origin.variant !== MEMORY_RECALL_VARIANT)
      .map((m) => {
        const text = stripMemoryTags(
          m.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join(' '),
        );
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

      for (const memo of memos) {
        memo.sourceSessionId = sessionId;
        memo.sourceSessionTitle = sessionTitle ?? '';
        memo.extractionSource = 'exit';
        stampProject(memo, this.config.cwd);
      }
      if (options.pending === true && this.screamHomeDir !== undefined) {
        addMemoryItem(this.screamHomeDir, { sessionId, workDir: this.config.cwd, memories: memos });
        this.log.info('Unattended session memories wait for confirmation', { count: memos.length, sessionId });
        return memos.length;
      }
      const store = this.memoStore;
      // Sequential on purpose: two near-identical memos in one batch have to see
      // each other, and a parallel race would let both through.
      let failed = 0;
      let stored = 0;
      for (const memo of memos) {
        try {
          const result = await store.appendUnlessDuplicate(memo);
          if (result.duplicateOf === undefined) stored += 1;
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        this.log.warn('Some memory memos failed to store from exit extraction', {
          failed,
          total: memos.length,
        });
      }

      this.log.info('Extracted memory memos on session exit', {
        count: stored,
        skipped: memos.length - stored - failed,
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

    // The excerpt rides in the system prompt, which `generate` does not
    // obfuscate (only messages), so mask it here.
    const system = conversationContext
      ? `${SIDE_QUESTION_SYSTEM}\n\n<conversation_context>\n${this.obfuscateOutboundText(conversationContext)}\n</conversation_context>`
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

    return text ? this.deobfuscateInboundText(text) : '(no response)';
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
    // The user prompt went out obfuscated (via `generate`); callers consume
    // the answer locally, so restore any placeholders the model echoed.
    return this.deobfuscateInboundText(
      response.message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    );
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
      agentId: this.agentId,
      model,
      thinkingLevel: this.config.thinkingLevel,
      contextTokens,
      maxContextTokens,
      contextUsage,
      planMode: this.planMode.isActive,
      planStrategy: this.planMode.isActive ? this.planMode.strategy : undefined,
      wolfpackMode: this.wolfpackMode.isActive,
      rlmEnabled: this.rlmEnabled,
      rlmMaxDepth: rlmMaxDepthForWire(this.rlmMaxDepth),
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
