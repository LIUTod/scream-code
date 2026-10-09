import type { TokenUsage } from '@scream-code/ltod';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import type { LoopTurnStopReason } from '../loop';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import { linkAbortSignal, userCancellationReason } from '../utils/abort';
import { collectGitContext } from './git-context';
import {
  DEFAULT_BYTE_LIMIT,
  DEFAULT_IN_FLIGHT_LIMIT,
  SubagentMessageBus,
  buildSubagentMessage,
  subagentMessageBytes,
  type SubagentMessage,
  type SubagentMessageStatus,
} from './subagent-messages';
import { renderNotificationXml } from '../agent/context/notification-xml';
import {
  filterToolsForCapability,
  inferCapabilityFromTools,
  narrowerCapability,
  type SubagentCapabilityMode,
} from './subagent-capability';
import type { Session } from './index';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md';
import STRUCTURED_MESSAGE_DELIVERY_PROMPT from './structured-message-delivery.md';
import { parseJsonObject } from '../tools/builtin/collaboration/agent';
import {
  formatArchFindingsBlock,
  getArchFindingsFromStore,
} from '../tools/builtin/collaboration/report-arch-finding';
import {
  formatFindingsBlock,
  getFindingsFromStore,
} from '../tools/builtin/collaboration/report-finding';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
/**
 * Follow-up turns spent delivering queued parent messages, counted separately
 * from the summary-expansion budget above. Sharing one counter meant a summary
 * that was too short consumed the only delivery window, so a message queued a
 * few milliseconds later was destroyed at run end while the parent still held
 * an "accepted" acknowledgement.
 *
 * Scope: this budget bounds the MAILBOX path only — a message that has to wait
 * for a turn start, and therefore only ever costs a delivery turn. A mid-run
 * `steer` (including the foreground→background handoff, where the parent wakes
 * from a blocked Agent call and answers the still-running child) joins the turn
 * that is already running through the steer buffer instead; it is bounded there
 * by DEFAULT_IN_FLIGHT_LIMIT and must not spend delivery turns, because no
 * delivery turn is needed to reach it.
 */
const MAX_PARENT_MESSAGE_DELIVERY_TURNS = 2;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
/**
 * Upper bound on how long a finished child's resource release may hold back the
 * `completion` its callers await. A healthy release finishes in well under a
 * second; the bound only bites when a language server has stopped answering,
 * where the wait is capped only by the LSP request timeout and every caller —
 * the foreground Agent tool call, TaskStop, rlm_wait — is parked with it, so
 * the parent turn looks hung.
 */
const CHILD_RELEASE_BOUND_MS = 5_000;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';

/**
 * Render parent messages as the block a child sees. Both delivery paths share
 * this — the mid-run steer and the turn-start injection — so a message looks
 * identical to the child however it arrives. Anything that is not a plain
 * `queue` message renders as a `[directive]` (steer, and the interject that
 * degrades to a mailbox steer).
 */
function formatParentMessagesBlock(
  messages: readonly Pick<SubagentMessage, 'operation' | 'text'>[],
): string {
  const body = messages
    .map((m) => (m.operation === 'queue' ? `[message] ${m.text}` : `[directive] ${m.text}`))
    .join('\n\n');
  return `[parent_messages]\n${body}`;
}

type RunSubagentOptions = {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string | undefined;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin | undefined;
  readonly signal: AbortSignal;
  /** When set, the child is told to reply with a single JSON object matching
   *  this JSON Schema; short structured answers skip the summary expansion. */
  readonly outputSchema?: string | undefined;
  /** Runtime capability contract; stricter modes strip the child's tool set. */
  readonly capabilityMode?: SubagentCapabilityMode | undefined;
};

export type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
  /** Number of child turns (initial turn + summary continuations). */
  readonly turns?: number;
  /** Wall-clock run duration in milliseconds (spawn → completion). */
  readonly durationMs?: number;
  /** Total assistant tool calls across the child's history. */
  readonly toolCallCount?: number;
};

type ActiveChild = {
  readonly controller: AbortController;
  runInBackground: boolean;
  /** True when the current run must end in machine-parseable output. */
  structured: boolean;
};

/**
 * What a parent→child dedupe key currently stands for — the message a re-send
 * of the same operation+text would duplicate. Either it waits in the mailbox
 * (identified by its stable bus id, so `SubagentMessageBus.holdsMessage` can
 * tell whether the copy is still undelivered) or it joined a live turn's steer
 * buffer (where the buffer length at acceptance is the observable handle: a
 * buffer that has since drained below that mark was flushed, so the message
 * reached the child's context).
 */
