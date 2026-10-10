/**
 * AgentTool — collaboration tool for spawning task subagents.
 *
 * Unlike the built-in tools (Read/Write/Edit/Bash/Grep/Glob), this is a
 * "collaboration tool". It uses `SessionSubagentHost` (injected via the
 * constructor rather than through the Runtime) to create in-process subagent
 * loop instances.
 *
 * Two modes:
 *   - **Foreground** (default): blocks the parent turn, `await handle.completion`
 *   - **Background**: returns the agent id immediately; the result is delivered
 *     via a notification.
 *
 * `ToolResult.content` is textual; the structured output exposed by
 * `AgentToolOutputSchema` is only used for drift-guard and is not consumed at
 * runtime.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import { ToolAccesses } from '../../../loop/tool-access';
import { isAbortError } from '../../../loop/errors';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { ResolvedAgentProfile } from '../../../profile';
import type {
  SessionSubagentHost,
  SubagentCompletion,
  SubagentHandle,
} from '../../../session/subagent-host';
import {
  isUserCancellation,
  linkAbortSignal,
} from '../../../utils/abort';
import type { BackgroundProcessManager } from '../../background/manager';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md';
import AGENT_DESCRIPTION_BASE from './agent.md';

// ── AgentTool input ──────────────────────────────────────────────────

export const AgentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasSubagentType =
      typeof normalized['subagent_type'] === 'string' && normalized['subagent_type'].length > 0;
    if (!hasSubagentType && !hasResumeId) {
      normalized['subagent_type'] = 'coder';
    } else if (!hasSubagentType) {
      delete normalized['subagent_type'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    subagent_type: z
      .string()
      .optional()
      .describe(
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
      ),
    resume: z
      .string()
      .optional()
      .describe('Optional agent ID to resume instead of creating a new instance'),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Foreground is the default. Consider background for long or complex work, for running several subagents in parallel, or when the task may need your input or steering while it runs (see the background notes in this tool description). You hold the full context of the work, so you decide whether foreground or background fits the task.',
      ),
    timeout: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe(
        'Timeout in seconds for a foreground agent task (min 30s, max 3600s / 1hr). When omitted, a foreground task runs until completion with no timeout. On timeout the still-running subagent is NOT aborted — it is handed to the background task manager and keeps running (status: backgrounded): its completion notification arrives automatically in a later turn, and you can peek with TaskOutput / stop it with TaskStop. Use a timeout to bound your waiting, not to kill the subagent.',
      ),
    // Optional structured fields. When provided, they are composed into the
    // required Target / Change / Acceptance format before being sent to the
    // subagent. The explicit fields help the parent agent not forget them.
    target: z
      .string()
      .optional()
      .describe('Exact files, symbols, or directories the subagent should touch.'),
    change: z
      .string()
      .optional()
      .describe('Step-by-step what the subagent should add, remove, or modify.'),
    acceptance: z
      .string()
      .optional()
      .describe('Observable result that proves completion, including any verification command.'),
    output_schema: z
      .string()
      .optional()
      .describe(
        'Optional JSON Schema (as a JSON string) describing the structured result the subagent should return. When provided, the subagent is told to reply with a single JSON object conforming to this schema; if the reply parses as JSON it is surfaced as a `[structured]` block in the tool output, alongside the raw text.',
      ),
    output_token_hint: z
      .number()
      .int()
      .min(1)
      .max(32_768)
      .optional()
      .describe(
        'Optional prompt-level hint for the subagent final-answer length (keeps structured replies compact, e.g. 1024 for a schema-shaped answer). Not an enforced cap.',
      ),
    capability_mode: z
      .enum(['read-only', 'read-write', 'execute', 'all'])
      .optional()
      .describe(
        'Runtime capability contract for the subagent. read-only: may inspect but not modify the workspace. read-write: may read and edit files but not run arbitrary commands. execute: may additionally run commands. all: full tool access (default). Restricted modes strip the child tool set at runtime (including MCP and spawning tools) — the constraint is enforced, not just prompted. The parent remains the final gate. On resume the contract can only tighten: a resumed agent keeps the tool set it already has, so a mode wider than the one it was spawned with is ignored — spawn a fresh subagent for a wider contract.',
      ),
  }),
);

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

// ── AgentTool output ─────────────────────────────────────────────────

export const AgentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export type AgentToolOutput = z.infer<typeof AgentToolOutputSchema>;

const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';

/**
 * Hard ceiling on nested Agent-tool spawning, counted in spawn hops from the
 * root agent (root = 0, each spawned subagent = spawner + 1). It exists to
 * bound delegation cycles (A→B→A through custom profiles): it caps the CHAIN,
 * never sibling fan-out — parallel children at the same depth are unaffected.
 *
 * 3 is chosen against the shipped profile graph: the deepest whitelisted chain
 * is 2 hops (main → plan/oracle/designer/reviewer → explore, and `explore`
 * spawns nothing), so the cap admits every default chain plus one level of
 * headroom for user-authored profiles while a cycle stops after three
 * generations instead of running forever.
 */
