import {
  APIContextOverflowError,
  grandTotal as ltodGrandTotal,
  type ContentPart,
} from '@scream-code/ltod';

import type { Agent } from '..';
import {
  ErrorCodes,
  type ScreamErrorPayload,
  isScreamError,
  makeErrorPayload,
  toScreamErrorPayload,
} from '#/errors';
import { isAbortError, isMaxStepsExceededError } from '../../loop/errors';
import {
  createLoopEventDispatcher,
  runTurn,
  type ExecutableToolResult,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent } from '../../rpc';
import { abortable, userCancellationReason } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin, type ContextMessage } from '../context';
import { renderUserPromptHookBlockResult, renderUserPromptHookResult } from '../../session/hooks';
import { looksLikeVerificationCommand } from '../working-set';
import { ToolCallDeduplicator } from './tool-dedup';

interface ActiveTurn {
  controller: AbortController;
  promise: Promise<TurnEndResult>;
}

interface BufferedSteer {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TurnEndResult {
  readonly event: TurnEndedEvent;
  readonly stopReason?: LoopTurnStopReason;
}

export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';

const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far. Goal mode is iterative: do one coherent slice of work, then',
  'reassess. Call UpdateGoal with `complete` only when all required work is done, any stated',
  'validation has passed, and there is no useful next action. Do not mark complete after only',
  'producing a plan, summary, first pass, or partial result. If an external condition or required',
  'user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal',
  'with `blocked`. Otherwise keep going — use the existing conversation context and your tools,',
  'and do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private currentTurnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  private readonly currentStepByTurn = new Map<number, number>();
  private currentStep = 0;
  private todoSeenThisTurn = false;
  private convergenceInjections = 0;
  private currentStepHadContent = false;
  private lastToolFailure: { toolName: string; isExploratory: boolean } | null = null;
  private readonly MAX_CONVERGENCE_INJECTIONS = 5;
  private summaryGuardInjected = false;
  private turnStartWorkingSetPathCount = 0;
  private turnStartVerificationCount = 0;
  private verificationFailureInjected = false;
  private readonly MIN_FINAL_RESPONSE_LENGTH = 60;

  constructor(protected readonly agent: Agent) {}