type ParentMessageReceipt =
  | { readonly kind: 'mailbox'; readonly messageId: string }
  | { readonly kind: 'steer'; readonly bufferLengthAtSend: number };

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<string, ActiveChild>();
  /** Per-turn budget (≤4 accepted) for child→parent collaboration requests. */
  private readonly childRequestCounts = new Map<string, number>();
  /** Dedupe keys seen within the current turn, per child. */
  private readonly childRequestSeen = new Map<string, Set<string>>();
  /**
   * Parent→child message dedupe ledger, per child, for the child's current
   * turn: key → the in-flight message that key stands for. A retried send (the
   * parent re-issuing the same directive after a tool hiccup) must not reach
   * the child twice WHILE the first copy is still in flight; once the child has
   * consumed that copy — the mailbox no longer holds it, or the steer buffer
   * has flushed it — the key is released, because a re-send then is a fresh
   * instruction rather than a retry of an undelivered one. Asking again in a
   * later turn is legitimate too, so the ledger is cleared with the child
   * request limits.
   */
  private readonly parentMessageSeen = new Map<string, Map<string, ParentMessageReceipt>>();
  /** Profile names of children spawned or resumed through this host, keyed by
   *  child id. `getProfileName` falls back to it once a child is evicted: the
   *  Agent tool reads that name to validate the parent's `spawns` whitelist on
   *  the resume path, and an evicted child has no live config left to read. */
  private readonly childProfiles = new Map<string, string>();
  /** Agent → childId lookup for child→parent collaboration requests. */
  private readonly childIdByAgent = new WeakMap<Agent, string>();
  /**
   * One-shot "this child submitted a collaboration request" wake-ups, keyed by
   * child id. The Agent tool registers one when a foreground wait begins — the
   * parent is parked inside the tool call, so the parent turn has no step
   * boundary to flush the notification into — and releases it when the wait
   * ends. `submitChildRequest` resolves it once the request has been steered to
   * the parent. Without a registration the request keeps the plain
   * notification path (it waits for the parent's next boundary).
   */
  private readonly childRequestWaiters = new Map<
    string,
    { readonly promise: Promise<void>; readonly resolve: () => void }
  >();

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
    readonly backgroundTaskTimeoutMs?: number | undefined,
    private readonly modelBindings?: () => Record<string, string | undefined>,
    /** Shared per-session directed-message bus for parent→child messages. */
    readonly bus?: SubagentMessageBus | undefined,
  ) {
    this.bus ??= new SubagentMessageBus();
  }

  async spawn(profileName: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = this.session.agents.get(this.ownerAgentId);
    if (parent === undefined) {
      throw new Error(`Parent agent "${this.ownerAgentId}" was not found`);
    }

    const profile = this.resolveProfile(parent, profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      undefined,
      this.ownerAgentId,
    );
    // Record the profile by child id, not by instance: `getProfileName` must
    // still answer once this child is evicted, because the Agent tool reads it
    // to validate the parent's `spawns` whitelist on the resume path.
    this.childProfiles.set(id, profile.name);
    // RLM recursion depth: every spawned child starts one level deeper than
    // its spawner — the counter lives on the agent instance, not the process,
    // and is incremented on every spawn (whether the spawn came from the RLM
    // kernel or the Agent tool). The max-depth cap is inherited too, so
    // /rlm-max-depth configured on the root applies uniformly to every
    // descendant; the RLM bridge consults both when the kernel spawns on this
    // agent's behalf (agent/tool/index.ts, rlm.run). Persisting the cap here
    // (rlm.settings) keeps a resumed child's records self-contained.
    // RLM inheritance itself is applied in configureChild, after the profile
    // has mounted its tools — doing it here would be wiped by useProfile's
    // setActiveTools(profile.tools) overwrite.
    agent.setRlmDepth(parent.getRlmDepth() + 1);
    agent.setRlmMaxDepth(parent.getRlmMaxDepth());
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(id, {
      controller,
      runInBackground: options.runInBackground,
      structured: options.outputSchema !== undefined,
    });

    const run = this.runChild(
      parent,
      id,
      agent,
      profile.name,
      {
        ...options,
        signal: controller.signal,
      },
      () => this.configureChild(parent, agent, profile, id, options.capabilityMode),
    );
    const completion = this.withChildTerminalRelease(
      parent,
      agent,
      { childId: id, unlinkAbortSignal },
      run,
    );

    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = this.session.agents.get(this.ownerAgentId);
    if (parent === undefined) {
      throw new Error(`Parent agent "${this.ownerAgentId}" was not found`);
    }

    // A finished child is evicted from Session.agents (see the run finally);
    // ensureAgent re-hydrates it from persisted records when needed.
    let child = this.session.agents.get(agentId);
    if (child === undefined && typeof this.session.ensureAgent === 'function') {
      child = await this.session.ensureAgent(agentId).catch(() => undefined);
    }
    if (child === undefined) {
      throw new Error(`Agent instance "${agentId}" was not found`);
    }
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(
        `Agent instance "${agentId}" is already running and cannot be resumed concurrently`,
      );
    }

    const profileName = child.config.profileName ?? 'subagent';
    this.childProfiles.set(agentId, profileName);
    // Resume is a spawn by another name, so it must clear the same `spawns`
    // whitelist the Agent tool enforces on the spawn path — from one source of
    // truth (`spawnWhitelistFor`, the expression agent/tool/index.ts derives
    // `allowedSpawns` from). The Agent tool also checks the resumed profile,
    // but it resolves it through `getProfileName`, which for an evicted child
    // (the resume case) has no live instance to read and used to report
    // `undefined` — silently skipping the check. Here the just-rehydrated
    // instance is in hand, so the check cannot be bypassed; a rejection
    // happens before any run state is registered.
    const whitelist = spawnWhitelistFor(parent);
    if (whitelist !== undefined && !whitelist.includes(profileName)) {
      throw new Error(
        `Subagent profile "${profileName}" is not in the parent profile's spawn whitelist (${whitelist.join(', ')}): agent "${agentId}" cannot be resumed by this parent`,
      );
    }

    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(agentId, {
      controller,
      runInBackground: options.runInBackground,
      structured: options.outputSchema !== undefined,
    });

    const run = this.runChild(
      parent,
      agentId,
      child,
      profileName,
      {
        ...options,
        signal: controller.signal,
      },
      // A resumed subagent is realigned to its bound model (or the parent's
      // current model when unbound), so a /model diy rebind or a parent
      // setModel between the initial spawn and the resume is reflected.
      () => {
        // RLM parameters are deliberately NOT re-pushed from the parent here:
        // the child's recursion state (enabled / depth / cap) is restored from
        // its own wire records — the `rlm.enter` payload (v1.6+) and
        // `rlm.settings` — so a resume keeps exactly what the child had when
        // it last ran, independent of later parent-side changes.
        const binding = this.resolveModelBinding(profileName);
        const modelAlias = this.resolveValidModelAlias(parent, binding);
        const thinkingLevel = this.resolveThinkingLevel(parent, binding, parent.config.thinkingLevel);
        child.config.update({ modelAlias, thinkingLevel });
        // Resume may only TIGHTEN the capability contract, never widen it. A
        // resumed agent keeps the tool set it already has (the profile is not
        // rebuilt), so a wider reported/persisted mode would open a gap where
        // the contract claims more than the tools actually grant — and the RLM
        // bridge forwards that claim to grandchildren, handing them more than
        // the child ever had. To get a wider contract, spawn a fresh child.
        const persisted = metadata.capabilityMode;
        // Pre-upgrade sessions carry no stored contract; the live tool set is
        // the only surviving evidence of the original trim, so infer the
        // strictest mode those tools already satisfy.
        const baseline = persisted ?? inferCapabilityFromTools(child.tools.getActiveTools());
        const requested = options.capabilityMode;
        const effective = requested === undefined ? baseline : narrowerCapability(requested, baseline);
        // Re-apply the capability trim: without this a stale capability_mode
        // would be silently dropped while the composed prompt still claims a
        // (stricter) constraint.
        if (effective !== 'all') {
          child.tools.setActiveTools(
            filterToolsForCapability(child.tools.getActiveTools(), effective),
          );
        }
        // Unconditional, mirroring configureChild: the RLM bridge reads
        // getCapabilityMode() when it spawns grandchildren, so a resumed
        // read-only child must not regress to the in-memory 'all' default.
        child.setCapabilityMode(effective);
        // Persist what this resume settled on. Three cases differ from the
        // stored record: a metadata-restored value re-writes nothing (no-op),
        // an inferred value for a pre-upgrade session is written back so the
        // next resume no longer depends on inference, and a tighter explicit
        // request updates the stored contract for the next resume.
        this.session.markAgentCapability(agentId, effective);
        return Promise.resolve();
      },
    );
    const completion = this.withChildTerminalRelease(
      parent,
      child,
      { childId: agentId, unlinkAbortSignal },
      run,
    );

    return {
      agentId,
      profileName,
      resumed: true,
      completion,
    };
  }

  /**
   * Flip a child's lifecycle flag to "background". Used when a foreground
   * Agent call times out and hands its still-running child to the background
   * task manager: from that point parent-turn cancellation (cancelAll) must
   * NOT cascade into the child — the background task manager is the sole owner
   * of its termination (TaskStop → abort callback). Mirrors the reference
   * implementation's backgrounded lifecycle.
   */
  markBackground(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) {
      child.runInBackground = true;
    }
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.agents.get(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  /**
   * Profile name of one of this host's children, or undefined when the id is
   * not a child of this owner. Reads the live instance when it is resident and
   * falls back to the name recorded at spawn/resume: a finished child is
   * evicted from `session.agents`, and its resumability is then judged from
   * exactly this call (the Agent tool validates the parent's spawn whitelist
   * before calling `resume`), so reporting `undefined` for the evicted child
   * would skip the whitelist instead of consulting it.
   */
  getProfileName(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return this.session.agents.get(agentId)?.config.profileName ?? this.childProfiles.get(agentId);
  }

  /**
   * Chain a child run's terminal step: release the child's own resources, then
   * evict it (bookkeeping, mailbox slot, live Agent reference).
   *
   * Both halves have to happen here rather than in `Session.close()`: the child
   * leaves `session.agents` in this step, so a teardown that walks that map can
   * no longer reach its LSP servers or its RLM kernel. `run` is awaited inside
   * the `try` so a run that threw (failure, stop) releases exactly like a
   * completed one, and the release finishes before the caller's `completion`
   * settles — awaiting the run also awaits its process teardown (bounded by
   * `CHILD_RELEASE_BOUND_MS`, see `releaseChildResourcesBounded`).
   */
  private async withChildTerminalRelease<T>(
    parent: Agent,
    child: Agent,
    terminal: { readonly childId: string; readonly unlinkAbortSignal: () => void },
    run: Promise<T>,
  ): Promise<T> {
    try {
      const result = await run;
      return result;
    } finally {
      // The child cannot consume a terminal task notification anymore, and a
      // task that outlives the run — a parked foreground command is the shape
      // this covers — would otherwise steer one into an evicted agent:
      // `AgentTurn.steer` on an idle turn launches a new one (see
      // BackgroundManager.notifyBackgroundTask), which for the evicted child is
      // a ghost — real model calls nobody can read. Latch the child's manager
      // shut here, before the bounded resource release below, exactly the way
      // `Session.close()` latches every manager it created: the notification
      // stays undelivered, and a later resume of this child runs a brand-new
      // manager whose reconcile reports the task as lost instead.
      child.background.markSessionClosed();
      terminal.unlinkAbortSignal();
      await this.releaseChildResourcesBounded(parent, child, terminal.childId);
      this.activeChildren.delete(terminal.childId);
      this.childRequestCounts.delete(terminal.childId);
      this.childRequestSeen.delete(terminal.childId);
      this.parentMessageSeen.delete(terminal.childId);
      // A wake-up registration cannot outlive its child's run: the completion
      // leg settles the Agent tool's race anyway, and dropping the entry here
      // covers every exit path (completion, failure, abort) even when no
      // caller reached its own release.
      this.childRequestWaiters.delete(terminal.childId);
      // The terminal evicts the live Agent reference and the bookkeeping that
      // belongs to a running child — but NOT its mailbox. Mail accepted here
      // was answered `accepted` to the parent, and the mailbox is in-memory
      // bus state: re-hydrating the child (ensureAgent) rebuilds the agent from
      // its records and would not bring a purged message back. An undelivered
      // message therefore stays deliverable until its own deadline (a resume of
      // this child polls it at the next turn start) and is reclaimed by the
      // bus' expiry sweep afterwards, so the mailbox map stays bounded either
      // way (see subagent-messages.ts).
      this.session.removeAgent?.(terminal.childId);
      // Direct Map delete (the accessor is optional on session shims) so a
      // finished child cannot pin the live instance either way.
      if (terminal.childId !== 'main') this.session.agents.delete(terminal.childId);
    }
  }

  /**
   * `releaseChildResources`, awaited for at most `CHILD_RELEASE_BOUND_MS`.
   *
   * The healthy path is unchanged: the release is still awaited to completion,
   * so the "released before evict" ordering holds. The bound only matters for a
   * child whose language server stopped answering — `LspClient.stop()` waits
   * for its `shutdown` request, which is capped only by the 120s request
   * timeout, so an unresponsive server used to hold every caller awaiting
   * `completion` (foreground Agent call, TaskStop, rlm_wait) for ~125s.
   *
   * Past the bound the release keeps running in the background — the process is
   * still reaped, just not before the caller gets its result — and the wait is
   * reported once so the stall is visible instead of silent.
   */
  private async releaseChildResourcesBounded(
    parent: Agent,
    child: Agent,
    childId: string,
  ): Promise<void> {
    // Attached up front: a release that fails (or fails long after the bound
    // fired) is reported here and must never become an unhandled rejection or
    // replace the run's own result.
    const release = this.releaseChildResources(parent, child).catch((error: unknown) => {
      parent.log.warn('Failed to release subagent resources', { childId, error: String(error) });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<'bound'>((resolve) => {
      timer = setTimeout(() => {
        resolve('bound');
      }, CHILD_RELEASE_BOUND_MS);
    });
    try {
      const outcome = await Promise.race([release.then(() => 'released' as const), bound]);
      if (outcome === 'bound') {
        parent.log.warn(
          `subagent ${childId}: resource release exceeded ${CHILD_RELEASE_BOUND_MS}ms and continues in the background (a language server is likely unresponsive); completion is not held back by it`,
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Stop the resources a finished child owns itself. `Session.close()` is the
   * only other place that calls `disposeLsp()` / disposes an RLM kernel, and it
   * iterates `session.agents` — but the terminal `finally` evicts every child
   * from that map in the same turn, so between the two the child's tsserver and
   * its python kernel become unreachable while still running: one leaked
   * process set per subagent run, not per session. Called from the run
   * `finally`, so all exit paths (completion, failure, stop) release.
   *
   * Ownership is per agent, never inherited by reference: each agent's own
   * `ToolManager.initializeBuiltinTools` constructs its `LspRegistry` and its
   * `PythonTool` (own kernel process, own rlm() handle table), so disposing the
   * child's instances cannot reach the parent's. The python tool is
   * additionally guarded by a reference check against the parent's instance, so
   * a kernel that ever became inherited-by-reference instead of child-owned
   * would survive here rather than be killed by mistake.
   *
   * The kernel is torn down directly instead of through `Agent.disposeRlm()`:
   * disposeRlm records `rlm.exit` and drops `python` from the tool set, which
   * would make a later resume replay this child as RLM-disabled even though the
   * parent it inherited the mode from is still running RLM. Killing the kernel
   * leaves no orphan process while keeping the child's mode on its records.
   */
  private async releaseChildResources(parent: Agent, child: Agent): Promise<void> {
    try {
      await child.tools.disposeLsp();
    } catch (error) {
      // Reported, never rethrown: throwing from the `finally` would replace the
      // run's own result (or its rejection) with this teardown error.
      parent.log.warn('Failed to dispose subagent lsp servers', { error: String(error) });
    }
    const python = child.tools.getBuiltinTool('python') as { dispose?: () => void } | undefined;
    if (python === undefined || python === parent.tools.getBuiltinTool('python')) return;
    try {
      python.dispose?.();
    } catch (error) {
      parent.log.warn('Failed to dispose subagent rlm kernel', { error: String(error) });
    }
  }

  /**
   * Send a directed message to a subagent owned by this parent. Ownership is
   * verified against the session metadata before anything is enqueued; a
   * message addressed to a foreign or unknown agent is refused as
   * `not_owned`/`not_found`, one addressed to a finished child as `not_active`,
   * and one whose sender is no longer resident in the session as `parent_gone`
   * — an accepted message must have a live owner that can observe (and act on)
   * the delivery it was promised, instead of being acknowledged into a bus
   * whose owning turn has already ended.
   *
   * `steer` redirects a running child without disturbing its in-flight tools;
   * `interject` does the same but additionally interrupts the tool batch in
   * flight, so a child stuck in a long wait reads the correction immediately.
   */
  sendMessage(
    toAgentId: string,
    operation: 'queue' | 'steer' | 'interject',
    text: string,
    overrides?: { inFlightLimit?: number; byteLimit?: number; deadline?: number },
  ): {
    status: SubagentMessageStatus;
    reason?: 'bytes' | 'queue';
    /** How an accepted message reaches the child; absent when not accepted. */
    delivery?: 'mid-run' | 'queued' | 'interjected';
    queueDepth?: number;
    /** True when this exact message is already in flight for the child. */
    duplicate?: boolean;
    /** Stable id of the message this result accepted — or, on a duplicate, of
     *  the still-in-flight copy the parent just retried. A retry never mints a
     *  second id for the same logical message, which is what makes the ids
     *  usable for reconciliation. */
    messageId?: string;
    /** Why an accepted `interject` did not interrupt: it fell back to the
     *  mailbox. Absent when the interrupt fired (or for queue/steer). */
    downgrade?: 'structured' | 'idle' | 'steer-buffer-full';
  } {
    const metadata = this.session.metadata.agents[toAgentId];
    if (metadata === undefined || metadata.type !== 'sub') return { status: 'not_found' };
    if (metadata.parentAgentId !== this.ownerAgentId) return { status: 'not_owned' };
    const child = this.session.agents.get(toAgentId);
    const record = this.activeChildren.get(toAgentId);
    if (child === undefined || record === undefined) return { status: 'not_active' };
    // An accepted message promises the live owner will observe the delivery.
    // Once the owner is evicted from the session there is no turn left to
    // observe it, so the send is refused instead of acknowledged into a bus
    // nobody owns.
    if (this.session.agents.get(this.ownerAgentId) === undefined) return { status: 'parent_gone' };

    // The bus has no interrupt concept: an interject that has to wait keeps
    // plain steer semantics — steer priority in the mailbox, `[directive]`
    // rendering — so it is stored under the steer operation.
    const message = buildSubagentMessage(
      this.ownerAgentId,
      toAgentId,
      operation === 'queue' ? 'queue' : 'steer',
      text,
      overrides,
    );
    const byteLimit = overrides?.byteLimit ?? DEFAULT_BYTE_LIMIT;
    // Checked before the dedupe ledger or a steer buffer sees the text: an
    // oversized message must not claim a key that a later, legal retry would
    // then duplicate.
    if (subagentMessageBytes(text) > byteLimit) return { status: 'saturated', reason: 'bytes' };

    // Idempotency: a retried send — the parent re-issuing the same directive
    // after a tool hiccup, or concluding the first attempt did not land — must
    // not reach the child twice while the first copy is still in flight. Once
    // that copy has been consumed (polled out of the mailbox, or flushed from
    // the steer buffer into the child's turn) the key is released: the retry
    // then carries a fresh instruction rather than an undelivered duplicate.
    let seen = this.parentMessageSeen.get(toAgentId);
    if (seen === undefined) {
      seen = new Map();
      this.parentMessageSeen.set(toAgentId, seen);
    }
    const dedupeKey = `${operation}\n${text}`;
    const pending = seen.get(dedupeKey);
    if (pending !== undefined) {
      if (this.parentMessageInFlight(child, pending)) {
        return {
          status: 'accepted',
          duplicate: true,
          ...(pending.kind === 'mailbox' ? { messageId: pending.messageId } : {}),
        };
      }
      seen.delete(dedupeKey);
    }

    // A steer exists to redirect work that is already running, so when the child
    // has a live turn it is injected into that turn and joins at the child's
    // next step boundary (Turn.flushSteerBuffer). The origin is not `user`, so
    // Turn.hasPendingSteer leaves the tool call in flight alone. hasActiveTurn
    // and steer() run back to back with no await between them, so the turn
    // cannot end in between and steer() cannot launch one of its own.
    //
    // An interject is the same steer with `interrupt: true`: Turn's
    // hasPendingSteer predicate treats an explicit interrupt as pending, so the
    // mid-batch poll cuts the tool batch short and the message reaches the model
    // immediately instead of after a long wait.
    //
    // Two exceptions keep the guarantees intact:
    // - Structured-output children keep the mailbox path: their bounded
    //   delivery turn re-prompts with the JSON guard, so a steered answer
    //   cannot decay into prose and break the contract. An interject is
    //   deliberately conservative here too (first release): a structured
    //   child stuck in a tool call is still stopped with TaskStop, never by
    //   interrupting the batch that produces its machine-readable answer. The
    //   result carries the reason as `downgrade` so the receipt can say why
    //   the interrupt did not fire.
    // - A full steer buffer (same budget as the mailbox) falls back to the
    //   mailbox, so neither channel is unbounded.
    const wantsMidRunSteer = operation === 'steer' || operation === 'interject';
    if (
      wantsMidRunSteer &&
      !record.structured &&
      child.turn.hasActiveTurn &&
      child.turn.steerQueueLength < DEFAULT_IN_FLIGHT_LIMIT
    ) {
      child.turn.steer(
        [{ type: 'text', text: formatParentMessagesBlock([message]) }],
        {
          kind: 'system_trigger',
          name: operation === 'interject' ? 'parent_interject' : 'parent_message',
        },
        operation === 'interject' ? { interrupt: true } : undefined,
      );
      // The entry is registered only once the message actually landed; the
      // buffer length at acceptance is what later tells a retry whether this
      // copy is still waiting or has been flushed into the child's turn.
      seen.set(dedupeKey, { kind: 'steer', bufferLengthAtSend: child.turn.steerQueueLength });
      return {
        status: 'accepted',
        delivery: operation === 'interject' ? 'interjected' : 'mid-run',
      };
    }

    const out = this.bus!.send(message);
    if (out.status === 'accepted' && out.messageId !== undefined) {
      seen.set(dedupeKey, { kind: 'mailbox', messageId: out.messageId });
    }
    return {
      status: out.status,
      reason: out.reason,
      delivery: out.status === 'accepted' ? 'queued' : undefined,
      queueDepth: out.queueDepth,
      messageId: out.messageId,
      // The receipt has to say why an interject became a queued message, or a
      // caller reads "queued" as "the batch is being cut short".
      downgrade:
        operation === 'interject' && out.status === 'accepted'
          ? record.structured
            ? 'structured'
            : child.turn.hasActiveTurn
              ? 'steer-buffer-full'
              : 'idle'
          : undefined,
    };
  }

  /**
   * Whether the message a dedupe key stands for is still undelivered. Mailbox
   * copies are judged by the bus (which also reclaims expired mail, so a
   * message that can never arrive reads as consumed); steered copies by the
   * turn's buffer: a buffer shorter than the length recorded at acceptance was
   * flushed — flushes drain the whole buffer, so the copy rode along. A full
   * buffer that flushed and was refilled reads as still in flight (the count is
   * back at or above the mark); that errs toward deduplicating, never toward
   * delivering the same directive twice.
   */
  private parentMessageInFlight(child: Agent, pending: ParentMessageReceipt): boolean {
    if (pending.kind === 'mailbox') return this.bus!.holdsMessage(pending.messageId);
    return child.turn.hasActiveTurn && child.turn.steerQueueLength >= pending.bufferLengthAtSend;
  }

  /**
   * Child→parent collaboration request (B-scheme). A subagent can proactively
   * contact its owner mid-run: `info` (ask for context/clarification),
   * `handoff` (ask to pass the work to another capability — described as a
   * need, never a named agent), or `escalate` (bump to the human). The
   * request lands in the parent's mailbox and the parent is woken via a
   * `child_request` notification at its next turn boundary (buffered if it is
   * mid-turn). Rate limits: ≤4 accepted requests per child turn, duplicate
   * (type+needs+message-prefix) requests within a turn are deduped.
   */
  submitChildRequest(
    fromAgent: Agent,
    req: {
      request_type: 'info' | 'handoff' | 'escalate';
      message: string;
      needs?: string;
      payload?: {
        artifacts?: string[];
        evidence?: string[];
        missing?: string[];
        expecting?: string;
      };
    },
  ): { status: SubagentMessageStatus; deduped?: boolean } {
    const fromChildId = this.childIdByAgent.get(fromAgent);
    if (fromChildId === undefined || !this.activeChildren.has(fromChildId)) {
      return { status: 'not_active' };
    }
    // Liveness before bookkeeping: a request accepted for a parent that can
    // never observe it is a false acknowledgement, and it must not spend the
    // per-turn budget, claim a dedupe key, or settle the foreground wake.
    const parent = this.session.agents.get(this.ownerAgentId);
    if (parent === undefined) return { status: 'parent_gone' };
    const count = this.childRequestCounts.get(fromChildId) ?? 0;
    if (count >= 4) return { status: 'saturated' };
    const dedupeKey = `${req.request_type}|${req.needs ?? ''}|${req.message}`;
    let seen = this.childRequestSeen.get(fromChildId);
    if (seen === undefined) {
      seen = new Set();
      this.childRequestSeen.set(fromChildId, seen);
    }
    if (seen.has(dedupeKey)) return { status: 'accepted', deduped: true };
    seen.add(dedupeKey);
    this.childRequestCounts.set(fromChildId, count + 1);

    // Free-text fields are flattened onto a single line: the notification body
    // is line-oriented, and a multi-line value would spill into the message
    // when the TUI parses the body back.
    const flat = (value: string): string => value.replaceAll(/\s*\n\s*/g, ' ');
    const lines = [
      `${req.request_type}: ${req.message}`,
      req.needs !== undefined ? `needs: ${flat(req.needs)}` : undefined,
      req.payload?.expecting !== undefined && req.payload.expecting.length > 0
        ? `expecting: ${flat(req.payload.expecting)}`
        : undefined,
      req.payload?.artifacts !== undefined && req.payload.artifacts.length > 0
        ? `artifacts: [${req.payload.artifacts.join(', ')}]`
        : undefined,
      req.payload?.evidence !== undefined && req.payload.evidence.length > 0
        ? `evidence: [${req.payload.evidence.join(', ')}]`
        : undefined,
      req.payload?.missing !== undefined && req.payload.missing.length > 0
        ? `missing: [${req.payload.missing.join(', ')}]`
        : undefined,
    ].filter((l): l is string => l !== undefined);

    // Delivery is notification-only: the full request text rides inside the
    // steer notification, so the parent sees it at its next turn boundary
    // without a bus mailbox that nothing ever polls (which would accumulate
    // accepted-but-unread messages and saturate). Rate limits above are the
    // only backpressure needed. The parent is resident here — a missing one
    // was refused as `parent_gone` above, before any bookkeeping.
    parent.turn.steer(
      [
        {
          type: 'text',
          text: renderNotificationXml({
            id: `child_request:${fromChildId}:${Date.now()}`,
            category: 'task',
            type: 'child_request',
            source_kind: 'subagent',
            source_id: fromChildId,
            title: `Subagent ${req.request_type} request`,
            severity: 'info',
            body: lines.join('\n'),
          }),
        },
      ],
      { kind: 'system_trigger', name: 'child_request' },
    );
    this.childRequestWaiters.get(fromChildId)?.resolve();
    return { status: 'accepted' };
  }

  /**
   * Register (or reuse) the one-shot wake-up resolved when this child submits
   * its next accepted collaboration request. Called by the Agent tool when a
   * foreground wait begins; the returned promise resolves at most once.
   */
  waitForChildRequest(childId: string): Promise<void> {
    const existing = this.childRequestWaiters.get(childId);
    if (existing !== undefined) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.childRequestWaiters.set(childId, { promise, resolve });
    return promise;
  }

  /**
   * Drop a child's wake-up registration (its foreground wait ended). The entry
   * is deleted rather than kept resolved: the next foreground wait registers a
   * fresh one-shot signal, so a stale resolution cannot background a later run.
   */
  releaseChildRequestWait(childId: string): void {
    this.childRequestWaiters.delete(childId);
  }

  /** Per-turn budget reset for child→parent collaboration requests. */
  private resetChildRequestLimits(childId: string): void {
    this.childRequestCounts.set(childId, 0);
    this.childRequestSeen.set(childId, new Set());
    // Fresh per-turn ledger: every copy registered in the previous turn has
    // either been consumed by the turn that just ended (poll/flush) or was
    // already released by the in-flight check — re-issuing the same text in a
    // new turn is a legitimate re-ask, not a retry.
    this.parentMessageSeen.set(childId, new Map());
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  private async runChild(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
    prepareChild: () => Promise<void>,
  ): Promise<SubagentCompletion> {
    const startedAt = Date.now();
    let turns = 1;
    this.childIdByAgent.set(child, childId);
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      runInBackground: options.runInBackground,
    });

    try {
      await prepareChild();
      options.signal.throwIfAborted();
      await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
      options.signal.throwIfAborted();
      parent.emitEvent({
        type: 'subagent.started',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        subagentName: profileName,
        runInBackground: options.runInBackground,
      });

      // Explore subagents start cold; a git-context block helps them orient
      // in the repository before searching.
      let childPrompt = options.prompt;
      if (profileName === 'explore') {
        const gitContext = await collectGitContext(child.jian, child.config.cwd);
        if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
      }
      // Parent→child directed messages (P2): any messages queued/steered to
      // this subagent are injected at EVERY turn start (first turn and each
      // summary-continuation turn), so a message sent while the child is
      // mid-run is delivered at its next boundary rather than dropped.
      const injectParentMessages = (prompt: string): string => {
        const pending = this.bus!.poll(childId);
        if (pending.length === 0) return prompt;
        return `${prompt}\n\n${formatParentMessagesBlock(pending)}`;
      };
      this.resetChildRequestLimits(childId);
      childPrompt = injectParentMessages(childPrompt);
      const origin: PromptOrigin = options.origin ?? { kind: 'system_trigger', name: 'subagent' };
      child.turn.prompt([{ type: 'text', text: childPrompt }], origin);
      await runChildTurnToCompletion(child, options.signal);

      // A subagent that returns an overly terse summary leaves the parent
      // agent under-informed. Give it a bounded number of chances to expand
      // the handoff; if it is still short after that, accept it as-is rather
      // than retrying indefinitely.
      let result = lastAssistantText(child);
      // When the parent requested a structured (schema-shaped) answer, do not
      // expand short replies: a compact JSON object is expected and padding it
      // with prose would corrupt the parseable result.
      if (options.outputSchema === undefined) {
        let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
        let remainingDeliveryTurns = MAX_PARENT_MESSAGE_DELIVERY_TURNS;
        // Two separate budgets: one for expanding a too-short summary, one for
        // delivering parent messages that arrived mid-run. Sharing a single
        // counter let a short summary spend the only delivery window, so a
        // message queued milliseconds later never reached the child even though
        // the parent had already been told it was accepted.
        let needsExpansion = result.length < SUMMARY_MIN_LENGTH && remainingContinuations > 0;
        let hasPending = this.bus!.activeCount(childId) > 0 && remainingDeliveryTurns > 0;
        while (needsExpansion || hasPending) {
          if (needsExpansion) remainingContinuations -= 1;
          if (hasPending) remainingDeliveryTurns -= 1;
          turns += 1;
          options.signal.throwIfAborted();
          this.resetChildRequestLimits(childId);
          const continuation = injectParentMessages(SUMMARY_CONTINUATION_PROMPT);
          child.turn.prompt([{ type: 'text', text: continuation }], origin);
          await runChildTurnToCompletion(child, options.signal);
          result = lastAssistantText(child);
          needsExpansion = result.length < SUMMARY_MIN_LENGTH && remainingContinuations > 0;
          hasPending = this.bus!.activeCount(childId) > 0 && remainingDeliveryTurns > 0;
        }
      } else if (this.bus!.activeCount(childId) > 0) {
        // Structured request: summary expansion is skipped so a compact JSON
        // answer is not padded with prose, but a parent message that arrived
        // while no turn was running still has to be delivered before the run
        // ends — the parent was told it was accepted. One bounded delivery turn
        // re-prompts the child to resend its JSON answer after reading the
        // message block.
        turns += 1;
        options.signal.throwIfAborted();
        this.resetChildRequestLimits(childId);
        const delivery = injectParentMessages(STRUCTURED_MESSAGE_DELIVERY_PROMPT);
        child.turn.prompt([{ type: 'text', text: delivery }], origin);
        await runChildTurnToCompletion(child, options.signal);
        // The delivery turn's purpose is delivering the message, not rewriting
        // the answer. If the child failed to resend a parseable JSON object
        // (e.g. it replied in prose), keep the pre-drain structured result so
        // the delivery never destroys the requested [structured] contract.
        const steered = lastAssistantText(child);
        result = parseJsonObject(steered) !== undefined ? steered : result;
      }

      const usage = child.usage.data().total;

      // Aggregate the child's usage into the PARENT agent's session totals:
      // without this, per-session cost/token accounting silently omits every
      // subagent (their usage only lands on the short-lived child agent).
      // Session scope, not turn: a background child can finish after the
      // parent turn already ended, so turn attribution is unreliable.
      //
      // Delta-based against a ledger keyed by the child's STABLE agent id: a
      // resumed child is re-hydrated by ensureAgent as a NEW Agent instance
      // whose replayed recorder already holds its whole history, so an
      // instance-keyed cache would miss and fold that history into the parent
      // a second time. The ledger remembers how much of the id's cumulative
      // usage has been folded (session-scoped, so rebuilding an owner's host
      // does not lose it) and only the newly accrued part is folded in.
      const childByModel = child.usage.data().byModel ?? {};
      const ledger = foldedChildUsageFor(this.session);
      const previous = ledger.get(childId) ?? {};
      const deltas: Record<string, TokenUsage> = {};
      for (const [model, childUsage] of Object.entries(childByModel)) {
        const delta = previous[model] === undefined ? childUsage : subtractUsage(childUsage, previous[model]);
        if (!isZeroUsage(delta)) deltas[model] = delta;
      }
      // A background grandchild can outlive the child that spawned it: by the
      // time it finishes, its direct parent may already be evicted, and a fold
      // into that finished agent's recorder would be read by nobody. The
      // chain walks up to the nearest resident ancestor so the totals still
      // roll up to the session (see usageFoldTarget). The intermediate's own
      // recorder deliberately does not receive this delta — only its live
      // total could ever have rolled it up — so no compensating entry is
      // needed there; the child's ledger below is the one that must remember
      // the amount was folded.
      const foldTarget = this.usageFoldTarget(parent);
      for (const [model, delta] of Object.entries(deltas)) {
        try {
          foldTarget.usage.record(model, delta, 'session');
        } catch (error) {
          // Usage accounting is ancillary: a failure here must never fail
          // the completed subagent (the parent turn already has its result).
          parent.log.warn('Failed to aggregate subagent usage', { model, error: String(error) });
        }
      }
      ledger.set(childId, childByModel);

      // Aggregate structured findings so the parent agent can act on them
      // without re-parsing free-text summaries. Both blocks carry the problem
      // text: a title and a line number alone do not tell the parent why the
      // finding is a problem. No profile gate — a finding only reaches a store
      // when a tool that writes it ran, and each tool is mounted only for the
      // profiles that declare it.
      const findingsBlock = [
        formatFindingsBlock(getFindingsFromStore(child.tools.toolStore)),
        formatArchFindingsBlock(getArchFindingsFromStore(child.tools.toolStore)),
      ].join('');

      const durationMs = Date.now() - startedAt;
      const toolCallCount = countAssistantToolCalls(child);
      parent.emitEvent({
        type: 'subagent.completed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        resultSummary: result,
        usage,
        contextTokens: child.context.tokenCount,
        turns,
        durationMs,
        toolCallCount,
      });
      this.triggerSubagentStop(parent, profileName, result);
      return { result: result + findingsBlock, usage, turns, durationMs, toolCallCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parent.emitEvent({
        type: 'subagent.failed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        error: message,
        usage: child.usage.data().total,
      });
      // SubagentStop is a lifecycle notification, not a success signal: a hook
      // that mirrors child runs (metrics, cleanup, logging) has to see a failed
      // or cancelled run too, or it silently under-counts. `error` carries the
      // failure; `response` carries whatever the child had produced by then.
      this.triggerSubagentStop(parent, profileName, lastAssistantText(child), message);
      throw error;
    }
  }

  /**
   * Where a finished child's usage delta is folded. Normally its direct parent.
   * When that parent has been evicted from the session (a background
   * grandchild can outlive the child that spawned it), its recorder is no
   * longer part of any live rollup — the fold would land on an agent nobody
   * reads again — so the delta goes to the nearest RESIDENT ancestor instead,
   * and the chain keeps rolling up through finished intermediates. The delta
   * is recorded exactly once, at that target: the ledger that guards against
   * re-folding is keyed by the CHILD, so a later resume of the intermediate
   * can never fold the amount a second time (its own total never received it).
   *
   * The direct parent is the fallback when nothing in the chain is resident
   * (session teardown): recording there is what happened before this walk, and
   * no live reader remains to disagree.
   */
  private usageFoldTarget(parent: Agent): Agent {
    const resident = this.session.agents.get(parent.agentId);
    if (resident !== undefined) return resident;
    let ancestorId = this.session.metadata.agents[parent.agentId]?.parentAgentId ?? null;
    while (ancestorId !== null) {
      const ancestor = this.session.agents.get(ancestorId);
      if (ancestor !== undefined) return ancestor;
      ancestorId = this.session.metadata.agents[ancestorId]?.parentAgentId ?? null;
    }
    return parent;
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    childId: string,
    capabilityMode?: SubagentCapabilityMode,
  ): Promise<void> {
    // A subagent uses the model bound to its profile via /model diy when one
    // is configured; otherwise it inherits the parent agent's model. A binding
    // whose alias has since been removed from config.toml falls back to the
    // parent model rather than sending the subagent into a hung LLM call.
    const binding = this.resolveModelBinding(profile.name);
    const modelAlias = this.resolveValidModelAlias(parent, binding);
    const thinkingLevel = this.resolveThinkingLevel(parent, binding, parent.config.thinkingLevel);
    child.config.update({
      cwd: parent.config.cwd,
      modelAlias,
      thinkingLevel,
    });

    const context = await prepareSystemPromptContext(child.jian);
    child.useProfile(profile, context);

    // RLM inheritance must happen AFTER useProfile mounts the profile's tools
    // (setActiveTools overwrites the active set). Mounting python here means
    // the child can keep spawning its own subagents — the recursion chain
    // continues down the tree instead of stopping at the first level. Only
    // applies when the parent is actually running in RLM mode.
    if (parent.getRlmEnabled()) {
      child.inheritRlm();
    }

    // Capability enforcement (runtime tool filtering) must happen AFTER RLM
    // inheritance: inheritRlm unconditionally re-adds python, which would
    // otherwise bypass the trim. The final active set is decided by the
    // capability mode — execute keeps python, read-only/read-write drop it.
    if (capabilityMode !== undefined && capabilityMode !== 'all') {
      const current = child.tools.getActiveTools();
      const filtered = filterToolsForCapability(current, capabilityMode);
      child.tools.setActiveTools(filtered);
    }

    // Record the effective mode on the child: anything that spawns on its
    // behalf later (the RLM python bridge) must pass the same restriction down
    // instead of handing the grandchild the full tool set.
    child.setCapabilityMode(capabilityMode ?? 'all');
    // Persist the same contract in session metadata, so a resume after a
    // process restart re-applies it instead of silently falling back to 'all'.
    this.session.markAgentCapability(childId, capabilityMode ?? 'all');
  }

  private resolveModelBinding(profileName: string): string | undefined {
    const bindings = this.modelBindings?.();
    if (bindings === undefined) return undefined;
    const alias = bindings[profileName];
    if (typeof alias !== 'string' || alias.trim().length === 0) return undefined;
    return alias;
  }

  /**
   * Validate that a bound alias still resolves in the provider registry.
   * Returns the binding when valid; falls back to the parent's current model
   * when the alias is unconfigured (or no provider is available) so a stale
   * `/model diy` binding cannot send the subagent into a hung LLM call.
   * `binding === undefined` (follow-main) is the common path and skips the
   * probe entirely.
   */
  private resolveValidModelAlias(parent: Agent, binding: string | undefined): string | undefined {
    if (binding === undefined) return parent.config.modelAlias;
    if (parent.modelProvider === undefined) return parent.config.modelAlias;
    try {
      parent.modelProvider.resolveProviderConfig(binding);
      return binding;
    } catch (error) {
      this.session.log?.warn(
        `subagent binding "${binding}" no longer resolves in the provider registry; falling back to parent model "${parent.config.modelAlias}"`,
        error,
      );
      return parent.config.modelAlias;
    }
  }

  /**
   * When a profile binds to a different model, the parent's thinkingLevel may
   * not be supported (e.g. Claude parent with `thinking=high` spawning a GPT
   * subagent). Probe the bound model's capability and force `off` when it
   * lacks thinking support. Falls back to the parent level when the probe
   * fails (unconfigured model, no provider) so spawn still succeeds.
   */
  private resolveThinkingLevel(
    parent: Agent,
    binding: string | undefined,
    parentLevel: string,
  ): string {
    if (binding === undefined || parent.modelProvider === undefined) return parentLevel;
    try {
      const capabilities = parent.modelProvider.resolveProviderConfig(binding).modelCapabilities;
      return capabilities.thinking ? parentLevel : 'off';
    } catch {
      return parentLevel;
    }
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  /**
   * Fire the SubagentStop hook for a child run that has reached a terminal
   * state. Called on the success path and from the failure/cancel handler, so
   * the event means "this child run ended", never just "it succeeded"; a failed
   * run adds the `error` field (and `response` still carries whatever the child
   * had produced) while a successful one keeps the original payload shape.
   */
  private triggerSubagentStop(
    parent: Agent,
    profileName: string,
    result: string,
    error?: string,
  ): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
        ...(error !== undefined ? { error: error.slice(0, HOOK_TEXT_PREVIEW_LENGTH) } : {}),
      },
    });
  }
}

/**
 * How much of each child's cumulative usage has already been folded into its
 * owner's session totals, keyed by the child's stable agent id. Session-scoped
 * and module-level: an Agent-instance key cannot survive the resume path
 * (`ensureAgent` re-hydrates a new instance whose replayed recorder holds the
 * full history, which was then folded a second time), and a host-level map
 * cannot survive an owner being re-instantiated, which would reopen the same
 * hole one level down.
 */
const foldedChildUsageBySession = new WeakMap<object, Map<string, Record<string, TokenUsage>>>();

function foldedChildUsageFor(session: object): Map<string, Record<string, TokenUsage>> {
  let ledger = foldedChildUsageBySession.get(session);
  if (ledger === undefined) {
    ledger = new Map();
    foldedChildUsageBySession.set(session, ledger);
  }
  return ledger;
}

/**
 * The `spawns` whitelist of the given agent's own profile — the same source of
 * truth the Agent tool derives its `allowedSpawns` from (agent/tool/index.ts:
 * `DEFAULT_AGENT_PROFILES[agent.config.profileName ?? 'agent']?.spawns`).
 * Named here because the resume path must enforce the identical rule from
 * inside the host: the Agent tool resolves a resumed child's profile through
 * `getProfileName`, which historically could not see an evicted child and so
 * skipped the check entirely.
 */
function spawnWhitelistFor(agent: Agent): readonly string[] | undefined {
  return DEFAULT_AGENT_PROFILES[agent.config.profileName ?? 'agent']?.spawns;
}

/** Element-wise subtraction clamped at zero (usage can never go negative). */
function subtractUsage(current: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    inputOther: Math.max(0, current.inputOther - previous.inputOther),
    output: Math.max(0, current.output - previous.output),
    inputCacheRead: Math.max(0, current.inputCacheRead - previous.inputCacheRead),
    inputCacheCreation: Math.max(0, current.inputCacheCreation - previous.inputCacheCreation),
  };
}

function isZeroUsage(usage: TokenUsage): boolean {
  return (
    usage.inputOther === 0 &&
    usage.output === 0 &&
    usage.inputCacheRead === 0 &&
    usage.inputCacheCreation === 0
  );
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  throwIfSubagentStoppedAtMaxTokens(completion.stopReason);
}

function throwIfSubagentStoppedAtMaxTokens(stopReason: LoopTurnStopReason | undefined): void {
  if (stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

/** Count assistant tool calls across the child's full history. */
function countAssistantToolCalls(agent: Agent): number {
  let count = 0;
  for (const message of agent.context.history) {
    if (message.role !== 'assistant') continue;
    count += message.toolCalls?.length ?? 0;
  }
  return count;
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}