export const MAX_AGENT_SPAWN_DEPTH = 3;

/**
 * Refusal text for the nesting-depth gate. Shared by every spawn surface
 * (the Agent tool and WolfPack) so both refuse at the same cap with the same
 * wording — a cap the model can walk around through another spawn tool is no
 * cap at all.
 */
export function spawnDepthLimitRefusal(depth: number): string {
  return (
    `Depth limit reached: this agent is already ${String(depth)} spawn hops from the root agent, and the nesting depth cap is ${String(MAX_AGENT_SPAWN_DEPTH)}. ` +
    'Spawning another subagent here would keep (or loop) the delegation chain instead of finishing the work. ' +
    'Do the task in this agent; if you are blocked, report back to your parent with ContactParent.'
  );
}

// ── AgentTool class ──────────────────────────────────────────────────

export class AgentTool implements BuiltinTool<AgentToolInput> {
  readonly name: string = 'Agent';
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentToolInputSchema);
  private readonly allowBackground: boolean;

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly backgroundManager?: BackgroundProcessManager | undefined,
    subagents?: ResolvedAgentProfile['subagents'] | undefined,
    options?: {
      allowBackground?: boolean;
      log?: Logger;
      allowedSpawns?: string[];
      /** How many spawn hops the calling agent already sits from the root
       *  (root = 0). Consulted by the anti-cycle nesting gate. */
      spawnDepth?: () => number;
    },
  ) {
    this.allowBackground = options?.allowBackground ?? this.backgroundManager !== undefined;
    const log = options?.log;
    const visibleSubagents = filterSubagentsBySpawns(subagents, options?.allowedSpawns);
    const typeLines = buildSubagentDescriptions(visibleSubagents);
    const baseDescription = `${AGENT_DESCRIPTION_BASE}\n\n${
      this.allowBackground ? AGENT_BACKGROUND_DESCRIPTION : AGENT_BACKGROUND_DISABLED_DESCRIPTION
    }`;
    this.description = typeLines
      ? `${baseDescription}\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`
      : baseDescription;
    this.log = log;
    this.allowedSpawns = options?.allowedSpawns;
    // Defaults to the root depth: a caller that does not report its depth is
    // treated as sitting at the top of the chain (partial hosts keep the
    // pre-gate behavior).
    this.spawnDepth = options?.spawnDepth ?? (() => 0);
  }

  private checkSpawnAllowed(profileName: string): ExecutableToolResult | undefined {
    if (this.allowedSpawns !== undefined && !this.allowedSpawns.includes(profileName)) {
      return {
        output: `Cannot spawn "${profileName}". Allowed subagents: ${this.allowedSpawns.join(', ')}.`,
        isError: true,
      };
    }
    return undefined;
  }

  private readonly log?: Logger;
  private readonly allowedSpawns?: string[];
  /** Reads the calling agent's spawn depth for the nesting gate. */
  private readonly spawnDepth: () => number;

  resolveExecution(args: AgentToolInput): ToolExecution {
    let profileName = args.subagent_type?.length ? args.subagent_type : 'coder';
    const resumeAgentId = args.resume?.trim();
    if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
      profileName = this.subagentHost.getProfileName?.(resumeAgentId) ?? 'subagent';
    }
    const prefix = args.run_in_background === true ? 'Launching background' : 'Launching';
    return {
      description: `${prefix} ${profileName} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileName,
        prompt: composeSubagentPrompt(args),
        background: args.run_in_background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileName),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentToolInput,
    {
    toolCallId,
    signal,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      const runInBackground = args.run_in_background === true;
      const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
      const resumeAgentId = args.resume?.trim();
      if (
        resumeAgentId !== undefined &&
        resumeAgentId.length > 0 &&
        requestedProfileName !== undefined
      ) {
        return {
          output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
          isError: true,
        };
      }

      const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;
      // Anti-cycle depth gate: a spawn chain (including an A→B→A loop through
      // custom profiles) may not grow past MAX_AGENT_SPAWN_DEPTH hops from the
      // root. Resume is exempt — it continues an existing agent and adds no
      // depth. This bounds the chain, not parallelism: sibling spawns at the
      // same depth are untouched.
      if (!isResume) {
        const depth = this.spawnDepth();
        if (depth >= MAX_AGENT_SPAWN_DEPTH) {
          return { output: spawnDepthLimitRefusal(depth), isError: true };
        }
      }

      const effectiveProfileName = resumeAgentId !== undefined && resumeAgentId.length > 0
        ? this.subagentHost.getProfileName?.(resumeAgentId)
        : requestedProfileName ?? 'coder';
      if (effectiveProfileName !== undefined) {
        const denied = this.checkSpawnAllowed(effectiveProfileName);
        if (denied !== undefined) return denied;
      }

      let reservation: ReturnType<BackgroundProcessManager['reserveSlot']> | undefined;
      let backgroundManager: BackgroundProcessManager | undefined;
      if (runInBackground) {
        const configuredBackgroundManager = this.backgroundManager;
        if (!this.allowBackground || configuredBackgroundManager === undefined) {
          return {
            output: BACKGROUND_AGENT_UNAVAILABLE,
            isError: true,
          };
        }
        try {
          reservation = configuredBackgroundManager.reserveSlot();
          backgroundManager = configuredBackgroundManager;
        } catch (error) {
          return {
            output: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      }
      const backgroundController = runInBackground ? new AbortController() : undefined;
      const timeoutMs = args.timeout === undefined ? undefined : args.timeout * 1000;
      // Foreground child signal: user cancellation propagates through
      // linkAbortSignal, but an explicit timeout only bounds this turn's wait —
      // when it fires the still-running child is handed to the background task
      // manager instead of being aborted, so completed work is never discarded.
      const childController = new AbortController();
      const unlinkChild = !runInBackground ? linkAbortSignal(signal, childController) : undefined;

      const options = {
        parentToolCallId: toolCallId,
        prompt: composeSubagentPrompt(args),
        description: args.description,
        runInBackground,
        signal: backgroundController?.signal ?? childController.signal,
        outputSchema: args.output_schema,
        capabilityMode: args.capability_mode,
      };

      let handle: SubagentHandle;
      const operation = resumeAgentId !== undefined && resumeAgentId.length > 0 ? 'resume' : 'spawn';
      try {
        if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
          handle = await this.subagentHost.resume(resumeAgentId, options);
        } else {
          const profileName = requestedProfileName ?? 'coder';
          handle = await this.subagentHost.spawn(profileName, options);
        }
      } catch (error) {
        reservation?.release();
        this.log?.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation,
          agentId: resumeAgentId,
          subagentType: operation === 'spawn' ? requestedProfileName ?? 'coder' : undefined,
          error,
        });
        throw error;
      }

      if (runInBackground) {
        if (backgroundManager === undefined) {
          reservation?.release();
          return {
            output: BACKGROUND_AGENT_UNAVAILABLE,
            isError: true,
          };
        }
        let taskId: string;
        try {
          taskId = backgroundManager.registerAgentTask(handle.completion, args.description, {
            timeoutMs: timeoutMs ?? this.subagentHost.backgroundTaskTimeoutMs,
            reservation,
            agentId: handle.agentId,
            subagentType: handle.profileName,
            abort: () => {
              backgroundController?.abort();
            },
          });
        } catch (error) {
          reservation?.release();
          backgroundController?.abort();
          void handle.completion.catch(() => {});
          this.log?.warn('background agent task registration failed', {
            toolCallId,
            agentId: handle.agentId,
            subagentType: handle.profileName,
            error,
          });
          return {
            output: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
        const lines = [
          `task_id: ${taskId}`,
          'status: running',
          `agent_id: ${handle.agentId}`,
          `actual_subagent_type: ${handle.profileName}`,
          'automatic_notification: true',
          'cancel_semantics: Stopping this task (TaskStop) cancels it — its completion notification will not suggest resume. Only tasks that finish or fail on their own are recoverable via Agent(resume=...).',
          '',
          `description: ${args.description}`,
          '',
          `next_step: The completion arrives automatically in a later turn — no polling needed. To peek at progress without blocking, call TaskOutput(task_id="${taskId}", block=false).`,
          `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
        ];
        return { output: lines.join('\n') };
      }

      // Foreground wait. With an explicit timeout the wait is bounded by a race:
      // on timeout the still-running child is handed to the background task
      // manager instead of being aborted. Without a timeout (or when background
      // dispatch is unavailable) we await completion directly.
      try {
        const outcome = await this.awaitForegroundCompletion(
          handle,
          args.description,
          timeoutMs,
          childController,
          unlinkChild,
        );
        if (outcome.kind === 'backgrounded') {
          return { output: outcome.output };
        }
        return { output: this.formatCompletion(handle, outcome.result, args.output_schema) };
      } catch (error) {
        let message: string;
        if (isUserCancellation(signal.reason)) {
          message =
            'The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user\'s next instruction.';
        } else if (isAbortError(error)) {
          message = 'The subagent was stopped before it finished.';
        } else {
          message = error instanceof Error ? error.message : String(error);
        }
        const lines = [
          `agent_id: ${handle.agentId}`,
          `actual_subagent_type: ${handle.profileName}`,
          'status: failed',
          '',
          `subagent error: ${message}`,
        ];
        return { output: lines.join('\n'), isError: true };
      }
    } catch (error) {
      let message: string;
      if (isUserCancellation(signal.reason)) {
        message =
          'The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user\'s next instruction.';
      } else if (isAbortError(error)) {
        message = 'The subagent was stopped before it finished.';
      } else {
        message = error instanceof Error ? error.message : String(error);
      }
      return { output: `subagent error: ${message}`, isError: true };
    }
  }

  /**
   * Foreground completion wait.
   *
   * When background dispatch is available the wait races three legs: the
   * child's completion (always), a collaboration request from the child
   * (always), and the deadline (only when `timeoutMs` is set). Either bounded
   * outcome hands the still-running child to the background task manager —
   * never aborts it — and returns a `backgrounded` outcome carrying the task
   * id:
   *
   * - A request means the parent is needed mid-run: the parent is parked
   *   inside this tool call, so the `child_request` notification would sit in
   *   the steer buffer until the child finishes. Backgrounding lets the parent
   *   read the request at its next step boundary and answer the still-running
   *   child through `SendSubagentMessage`.
   * - A timeout degrades the wait; it does not destroy the subagent's work.
   *
   * Without background dispatch (`!allowBackground` or no manager) the wait
   * degrades to awaiting completion directly.
   *
   * A child whose controller is already aborted (the user cancelled the parent
   * turn while the child was parked in a signal-ignoring tool such as
   * `ContactParent`) is never handed over: both bounded legs fall back to the
   * completion leg so the cancellation is reported instead of resurrected as a
   * background task.
   */
  private async awaitForegroundCompletion(
    handle: SubagentHandle,
    description: string,
    timeoutMs: number | undefined,
    childController: AbortController,
    unlinkChild: (() => void) | undefined,
  ): Promise<
    | { kind: 'completed'; result: SubagentCompletion }
    | { kind: 'backgrounded'; output: string }
  > {
    const backgroundManager = this.backgroundManager;
    if (!this.allowBackground || backgroundManager === undefined) {
      return { kind: 'completed', result: await handle.completion };
    }

    // The request leg is what keeps a blocked parent responsive: without it
    // the child's request is only flushed after the child finishes. Hosts that
    // predate the API (partial test doubles) skip the leg and keep the
    // completion/timeout behavior unchanged.
    const childRequestArrival = this.subagentHost.waitForChildRequest?.(handle.agentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Leg order is the tie-break: `Promise.race` settles with the first leg
      // that is already settled when the handlers attach, so a completion
      // landing together with a request (or the deadline) wins. That is the
      // accepted trade-off — a finished child has nothing left to background.
      const legs: Promise<
        | { kind: 'completed'; result: SubagentCompletion }
        | { kind: 'request' }
        | { kind: 'timeout'; timeoutMs: number }
      >[] = [handle.completion.then((result) => ({ kind: 'completed' as const, result }))];
      if (childRequestArrival !== undefined) {
        legs.push(childRequestArrival.then(() => ({ kind: 'request' as const })));
      }
      // Without `timeoutMs` the foreground wait is intentionally unbounded —
      // only the background path carries a deadline.
      if (timeoutMs !== undefined) {
        const bound = timeoutMs;
        legs.push(
          new Promise<{ kind: 'timeout'; timeoutMs: number }>((resolve) => {
            timer = setTimeout(() => {
              resolve({ kind: 'timeout', timeoutMs: bound });
            }, bound);
          }),
        );
      }
      const outcome = await Promise.race(legs);
      if (outcome.kind === 'completed') return outcome;
      // A cancellation that landed while one of the bounded legs fired must
      // keep cancellation semantics: `ContactParent` does not observe the
      // abort signal, so a request can still arrive after the user cancelled
      // the parent turn (`linkAbortSignal` above pushes `ctx.signal`'s
      // cancellation into `childController`), and a deadline can fire inside
      // the same window. Backgrounding that child would resurrect a
      // deliberately cancelled run as a "recoverable" task: its completion
      // rejects with the cancellation, the manager classifies it `failed`,
      // and the notification offers the `Agent(resume=...)` hint that the
      // killed/cancelled path deliberately withholds. Fall back to the
      // completion leg instead — it settles with the child's abort reason, so
      // the caller reports the same deliberate-interruption wording as any
      // other cancelled foreground child.
      if (childController.signal.aborted) {
        return { kind: 'completed', result: await handle.completion };
      }
      if (outcome.kind === 'request') {
        return this.handoffChildToBackground(
          backgroundManager,
          handle,
          description,
          { kind: 'request' },
          childController,
          unlinkChild,
        );
      }
      return this.handoffChildToBackground(
        backgroundManager,
        handle,
        description,
        { kind: 'timeout', timeoutMs: outcome.timeoutMs },
        childController,
        unlinkChild,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.subagentHost.releaseChildRequestWait?.(handle.agentId);
    }
  }

  /**
   * Hand a still-running foreground child to the background task manager.
   *
   * Shared by both bounded-wait outcomes: the timeout path keeps its exact
   * wording, the request path reports why the parent got the task (the child
   * asked something; the parent answers it at its next step). Registration
   * failure keeps the parent→child link intact — the child is neither orphaned
   * nor aborted — and only a successful handoff decouples it from the parent
   * signal and flips it to the background lifecycle.
   */
  private handoffChildToBackground(
    backgroundManager: BackgroundProcessManager,
    handle: SubagentHandle,
    description: string,
    reason: { kind: 'timeout'; timeoutMs: number } | { kind: 'request' },
    childController: AbortController,
    unlinkChild: (() => void) | undefined,
  ): { kind: 'backgrounded'; output: string } {
    // Backstop for the invariant `awaitForegroundCompletion` pre-checks: a
    // cancelled child is never registered as a background task. Rethrowing the
    // signal's reason (via `throwIfAborted`) keeps the caller's cancellation
    // wording (a user cancellation surfaces as the deliberate-interruption
    // message) instead of fabricating a backgrounded result for a dead run.
    childController.signal.throwIfAborted();
    // The child is still running on childController.signal: register it as a
    // background task; a later user stop aborts it through the abort callback.
    let taskId: string;
    try {
      taskId = backgroundManager.registerAgentTask(handle.completion, description, {
        agentId: handle.agentId,
        subagentType: handle.profileName,
        abort: () => {
          childController.abort();
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log?.warn('foreground→background handoff failed; child kept running', {
        agentId: handle.agentId,
        error,
      });
      // Registration failed: keep the parent→child link so the parent signal
      // can still stop the child; do not orphan it.
      const warning =
        reason.kind === 'timeout'
          ? `warning: timed out after ${reason.timeoutMs}ms and could not register a background task: ${message}`
          : `warning: the subagent requested input and could not register a background task: ${message}`;
      const tail =
        reason.kind === 'timeout'
          ? `resume_hint: The subagent is still running. To pick it up, call Agent(resume="${handle.agentId}", prompt="...").`
          : [
              'next_step: The subagent is still running and its request is already queued for you — it reaches you at your next step boundary, and SendSubagentMessage can steer the child.',
              `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="...").`,
            ].join('\n');
      return {
        kind: 'backgrounded',
        output: [
          `agent_id: ${handle.agentId}`,
          `actual_subagent_type: ${handle.profileName}`,
          'status: backgrounded',
          '',
          warning,
          '',
          tail,
        ].join('\n'),
      };
    }
    // Handoff succeeded: decouple the child from the parent signal so a later
    // parent cancellation cannot kill the backgrounded task — only an explicit
    // TaskStop of the background task aborts it from now on.
    unlinkChild?.();
    // Flip the child's lifecycle flag so cancelAll (parent-turn cancellation)
    // skips it as well — otherwise a later user interruption would still
    // abort the backgrounded child and mis-report it as "failed" instead of
    // "cancelled".
    this.subagentHost.markBackground?.(handle.agentId);
    const nextStep =
      reason.kind === 'timeout'
        ? `next_step: The subagent exceeded the foreground timeout (${reason.timeoutMs}ms) and was moved to the background instead of being aborted. Its completion arrives automatically in a later turn — no polling needed. To peek at progress without blocking, call TaskOutput(task_id="${taskId}", block=false).`
        : `next_step: The subagent raised a request and was moved to the background so you can answer it in real time. The request text arrives with the subagent message at your next step boundary. Reply with SendSubagentMessage — the subagent keeps running and a steer lands inside its live turn (operation "interject" if it must be read immediately, e.g. it is stuck in a long tool call). Its completion arrives automatically in a later turn; to wait for it without polling, call TaskOutput(task_id="${taskId}", block=true).`;
    return {
      kind: 'backgrounded',
      output: [
        `task_id: ${taskId}`,
        'status: backgrounded',
        `agent_id: ${handle.agentId}`,
        `actual_subagent_type: ${handle.profileName}`,
        'automatic_notification: true',
        'cancel_semantics: Stopping this task (TaskStop) cancels it — its completion notification will not suggest resume. Only tasks that finish or fail on their own are recoverable via Agent(resume=...).',
        '',
        `description: ${description}`,
        '',
        nextStep,
        `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>.`,
      ].join('\n'),
    };
  }

  /** Render the completed-subagent result text (summary + optional structured block). */
  private formatCompletion(
    handle: SubagentHandle,
    result: SubagentCompletion,
    outputSchema: string | undefined,
  ): string {
    const lines = [
      `agent_id: ${handle.agentId}`,
      `actual_subagent_type: ${handle.profileName}`,
      'status: completed',
      '',
      '[summary]',
      result.result,
    ];
    // Structured output: when a schema was requested, try to parse the final
    // answer as JSON and surface it as its own block. Parse failure is
    // non-fatal — the raw text stays in [summary].
    if (outputSchema !== undefined) {
      const structured = parseJsonObject(result.result);
      if (structured !== undefined) {
        lines.push('', '[structured]', JSON.stringify(structured));
      }
    }
    return lines.join('\n');
  }
}


function composeSubagentPrompt(args: AgentToolInput): string {
  const hasStructure =
    args.target !== undefined || args.change !== undefined || args.acceptance !== undefined;
  const parts: string[] = [args.prompt];
  if (hasStructure) {
    parts.push('');
    if (args.target !== undefined) parts.push('# Target', args.target, '');
    if (args.change !== undefined) parts.push('# Change', args.change, '');
    if (args.acceptance !== undefined) parts.push('# Acceptance', args.acceptance, '');
  }
  if (args.output_schema !== undefined) {
    const budgetLine =
      args.output_token_hint !== undefined
        ? ` Keep your final answer within ${args.output_token_hint} tokens.`
        : '';
    parts.push(
      '',
      '# Structured Output',
      `Reply with a single JSON object conforming to this JSON Schema:`,
      '```json',
      args.output_schema,
      '```',
      'No prose before or after the JSON object.' + budgetLine,
    );
  }
  if (args.capability_mode !== undefined && args.capability_mode !== 'all') {
    const capabilityLines: Record<string, string> = {
      'read-only': 'You are read-only: you may inspect files and the workspace, but you must NOT modify, create, or delete anything, and must NOT execute commands.',
      'read-write':
        'You may read and edit files, but you must NOT execute commands (including running tests, builds, or terminal commands).',
      execute:
        'You may read and edit files and execute commands, but you must not perform actions with irreversible external side effects (publishing, deploying, pushing) without explicit approval from the parent agent.',
    };
    parts.push('', '# Capability Constraint', capabilityLines[args.capability_mode] ?? '');
  }
  return parts.join('\n');
}

/**
 * Best-effort JSON extraction: strips a ```json fence if present, then tries
 * to parse. Returns undefined when the text is not parseable as a single JSON
 * object — callers treat that as "structured output unavailable".
 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : text.trim();
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function buildSubagentDescriptions(subagents: ResolvedAgentProfile['subagents']): string {
  if (subagents === undefined) return '';
  return Object.entries(subagents)
    .map(([name, subagent]) => {
      const details = [subagent.description, subagent.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${name}` : `- ${name}: ${details.join(' ')}`;
      if (subagent.tools.length === 0) return header;
      return `${header}\n  Tools: ${subagent.tools.join(', ')}`;
    })
    .join('\n');
}

function filterSubagentsBySpawns(
  subagents: ResolvedAgentProfile['subagents'] | undefined,
  allowedSpawns: string[] | undefined,
): ResolvedAgentProfile['subagents'] | undefined {
  if (allowedSpawns === undefined || subagents === undefined) return subagents;
  return Object.fromEntries(
    Object.entries(subagents).filter(([name]) => allowedSpawns.includes(name)),
  );
}