  // Returns the new turnId, or null if the turn was marked as resuming.
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input,
      origin,
    });
    return this.launch(input, origin);
  }

  // Returns the new turnId, or null if the input was buffered as a steer
  // message or the turn was marked as resuming.
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.steer',
      input,
      origin,
    });
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return null;
    }
    return this.launch(input, origin);
  }

  private launch(input: readonly ContentPart[], origin: PromptOrigin): number | null {
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: 'error',
        ...makeErrorPayload(
          'turn.agent_busy',
          `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
          { details: { turnId: this.turnId } },
        ),
      });
      return null;
    }

    // Initialize dream tracker and record new session on first turn
    if (this.turnId === -1) {
      void this.agent.dreamTracker
        .init()
        .then(() => this.agent.dreamTracker.recordNewSession())
        .catch(() => {
          // Dream tracking is best-effort — a filesystem hiccup must not
          // surface as an unhandled rejection on the first turn.
        });
    }

    // Per-turn setup (usage window, `turn.started`, appending the prompt)
    // lives in `runOneTurn`, so a goal-driven run emits a clean start/end
    // pair per continuation turn rather than one mega-turn.
    const turnId = this.allocateTurnId();
    const controller = new AbortController();
    const promise = this.turnWorker(turnId, input, origin, controller.signal);
    this.activeTurn = { controller, promise };
    return turnId;
  }

  restorePrompt(): void {
    if (this.activeTurn) {
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  restoreSteer(input: readonly ContentPart[], origin: PromptOrigin): void {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  cancel(turnId?: number, reason?: unknown): void {
    this.agent.records.logRecord({ type: 'turn.cancel', turnId });
    if (turnId !== undefined && turnId !== this.currentId) {
      return;
    }
    const cancelReason = reason ?? userCancellationReason();
    // Close the cancelled turn's usage window — runOneTurn's cleanup path
    // may not reach it if a new prompt() advanced currentId before the old
    // turnWorker's microtask resumed.
    this.agent.usage.endTurn();
    this.abortTurn(cancelReason);
    this.agent.subagentHost?.cancelAll(cancelReason);
  }

  get currentId() {
    return this.turnId;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && this.activeTurn !== 'resuming';
  }

  waitForCurrentTurn(signal?: AbortSignal | undefined): Promise<TurnEndResult> {
    const active = this.activeTurn;
    if (active === null || active === 'resuming') {
      return Promise.reject(new Error('No active turn'));
    }
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;

    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    return abortable(active.promise, signal).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  private abortTurn(reason: unknown) {
    if (this.activeTurn !== 'resuming') {
      // The reason (a user cancellation by default, or the originating signal's
      // reason when propagated) travels as signal.reason so tools settling on
      // this signal can report a deliberate user interruption distinctly from a
      // timeout/system abort. linkAbortSignal forwards it to linked subagents.
      this.activeTurn?.controller.abort(reason);
    }
    this.activeTurn = null;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      this.agent.context.appendUserMessage(steer.input, steer.origin);
    }
    steers.length = 0;
    return true;
  }

  finishResume(): void {
    if (this.activeTurn === 'resuming') {
      this.activeTurn = null;
    }
    this.steerBuffer.length = 0;
  }

  private async turnWorker(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const ownsActiveTurn = (): boolean =>
      this.activeTurn !== null &&
      this.activeTurn !== 'resuming' &&
      this.activeTurn.controller.signal === signal;
    try {
      const initialGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (initialGoalStatus === 'active') {
        return await this.driveGoal(turnId, input, origin, signal);
      }
      const end = await this.runOneTurn(turnId, input, origin, signal, true);
      const resumedFromPausedOrBlocked =
        initialGoalStatus === 'paused' || initialGoalStatus === 'blocked';
      const currentGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (
        resumedFromPausedOrBlocked &&
        currentGoalStatus === 'active' &&
        end.event.reason !== 'cancelled' &&
        end.event.reason !== 'failed'
      ) {
        return await this.driveGoal(
          this.allocateTurnId(),
          [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }],
          GOAL_CONTINUATION_ORIGIN,
          signal,
        );
      }
      return end;
    } finally {
      if (ownsActiveTurn()) {
        this.activeTurn = null;
      }
    }
  }

  /**
   * Drives an active goal as a sequence of ordinary turns. Each iteration runs
   * one full turn, then reads the goal status the model set via UpdateGoal.
   */
  private async driveGoal(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const DEFAULT_MAX_GOAL_TURNS = 50;
    const configuredMaxGoalTurns = this.agent.screamConfig?.loopControl?.maxGoalTurns;
    const effectiveMaxGoalTurns = configuredMaxGoalTurns ?? DEFAULT_MAX_GOAL_TURNS;

    let turnId = firstTurnId;
    let turnInput = input;
    let turnOrigin = origin;
    while (true) {
      const goalBeforeTurn = this.agent.goal.getGoal().goal;
      if (goalBeforeTurn?.status === 'active') {
        // Hard convergence guard: if the model has not set its own turn budget
        // and has consumed the default allowance, block the goal so it cannot
        // spin forever and burn tokens.
        if (
          effectiveMaxGoalTurns > 0 &&
          goalBeforeTurn.budget.turnBudget === null &&
          goalBeforeTurn.turnsUsed >= effectiveMaxGoalTurns
        ) {
          await this.agent.goal.markBlocked({
            reason: `Reached the goal turn limit (${effectiveMaxGoalTurns})`,
          });
          const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
          return { event: ended };
        }

        if (goalBeforeTurn.budget.overBudget) {
          await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
          const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
          return { event: ended };
        }
      }

      await this.agent.goal.incrementTurn();
      const end = await this.runOneTurn(turnId, turnInput, turnOrigin, signal, false);

      if (end.event.reason === 'cancelled') {
        await this.agent.goal.pauseOnInterrupt({ reason: 'Paused after interruption' });
        return end;
      }
      if (end.event.reason === 'failed') {
        const reason = end.event.error?.message ?? 'Turn failed';
        await this.agent.goal.pauseActiveGoal({ reason });
        return end;
      }

      const goal = this.agent.goal.getGoal().goal;
      if (goal === null || goal.status !== 'active') {
        return end;
      }
      if (goal.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        return end;
      }

      turnId = this.allocateTurnId();
      turnInput = [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }];
      turnOrigin = GOAL_CONTINUATION_ORIGIN;
    }
  }

  private async endGoalTurnWithoutModel(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
  ): Promise<TurnEndedEvent> {
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    const ended: TurnEndedEvent = { type: 'turn.ended', turnId, reason: 'completed' };
    this.agent.usage.endTurn();
    this.agent.emitEvent(ended);
    return ended;
  }

  private allocateTurnId(): number {
    this.turnId += 1;
    return this.turnId;
  }

  /**
   * Runs exactly one logical turn end to end: per-turn bookkeeping,
   * `turn.started`, the prompt + goal reminder, the step loop, and `turn.ended`.
   * Goal-agnostic — the driver layers goal semantics on top. Never throws;
   * abnormal ends are mapped to a `cancelled`/`failed` `turn.ended` and returned.
   */
  private async runOneTurn(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    standalone: boolean,
  ): Promise<TurnEndResult> {
    this.todoSeenThisTurn = false;
    this.convergenceInjections = 0;
    this.currentStepHadContent = false;
    this.lastToolFailure = null;
    this.currentTurnId = turnId;
    this.agent.workingSet.decay(turnId);
    this.summaryGuardInjected = false;
    this.verificationFailureInjected = false;
    this.turnStartWorkingSetPathCount = this.agent.workingSet.getPaths().length;
    this.turnStartVerificationCount = this.agent.workingSet.getVerificationCount();
    this.currentStepByTurn.set(turnId, 0);
    this.currentStep = 0;
    this.agent.fullCompaction.resetForTurn();
    this.agent.injection.resetForTurn();
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);

    let ended: TurnEndedEvent;
    let completedStopReason: LoopTurnStopReason | undefined;
    let errorEvent: AgentEvent | undefined;
    try {
      const promptHookEnded = await this.applyUserPromptHook(
        turnId,
        input,
        origin,
        signal,
      );
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded;
      } else {
        const stopReason = await this.runTurn(turnId, signal);
        completedStopReason = stopReason;
        ended = {
          type: 'turn.ended',
          turnId,
          reason: stopReason === 'aborted' ? 'cancelled' : 'completed',
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'cancelled',
        };
      } else {
        const summary = summarizeTurnError(error, turnId);
        this.agent.sessionMemory.recordError(
          `${summary.name}: ${summary.message}`,
          this.currentStep,
        );
        void this.agent.hooks?.fireAndForgetTrigger('StopFailure', {
          matcherValue: summary.name,
          inputData: {
            errorType: summary.name,
            errorMessage: summary.message,
          },
        });
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'failed',
          error: summary,
        };
        errorEvent = { type: 'error', ...summary };
      }
    }
    // Emit the terminal turn.ended and (for a standalone turn) release the active
    // turn in the SAME synchronous frame, so the session is observably idle the
    // instant turn.ended fires. A goal drive keeps the active turn across its
    // continuation turns and releases it in `turnWorker` instead (`standalone`
    // is false for those).
    if (this.currentId === turnId) {
      this.agent.usage.endTurn();
    }
    this.agent.emitEvent(ended);
    if (standalone && this.currentId === turnId) {
      this.activeTurn = null;
    }
    if (errorEvent !== undefined) {
      this.agent.emitEvent(errorEvent);
    }
    this.currentStepByTurn.delete(turnId);
    return {
      event: ended,
      stopReason: completedStopReason,
    };
  }

  private async applyUserPromptHook(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndedEvent | undefined> {
    if (origin.kind !== 'user') return undefined;
    signal.throwIfAborted();
    const promptHookResults = await this.agent.hooks?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();
    const blockResult = renderUserPromptHookBlockResult(promptHookResults);
    if (blockResult !== undefined) {
      this.agent.context.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blockResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      });
      this.agent.emitEvent({
        type: 'hook.result',
        turnId,
        hookEvent: blockResult.event,
        content: blockResult.message,
        blocked: true,
      });
      return {
        type: 'turn.ended',
        turnId,
        reason: 'completed',
      };
    }

    const hookResult = renderUserPromptHookResult(promptHookResults);
    if (hookResult === undefined) return undefined;

    this.agent.context.appendUserMessage([{ type: 'text', text: hookResult.text }], {
      kind: 'hook_result',
      event: 'UserPromptSubmit',
    });
    this.agent.emitEvent({
      type: 'hook.result',
      turnId,
      hookEvent: hookResult.event,
      content: hookResult.message,
    });
    return undefined;
  }

  private async runTurn(turnId: number, signal: AbortSignal): Promise<LoopTurnStopReason> {
    let stopHookContinuationUsed = false;
    const deduper = new ToolCallDeduplicator();
    await this.agent.mcp?.waitForInitialLoad(signal);
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.screamConfig?.loopControl;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm: this.agent.llm,
          buildMessages: () => this.agent.context.messages,
          dispatchEvent: this.buildDispatchEvent(turnId),
          tools: this.agent.tools.loopTools,
          log: this.agent.log,
          maxSteps: loopControl?.maxStepsPerTurn,
          maxRetryAttempts: loopControl?.maxRetriesPerStep,
          hooks: {
            beforeStep: async ({ signal: stepSignal, stepNumber }) => {
              this.flushSteerBuffer();
              this.currentStepHadContent = false;
              await this.agent.fullCompaction.beforeStep(stepSignal);

              const goal = this.agent.goal.getGoal().goal;
              if (stepNumber === 1 && goal?.status === 'active' && !this.todoSeenThisTurn) {
                this.agent.context.appendSystemReminder(
                  'This turn is working toward an active goal. You MUST call TodoList to create or update the plan before making changes.',
                  { kind: 'system_trigger', name: 'todo_required' },
                );
              }
              if (stepNumber === 2 && !this.todoSeenThisTurn) {
                this.agent.context.appendSystemReminder(
                  'This task spans multiple steps. Use TodoList to track the remaining work and current phase.',
                  { kind: 'system_trigger', name: 'todo_suggested' },
                );
              }

              if (stepNumber === 1 || this.agent.fullCompaction.shouldInjectSessionSummary()) {
                const sessionSummary = this.agent.sessionMemory.getSessionSummary();
                if (sessionSummary.length > 0) {
                  this.agent.context.appendSystemReminder(sessionSummary, {
                    kind: 'injection',
                    variant: 'session_memory',
                  });
                }
              }

              // Suggest /dream on the first step when conditions are met
              if (stepNumber === 1 && this.agent.dreamTracker.shouldSuggest()) {
                this.agent.context.appendSystemReminder(
                  this.agent.dreamTracker.getSuggestionMessage(),
                  { kind: 'injection', variant: 'dream_suggestion' },
                );
              }

              await this.agent.injection.inject();
              deduper.beginStep();
              return;
            },
            afterStep: async ({ usage }) => {
              this.agent.usage.record(model, usage, 'turn');
              await this.agent.goal.recordTokenUsage(ltodGrandTotal(usage));
              await this.agent.fullCompaction.afterStep();
              deduper.endStep();
            },
            // oxlint-disable-next-line no-loop-func -- stop hook continuation state is scoped to this turn.
            shouldContinueAfterStop: async ({ signal }) => {
              if (this.flushSteerBuffer()) return { continue: true };
              signal.throwIfAborted();

              // Convergence gate: prevent the turn from ending on an empty step,
              // a missing TodoList update for an active goal, a blocking (non-exploratory)
              // tool failure, or a failed verification command. We no longer force
              // verification just because files were touched — the agent decides whether
              // a verification pass is appropriate based on the user's intent and the
              // system prompt guidance.
              const latestVerification = this.agent.workingSet.getLatestVerificationForTurn(this.currentTurnId);
              const hasPassedVerificationThisTurn = latestVerification?.passed === true;

              if (this.convergenceInjections < this.MAX_CONVERGENCE_INJECTIONS) {
                const reasons: string[] = [];

                if (!this.currentStepHadContent) {
                  reasons.push(
                    'The last assistant step produced no content or tool calls. Continue the task.',
                  );
                }

                const goal = this.agent.goal.getGoal().goal;
                if (goal?.status === 'active' && !this.todoSeenThisTurn) {
                  reasons.push(
                    'An active goal exists but no TodoList update was made this turn. Update TodoList and continue.',
                  );
                }
                if (this.lastToolFailure?.isExploratory === false && !hasPassedVerificationThisTurn) {
                  reasons.push(
                    `A required tool (${this.lastToolFailure.toolName}) failed this turn. ` +
                      'Analyze the error and fix it before reporting completion.',
                  );
                }
                if (latestVerification && !latestVerification.passed && !this.verificationFailureInjected) {
                  this.verificationFailureInjected = true;
                  reasons.push(
                    `The last verification command failed (${latestVerification.command}). ` +
                      'Fix the failure before re-running verification. Do NOT downgrade to runtime smoke tests.',
                  );
                }

                if (reasons.length > 0) {
                  this.convergenceInjections += 1;
                  this.agent.context.appendSystemReminder(
                    reasons.join('\n') +
                      '\n\nDo not report completion until the above is resolved.',
                    { kind: 'system_trigger', name: 'convergence_gate' },
                  );
                  return { continue: true };
                }
              }
              // Summary guard: when the turn produced actual work (file changes,
              // verification runs, etc.) but the model's final response is too
              // brief or just an empty acknowledgment, give it one chance to
              // produce a structured deliverability summary before yielding.
              if (
                !this.summaryGuardInjected &&
                this.turnHadMeaningfulWork() &&
                this.lastAssistantMessageIsTrivial()
              ) {
                this.summaryGuardInjected = true;
                this.agent.context.appendSystemReminder(
                  'Your final response is too brief or only acknowledges completion. ' +
                    'Before ending the turn, provide a concise but complete summary: ' +
                    'what was done, which files changed, the verification result, and any ' +
                    'remaining work or blockers.',
                  { kind: 'system_trigger', name: 'convergence_gate' },
                );
                return { continue: true };
              }

              // Stop hooks get one continuation; otherwise a hook that always blocks would loop forever.
              if (stopHookContinuationUsed) return { continue: false };
              const stopBlock = await this.agent.hooks?.triggerBlock('Stop', {
                signal,
                inputData: { stopHookActive: stopHookContinuationUsed },
              });
              signal.throwIfAborted();
              if (stopBlock !== undefined) {
                stopHookContinuationUsed = true;
                this.agent.context.appendUserMessage(
                  [{ type: 'text', text: stopBlock.reason }],
                  {
                    kind: 'system_trigger',
                    name: 'stop_hook',
                  },
                );
                return { continue: true };
              }
              return { continue: false };
            },
            prepareToolExecution: async (ctx) => {
              const cached = deduper.checkSameStep(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
              );
              if (cached !== null) return { syntheticResult: cached };

              // Hard-skip redundant verification commands. The WorkingSet
              // records recent successful verification runs; if the same
              // command is requested again within the dedup window and no
              // unverified file has been touched since, we return the cached
              // result instead of re-executing the shell command.
              if (
                ctx.toolCall.name === 'Bash' &&
                typeof (ctx.args as { command?: string }).command === 'string'
              ) {
                const command = (ctx.args as { command: string }).command;
                const cwd = (ctx.args as { cwd?: string }).cwd ?? this.agent.config.cwd;
                if (looksLikeVerificationCommand(command)) {
                  const candidate = this.agent.workingSet.findSkipCandidate(
                    command,
                    cwd,
                    Number(ctx.turnId),
                  );
                  if (candidate !== null) {
                    return {
                      syntheticResult: {
                        output: `${candidate.output}
[system: verification skipped — identical successful run within the last ${Math.round(
                          (Date.now() - candidate.timestamp) / 1000,
                        )}s]`,
                      },
                    };
                  }
                }
              }

              return undefined;
            },
            authorizeToolExecution: async (ctx) => {
              return this.agent.permission.beforeToolCall(ctx);
            },
            finalizeToolResult: async (ctx) => {
              // Resolve dedup BEFORE firing the PostToolUse hook so same-step
              // dups (whose ctx.result is the dedup placeholder) report the
              // original's real outcome, not an empty success.
              const finalResult = await deduper.finalizeResult(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.result,
              );
              const { isError, output } = finalResult;

              // Record in session memory for post-compaction context injection
              this.agent.sessionMemory.recordToolExecution(
                ctx.toolCall.name,
                summarizeToolArgs(ctx.args),
                isError === true,
                ctx.stepNumber,
              );

              // Track accessed files for the working-set reminder.
              this.recordWorkingSetPaths(
                ctx.toolCall.name,
                ctx.args,
                Number(ctx.turnId),
              );

              // Record verification commands (passed or failed) so the convergence
              // gate can enforce fix-then-re-verify behavior and skip recently
              // passed checks. A passing verification also marks all touched files
              // as verified, since the command covered the current working set.
              if (
                ctx.toolCall.name === 'Bash' &&
                typeof (ctx.args as { command?: string }).command === 'string'
              ) {
                const command = (ctx.args as { command: string }).command;
                const cwd = (ctx.args as { cwd?: string }).cwd ?? this.agent.config.cwd;
                if (looksLikeVerificationCommand(command)) {
                  this.agent.workingSet.recordVerification(
                    command,
                    cwd,
                    isError === true ? 1 : 0,
                    toolOutputText(output),
                    Number(ctx.turnId),
                  );
                  if (isError !== true) {
                    this.agent.workingSet.markAllVerified();
                    // A passing verification resolves any earlier Bash failure
                    // for this turn (e.g. a failing test run before the fix).
                    if (this.lastToolFailure?.toolName === 'Bash') {
                      this.lastToolFailure = null;
                    }
                  }
                }
              }

              // When the verify agent reports its result, record the structured
              // verification status so the convergence gate can enforce fix-then-
              // re-verify behavior.
              if (ctx.toolCall.name === 'Agent') {
                const subagentType = (ctx.args as { subagent_type?: string }).subagent_type;
                if (subagentType === 'verify') {
                  const status = parseVerificationStatus(toolOutputText(output));
                  if (status !== undefined && status.command !== 'none') {
                    this.agent.workingSet.recordVerification(
                      status.command,
                      this.agent.config.cwd,
                      status.passed ? 0 : status.exitCode,
                      toolOutputText(output),
                      Number(ctx.turnId),
                    );
                    if (status.passed) {
                      this.agent.workingSet.markAllVerified();
                      // A passing verification resolves any earlier verify/Bash
                      // failure for this turn.
                      if (this.lastToolFailure?.toolName === 'Bash' || this.lastToolFailure?.toolName === 'Agent') {
                        this.lastToolFailure = null;
                      }
                    }
                  }
                }
              }

              if (ctx.toolCall.name === 'TodoList') {
                this.todoSeenThisTurn = true;
              }

              if (isError === true && ['Edit', 'Write', 'Bash', 'Agent'].includes(ctx.toolCall.name)) {
                const command =
                  ctx.toolCall.name === 'Bash'
                    ? String((ctx.args as { command?: string }).command ?? '')
                    : '';
                const subagentType =
                  ctx.toolCall.name === 'Agent'
                    ? String((ctx.args as { subagent_type?: string }).subagent_type ?? '')
                    : '';
                const isExploratory =
                  ctx.toolCall.name === 'Agent'
                    ? subagentType !== 'verify' && subagentType !== 'reviewer'
                    : this.isExploratoryBashCommand(command);
                this.lastToolFailure = { toolName: ctx.toolCall.name, isExploratory };
              } else if (isError !== true && this.lastToolFailure?.toolName === ctx.toolCall.name) {
                // Edit/Write/Agent are deterministic — a later success of the
                // same tool means the prior failure (e.g. stale old_string) is
                // resolved. Bash is non-deterministic: a passing `ls` does
                // not fix a failing `tsc`, so blocking Bash failures are only
                // cleared by a passing verification (markAllVerified above).
                if (ctx.toolCall.name !== 'Bash' || this.lastToolFailure.isExploratory) {
                  this.lastToolFailure = null;
                }
              }

              const event = isError === true ? 'PostToolUseFailure' : 'PostToolUse';
              void this.agent.hooks?.fireAndForgetTrigger(event, {
                matcherValue: ctx.toolCall.name,
                inputData: {
                  toolName: ctx.toolCall.name,
                  toolInput: toolInputRecord(ctx.args),
                  toolCallId: ctx.toolCall.id,
                  error: isError === true ? toScreamErrorPayload(toolOutputText(output)) : undefined,
                  toolOutput: isError === true ? undefined : toolOutputText(output).slice(0, 2000),
                },
              });
              return finalResult;
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        if (
          error instanceof APIContextOverflowError ||
          (isScreamError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
        ) {
          await this.agent.fullCompaction.handleOverflowError(signal, error);
          continue; // Retry with compacted context
        }
        if (isMaxStepsExceededError(error)) {
          this.agent.log.warn('turn hit max steps', {
            turnId,
            steps: this.currentStepByTurn.get(turnId) ?? this.currentStep,
            limit: isScreamError(error) ? error.details?.['maxSteps'] : undefined,
          });
        } else {
          this.agent.log.error('turn failed', { turnId, error });
        }
        throw error;
      }
    }
  }

  /** Track files touched by builtin tools. Bash-modified files are NOT tracked. */
  private recordWorkingSetPaths(toolName: string, args: unknown, turnId: number): void {
    const workingSet = this.agent.workingSet;
    if (toolName === 'Read' || toolName === 'ReadGroup' || toolName === 'ReadMediaFile') {
      const paths =
        toolName === 'ReadGroup'
          ? (args as { paths?: string[] }).paths
          : [(args as { path?: string }).path];
      for (const path of paths ?? []) {
        if (path !== undefined) workingSet.markRead(path, turnId);
      }
    }
    if (toolName === 'Edit' || toolName === 'Write') {
      const path = (args as { path?: string }).path;
      if (path !== undefined) workingSet.touch(path, turnId);
    }
  }

  private buildDispatchEvent(turnId: number) {
    return createLoopEventDispatcher({
      appendTranscriptRecord: async (event: LoopRecordedEvent) => {
        this.agent.context.appendLoopEvent(event);
      },
      emitLiveEvent: (event: LoopEvent) => {
        this.updateCurrentStepFromLoopEvent(event, turnId);
        const mapped = mapLoopEvent(event, turnId);
        if (mapped !== undefined) this.agent.emitEvent(mapped);
      },
    });
  }

  private updateCurrentStepFromLoopEvent(event: LoopEvent, turnId: number): void {
    if (event.type === 'step.begin') {
      this.beginTrackedStep(turnId, event.step);
      return;
    }
    if (
      event.type === 'text.delta' ||
      event.type === 'thinking.delta' ||
      event.type === 'tool.call'
    ) {
      this.currentStepHadContent = true;
    }
  }

  private beginTrackedStep(turnId: number, step: number): void {
    this.currentStepByTurn.set(turnId, step);
    this.currentStep = step;
  }
  private turnHadMeaningfulWork(): boolean {
    const workingSet = this.agent.workingSet;
    const hasNewPaths = workingSet.getPaths().length > this.turnStartWorkingSetPathCount;
    const hasNewVerification = workingSet.getVerificationCount() > this.turnStartVerificationCount;
    const hasCurrentTurnVerification = workingSet.hasVerificationForTurn(this.currentTurnId);
    return hasNewPaths || hasNewVerification || hasCurrentTurnVerification;
  }

  private lastAssistantMessageIsTrivial(): boolean {
    const history = this.agent.context.history;
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      if (message === undefined || message.role !== 'assistant') continue;
      const text = getAssistantMessageText(message);
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      return (
        trimmed.length < this.MIN_FINAL_RESPONSE_LENGTH ||
        TRIVIAL_COMPLETION_RE.test(trimmed)
      );
    }
    return false;
  }

  /**
   * Classify a Bash command as "exploratory" (probing the environment) vs
   * "blocking" (a command whose failure means the task cannot be delivered).
   * Exploratory failures (e.g. probing for tsc, ls, which) do not block once
   * the turn has produced a successful resolution.
   */
  private isExploratoryBashCommand(command: string): boolean {
    const normalized = command.toLowerCase().trim();
    // Probing for toolchain binaries or inspecting the environment should not
    // keep the turn alive once a working alternative has been found. These
    // patterns can appear anywhere in the command (e.g. after `cd ... && `).
    const exploratoryPatterns = [
      /\bwhich\s+/,
      /\bwhereis\s+/,
      /\bcommand\s+-v\s+/,
      /\btype\s+/,
      /\bls\s+/,
      /\bfind\s+/,
      /\bglob\s+/,
      /\bnpm\s+list\s+-g/,
      /\bcat\s+/,
      /\bhead\s+/,
      /\btail\s+/,
      /\becho\s+/,
      /\btest\s+-[efdx]/,
      /\[\s+-[efdx]/,
      // Trying to invoke `tsc`/`tsx`/etc. without the package installed is an
      // environment probe. The real verification happens once typescript/tsx
      // is available (e.g. `npx -p typescript tsc`).
      /(^|;\s*|&&\s*)\s*npx\s+tsc\s/,
      /(^|;\s*|&&\s*)\s*npx\s+tsx\s/,
      /(^|;\s*|&&\s*)\s*npx\s+typescript\s/,
      /(^|;\s*|&&\s*)\s*tsc\s/,
      /(^|;\s*|&&\s*)\s*tsx\s/,
      // Installing typescript/tsx to enable verification is also exploratory.
      /(^|;\s*|&&\s*)\s*npm\s+install\s+(--no-save\s+)?typescript/,
      /(^|;\s*|&&\s*)\s*npm\s+install\s+(--no-save\s+)?tsx/,
      /(^|;\s*|&&\s*)\s*pnp[ms]\s+add\s+(--global\s+)?typescript/,
      /(^|;\s*|&&\s*)\s*pnp[ms]\s+add\s+(--global\s+)?tsx/,
      /(^|;\s*|&&\s*)\s*yarn\s+add\s+(--dev\s+)?typescript/,
      /(^|;\s*|&&\s*)\s*yarn\s+add\s+(--dev\s+)?tsx/,
      // Common read-only / exploratory probes
      /\bgit\s+status\b/,
      /\bgit\s+diff\b/,
      /\bgit\s+log\b/,
      /\bgrep\s+/,
      /\brg\s+/,
      /\bnode\s+-e\s+/,
      /\bpython\b/,
      /\bpython3\b/,
      /\bwc\s+/,
      /\bsort\s+/,
      /\buniq\b/,
      /\bdiff\s+/,
      /\bfile\s+/,
      /\bstat\s+/,
      /\bdf\s+/,
      /\bdu\s+/,
    ];
    return exploratoryPatterns.some((pattern) => pattern.test(normalized));
  }


}
function getAssistantMessageText(message: ContextMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

const TRIVIAL_COMPLETION_RE =
  /^\s*(done|ok|okay|完成|好了|ok\.?|done\.?|completed\.?|finished\.?|tests?\s+passed\.?|passed\.?|it\s+works\.?|looks\s+good\.?|fixed\.?|resolved\.?|verified\.?|all\s+good\.?|一切正常\.?|已完成\.?)\s*$/iu;

function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
        display:
          event.result.isError === true ? undefined : event.result.display,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

const LLM_NOT_SET_MESSAGE =
  'No model configured. Run `scream config` or use `/model` to set a default model.';

function summarizeTurnError(error: unknown, turnId: number): ScreamErrorPayload {
  const payload = toScreamErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

function toolInputRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * Parse a `[verification_status]` block from verify-agent output.
 * Returns undefined if no block is found.
 */
function parseVerificationStatus(
  output: string,
): { passed: boolean; command: string; exitCode: number } | undefined {
  const match = output.match(/\[verification_status\]\s*\n([\s\S]*?)(?=\n\n|\n?$)/);
  if (!match || match[1] === undefined) return undefined;
  const block = match[1];
  const passedMatch = block.match(/^passed:\s*(true|false)\s*$/im);
  const commandMatch = block.match(/^command:\s*(.+)$/im);
  const exitCodeMatch = block.match(/^exit_code:\s*(\d+)\s*$/im);
  if (
    !passedMatch ||
    !commandMatch ||
    !exitCodeMatch ||
    passedMatch[1] === undefined ||
    commandMatch[1] === undefined ||
    exitCodeMatch[1] === undefined
  ) {
    return undefined;
  }
  return {
    passed: passedMatch[1].toLowerCase() === 'true',
    command: commandMatch[1].trim(),
    exitCode: Number.parseInt(exitCodeMatch[1], 10),
  };
}


function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}



/** Extract a short human-readable summary from tool arguments. */
function summarizeToolArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const a = args as Record<string, unknown>;
  // Common tool arg patterns — try each in priority order
  if (typeof a['file_path'] === 'string') return a['file_path'];
  if (typeof a['path'] === 'string') return a['path'];
  if (typeof a['description'] === 'string') return truncateArg(a['description']);
  if (typeof a['subject'] === 'string') return a['subject'];
  if (typeof a['command'] === 'string') return truncateArg(a['command']);
  if (typeof a['query'] === 'string') return truncateArg(a['query']);
  if (typeof a['url'] === 'string') return a['url'];
  return '';
}

function truncateArg(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
