/**
 * Tool-call lifecycle for one completed provider response.
 *
 * This module keeps the provider-order invariant in one place:
 *   - validate every provider tool call before hooks or events
 *   - run preparation hooks and compute tool-call display fields in provider order
 *   - dispatch `tool.call` before execution starts
 *   - execute tools with non-conflicting resource accesses concurrently
 *   - serialize tools whose resource accesses conflict
 *   - dispatch terminal `tool.result` events in provider order
 *
 * These phases are coupled by transcript ordering and abort handling, so they
 * should be reviewed together.
 */

import type { ContentPart } from '@scream-code/ltod';

import type { Logger } from '#/logging/types';
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '../tools/args-validator';
import { randomUUID } from 'node:crypto';
import { PathSecurityError } from '../tools/policies/path-access';

import { isParentInterject, isUserCancellation, parentInterjectReason, userCancellationReason } from '../utils/abort';
import { errorMessage, isAbortError } from './errors';
import type { LoopEventDispatcher, LoopToolCallEvent } from './events';
import type { LLM, LLMChatResponse } from './llm';
import { ToolAccesses } from './tool-access';
import { ToolScheduler, type ToolCallTask } from './tool-scheduler';
import type {
  AuthorizeToolExecutionResult,
  ExecutableTool,
  ExecutableToolErrorResult,
  LoopHooks,
  ToolCall,
  PrepareToolExecutionResult,
  ExecutableToolResult,
  NestedToolCallRequest,
  RunnableToolExecution,
  ToolExecution,
} from './types';

const GRACE_TIMEOUT_MS = 2_000;
const STEER_POLL_INTERVAL_MS = 150;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';
const UNEXECUTED_TOOL_CALL_OUTPUT =
  'This tool call was not executed: the model response ended before tool execution could start ' +
  '(the provider stream was interrupted). Do not assume the tool ran - ' +
  're-issue the call if it is still needed.';

const validators = new WeakMap<ExecutableTool, ToolArgsValidator>();

/**
 * Output for an aborted tool call. The abort's reason decides the attribution:
 * a user cancellation (the user pressed stop) says so explicitly, and a parent
 * interject says it was a deliberate redirection to be picked up from the
 * `[parent_messages]` directive that follows — in both cases so the model
 * treats it as intentional instead of a system fault to theorise about or
 * retry. Any other abort keeps the neutral wording.
 */
function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  if (isParentInterject(signal.reason)) {
    return `The parent agent interrupted "${toolName}" (and anything else running at the same time) with an interjection. This was a deliberate redirection, not a system error, timeout, or capacity limit. Read the [parent_messages] directive that follows and follow it — do not retry this call or wait for the user.`;
  }
  return `Tool "${toolName}" was aborted`;
}

/**
 * Stringify an `AbortSignal`'s reason for the `abortReason` field.
 *
 * The abort's own words are reported as-is: a signal aborted without an
 * explicit reason carries the runtime's default reason, and that is what the
 * consumer sees rather than a second-hand guess. A signal that was never
 * aborted (`reason === undefined`) and an Error with neither message nor name
 * yield nothing, so the field is omitted instead of recorded blank.
 */
function abortReasonText(signal: AbortSignal): string | undefined {
  // `AbortSignal.reason` is typed `any`, so narrow it before stringifying: a
  // non-Error object reason would otherwise degrade into "[object Object]".
  const reason: unknown = signal.reason;
  if (reason === undefined || reason === null) return undefined;
  if (reason instanceof Error) {
    // Abort reasons spend their meaning on the message ("Aborted by the
    // user"); the class name is the fallback for an empty one.
    return nonEmpty(reason.message) ?? nonEmpty(reason.name);
  }
  if (typeof reason === 'string') return nonEmpty(reason);
  if (typeof reason === 'number' || typeof reason === 'boolean' || typeof reason === 'bigint') {
    return String(reason);
  }
  return undefined;
}

/** Trimmed text, or undefined when there is nothing to report. */
function nonEmpty(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Tag a tool's *own* error result as an abort when this step's signal is what
 * cut the call short.
 *
 * Everything the loop synthesizes itself already carries a `code`, but a tool
 * that handles its own interruption returns a plain error result: Bash and
 * Python report an interrupted command through `builder.error(...)`, which
 * only takes the human-readable text. An error result with no code reads as an
 * ordinary failure to the consecutive-failure breaker, so an interrupted
 * command used to charge the streak and (at the stop threshold) end the turn
 * reporting "N consecutive tool calls have failed" — blaming the model for the
 * user's or parent agent's own interrupt.
 *
 * Only the missing case is filled in:
 *   - a result that already carries a code keeps it: the tool's own
 *     classification (`blocked`, `failed`) is more specific than ours;
 *   - a result that is not an error is left untouched: a tool that finished
 *     successfully inside the abort race did succeed.
 */
function tagAbortedToolResult(
  result: ExecutableToolResult,
  signal: AbortSignal,
): ExecutableToolResult {
  if (!signal.aborted) return result;
  if (result.isError !== true) return result;
  if (result.code !== undefined) return result;
  const abortReason = abortReasonText(signal);
  return {
    ...result,
    code: 'aborted' as const,
    ...(abortReason !== undefined ? { abortReason } : {}),
  };
}

export interface ToolCallStepContext {
  /**
   * True while running a tool call issued by another tool (script sandbox).
   * Nested calls reuse the pipeline but never touch model-visible bookkeeping:
   * no block ordinals, no `tool.call`/`tool.result` events, no dedup ledger.
   */
  readonly nested?: boolean | undefined;
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly hasPendingSteer?: (() => boolean) | undefined;
  /**
   * Attribution for the steer `hasPendingSteer` reports: which lane the
   * interrupting steer belongs to. The batch builds the abort reason from it,
   * so an interrupted tool tells the model *who* cut it short — the user's
   * stop or a parent agent's interject. Absent or `'user'` keeps the
   * user-cancellation wording (the pre-existing behavior).
   */
  readonly pendingSteerKind?: (() => 'user' | 'parent-interject') | undefined;
  /**
   * Per-step ordinal for executed tool-call blocks. Lives on the context
   * instead of a module-level Map keyed by stepUuid: the base and effective
   * step objects share one sequence by reference, and the counter's lifetime
   * is bounded by the step (the Map leaked one entry per step forever).
   */
  readonly toolCallBlockIndex: { value: number };
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

type PrepareToolExecutionDecision =
  | { readonly kind: 'allowed'; readonly args: unknown; readonly metadata?: unknown }
  | { readonly kind: 'synthetic'; readonly args: unknown; readonly result: ExecutableToolResult }
  | { readonly kind: 'blocked'; readonly args: unknown; readonly output: string }
  | { readonly kind: 'hookFailed'; readonly args: unknown; readonly output: string };

interface PendingToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ExecutableToolResult;
  readonly stopTurn?: boolean | undefined;
}

interface PreparedToolCallTask {
  readonly task: ToolCallTask<PendingToolResult>;
  readonly stopBatchAfterThis?: boolean | undefined;
}

type ToolCallDisplayFields = Pick<LoopToolCallEvent, 'description' | 'display'>;

export interface ToolCallBatchResult {
  readonly stopTurn: boolean;
  /** Tool calls that failed preflight (unknown tool / malformed args). */
  readonly rejectedCount: number;
  /** Total tool calls in this step's response. */
  readonly totalCalls: number;
}

/**
 * Record tool calls that arrived in a truncated response (max_tokens,
 * paused, unknown) but were never executed. Each call gets a `tool.call`
 * event immediately followed by a synthetic `tool.result` with an error
 * output, so the transcript stays balanced and strict providers don't
 * reject the next step for an empty assistant message or dangling
 * tool_use without a paired tool_result.
 */
export async function recordUnexecutedToolCalls(
  step: ToolCallStepContext,
  response: LLMChatResponse,
): Promise<void> {
  for (const [toolCallIndex, toolCall] of response.toolCalls.entries()) {
    const parsedArgs = parseToolCallArguments(toolCall.arguments);
    if (!parsedArgs.success) {
      step.log?.debug('recording unexecuted tool call with unparseable arguments', {
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        rawLength: toolCall.arguments?.length ?? 0,
        error: parsedArgs.error,
      });
    }
    // Mark the tool-call block so the step's block sequence (thinking/text/
    // tool-call) is preserved in the trajectory.
    await step.dispatchEvent({
      type: 'block.start',
      uuid: randomUUID(),
      turnId: step.turnId,
      step: step.currentStep,
      stepUuid: step.stepUuid,
      index: toolCallIndex,
      blockType: 'tool-call',
    });
    await step.dispatchEvent({
      type: 'tool.call',
      uuid: toolCall.id,
      turnId: step.turnId,
      step: step.currentStep,
      stepUuid: step.stepUuid,
      toolCallId: toolCall.id,
      name: toolCall.name,
      args: parsedArgs.success ? parsedArgs.data : {},
    });
    await step.dispatchEvent({
      type: 'block.end',
      uuid: randomUUID(),
      turnId: step.turnId,
      step: step.currentStep,
      stepUuid: step.stepUuid,
      index: toolCallIndex,
      blockType: 'tool-call',
    });
    await step.dispatchEvent({
      type: 'tool.result',
      parentUuid: toolCall.id,
      toolCallId: toolCall.id,
      result: { output: UNEXECUTED_TOOL_CALL_OUTPUT, isError: true },
    });
  }
}

export async function runToolCallBatch(
  step: ToolCallStepContext,
  response: LLMChatResponse,
): Promise<ToolCallBatchResult> {
  if (response.toolCalls.length === 0) {
    return { stopTurn: false, rejectedCount: 0, totalCalls: 0 };
  }
  const calls = response.toolCalls.map((toolCall) => preflightToolCall(step.tools, toolCall));
  const rejectedCount = calls.filter((call) => call.kind === 'rejected').length;
  const scheduler = new ToolScheduler<PendingToolResult>();
  const pendingResults: Array<Promise<PendingToolResult>> = [];
  let stopTurn = false;

  // Mid-batch steer interruption: while tools run, poll for a queued
  // interrupting steer — an interactive user message, or a parent agent's
  // interject — and interrupt the batch when one arrives; the message then
  // reaches the model at the next step instead of waiting out a long
  // command. The steer controller merges into every tool's signal, so the
  // entire downstream path (prepare checks, execute, grace race) treats it
  // exactly like a user cancellation, and the abort reason records which lane
  // fired so the interrupted tools can name it (`pendingSteerKind`).
  const steerController =
    step.hasPendingSteer !== undefined ? new AbortController() : undefined;
  const effectiveStep: ToolCallStepContext =
    steerController === undefined
      ? step
      : { ...step, signal: AbortSignal.any([step.signal, steerController.signal]) };
  const abortOnSteer = (): void => {
    if (step.hasPendingSteer?.() === true && steerController !== undefined && !steerController.signal.aborted) {
      steerController.abort(
        step.pendingSteerKind?.() === 'parent-interject'
          ? parentInterjectReason()
          : userCancellationReason(),
      );
    }
  };
  abortOnSteer(); // Covers a steer queued between the model response and batch start.
  const steerPoll =
    steerController === undefined
      ? undefined
      : setInterval(() => {
          // A throwing host callback must never become an uncaught exception
          // inside a timer — that would crash the whole process mid-turn.
          try {
            abortOnSteer();
          } catch {
            // Skip this tick; the next poll retries.
          }
        }, STEER_POLL_INTERVAL_MS);

  try {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;

      // If the signal fired (user stop / parent abort), skip preparation
      // for remaining tools and settle them with synthetic abort results.
      // This avoids running preflight, resolveExecution, hooks, and
      // dispatching tool.call events for tools that will never execute.
      try {
        if (effectiveStep.signal.aborted) {
          await dispatchToolCall(step, call, call.args);
          pendingResults.push(
            Promise.resolve(
              makeErrorToolResult(
                call,
                call.args,
                abortedToolOutput(call.toolName, effectiveStep.signal),
                'aborted',
                abortReasonText(effectiveStep.signal),
              ),
            ),
          );
          continue;
        }

        const prepared = await prepareToolCall(effectiveStep, call);
        pendingResults.push(
          scheduler
            .add(prepared.task)
            .catch((error) =>
              synthesizePreparationError(effectiveStep.signal, call, call.args, error, errorMessage(error)),
            ),
        );

        if (prepared.stopBatchAfterThis === true) {
          stopTurn = true;
          for (const skippedCall of calls.slice(index + 1)) {
            try {
              const skippedTask = await prepareSkippedToolCall(step, skippedCall);
              pendingResults.push(
                scheduler
                  .add(skippedTask)
                  .catch((error) => makeErrorToolResult(skippedCall, skippedCall.args, errorMessage(error))),
              );
            } catch (error) {
              // prepareSkippedToolCall dispatches tool.call; a wire append
              // failure still needs its pairing below.
              step.log?.warn('skipped tool.call dispatch failed, synthesizing error result', {
                toolCallId: skippedCall.toolCall.id,
                toolName: skippedCall.toolName,
                error,
              });
              pendingResults.push(
                Promise.resolve(
                  makeErrorToolResult(skippedCall, skippedCall.args, `Tool preparation failed: ${errorMessage(error)}`),
                ),
              );
            }
          }
          break;
        }
      } catch (error) {
        // dispatchToolCall / preparation can throw once execution has started
        // (their wire append rejects). Push a synthetic error result so this
        // call still gets exactly one tool.result instead of stranding its
        // row forever, and keep draining the rest of the batch — the finally
        // block only settles spawned tasks, it never re-dispatches lost
        // results.
        step.log?.warn('tool call preparation failed, synthesizing error result', {
          toolCallId: call.toolCall.id,
          toolName: call.toolName,
          error,
        });
        pendingResults.push(
          Promise.resolve(
            synthesizePreparationError(
              effectiveStep.signal,
              call,
              call.args,
              error,
              `Tool preparation failed: ${errorMessage(error)}`,
            ),
          ),
        );
      }
    }

    // Tool tasks may finish out of order; terminal results are still emitted in
    // provider order. Await all tasks so each recorded `tool.call` gets a
    // paired `tool.result`; the caller checks abort before writing `step.end`.
    for (const pendingResult of pendingResults) {
      let raw: PendingToolResult;
      try {
        raw = await pendingResult;
      } catch (error) {
        // Push sites already convert rejections into results; this is the
        // double net. Without the call identity we cannot synthesize a
        // pairing here, so log and keep draining the remaining results.
        step.log?.warn('tool task rejected before producing a result', { error });
        continue;
      }
      let result: PendingToolResult;
      try {
        result = await finalizePendingToolResult(effectiveStep, raw);
      } catch (error) {
        // Defensive net: finalize only normalizes/hooks the result (hook
        // failures are caught inside it); if anything still throws here,
        // deliver the raw result instead of stranding this pairing.
        step.log?.warn('tool result finalize failed, dispatching raw result', { error });
        result = raw;
      }
      if (result.stopTurn === true) stopTurn = true;
      try {
        await step.dispatchEvent({
          type: 'tool.result',
          parentUuid: result.toolCall.id,
          toolCallId: result.toolCall.id,
          result: result.result,
        });
      } catch (error) {
        // A wire append failure must not abort the remaining pairings: the
        // finally block only settles spawned tasks — it never re-dispatches
        // lost results. Warn and keep the loop draining so every later call
        // still reaches its pair and the turn itself survives.
        step.log?.warn('tool.result dispatch failed', {
          toolCallId: result.toolCall.id,
          error,
        });
      }
    }
  } finally {
    if (steerPoll !== undefined) clearInterval(steerPoll);
    // Preparation or result dispatch can throw after execution has started.
    // Always settle spawned tasks before the caller continues so rejected
    // execute promises cannot surface as detached unhandled rejections.
    await Promise.allSettled(pendingResults);
  }
  return { stopTurn, rejectedCount, totalCalls: response.toolCalls.length };
}

/**
 * Provider-order validation pass. It does not run hooks, spawn tools, or write
 * events. Validator compilation may populate the local cache.
 */
function preflightToolCall(
  tools: readonly ExecutableTool[] | undefined,
  toolCall: ToolCall,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  const args = parsedArgs.success ? parsedArgs.data : {};
  const tool = tools?.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args,
      output: `Tool "${toolName}" not found`,
    };
  }
  if (!parsedArgs.success) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args,
      output: `Invalid args for tool "${toolName}": malformed JSON in arguments: ${parsedArgs.error}`,
    };
  }
  const validationError = validateExecutableToolArgs(tool, parsedArgs.data);
  if (validationError !== null) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Invalid args for tool "${toolName}": ${validationError}`,
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

export function parseToolCallArguments(
  raw: string | null,
):
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: string } {
  if (raw === null || raw.length === 0) {
    return { success: true, data: {} };
  }
  try {
    return { success: true, data: JSON.parse(raw) as unknown };
  } catch (error) {
    const repaired = repairTruncatedJson(raw);
    try {
      return { success: true, data: JSON.parse(repaired) as unknown };
    } catch {
      return { success: false, error: errorMessage(error) };
    }
  }
}

/**
 * Attempt to repair truncated JSON by balancing brackets/braces,
 * closing strings, and filling missing values with null.
 */
function repairTruncatedJson(raw: string): string {
  let repaired = raw.trimEnd();

  // Track state — a real open-container stack so closers come out in true
  // LIFO order ({"a": [ truncated → ]} not ]}).
  const openStack: string[] = [];
  let inString = false;
  let stringHasEscape = false;
  let lastNonWhitespace = '';

  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired.charAt(i);
    if (ch === '\\' && inString) {
      stringHasEscape = !stringHasEscape;
      continue;
    }
    if (ch === '"' && !stringHasEscape) {
      inString = !inString;
      stringHasEscape = false;
      if (!/\s/.test(ch)) lastNonWhitespace = ch;
      continue;
    }
    stringHasEscape = false;

    if (inString) continue;

    if (ch === '{') openStack.push('}');
    else if (ch === '[') openStack.push(']');
    else if (ch === '}' || ch === ']') {
      if (openStack.length > 0 && openStack.at(-1) === ch) {
        openStack.pop();
      }
    }

    if (!/\s/.test(ch)) lastNonWhitespace = ch;
  }

  // Close string first
  if (inString) {
    repaired += '"';
  }

  // Fill trailing comma with null
  if (lastNonWhitespace === ',') {
    repaired += 'null';
  }

  // Close containers in reverse order of opening (LIFO)
  for (let i = openStack.length - 1; i >= 0; i--) {
    repaired += openStack[i];
  }

  return repaired;
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  let validator = validators.get(tool);
  if (validator === undefined) {
    try {
      validator = compileToolArgsValidator(tool.parameters);
      validators.set(tool, validator);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(validator, args as JsonType);
}

async function prepareToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
): Promise<PreparedToolCallTask> {
  const settleError = async (
    args: unknown,
    output: string,
    classification?: {
      readonly code?: ExecutableToolErrorResult['code'];
      readonly abortReason?: string;
    },
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    await dispatchToolCall(step, call, args, displayFields);
    return {
      task: makeResolvedToolCallTask(
        makeErrorToolResult(call, args, output, classification?.code, classification?.abortReason),
      ),
    };
  };

  const settleSynthetic = async (
    args: unknown,
    result: ExecutableToolResult,
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    const coerced = coerceToolResult(result, call.toolName);
    await dispatchToolCall(step, call, args, displayFields);
    return {
      task: makeResolvedToolCallTask(makeToolResult(call, args, coerced)),
      stopBatchAfterThis: toolResultStopsTurn(coerced),
    };
  };

  if (call.kind === 'rejected') {
    // Feed validation-rejected calls to the repeat breaker so re-issuing the
    // same invalid call fires the 3/5/8 reminders (and the loop-level turn
    // breaker can count it) instead of silently retrying forever. A throwing
    // observer must never break the tool batch, so the reminder is best-effort.
    let reminder: string | null | void;
    try {
      reminder = await step.hooks?.onToolCallRejected?.({
        toolCallId: call.toolCall.id,
        toolName: call.toolName,
        args: call.args,
        rawArguments: call.toolCall.arguments,
        nested: step.nested === true,
      });
    } catch {
      reminder = null;
    }
    const output = reminder ? `${call.output}\n${reminder}` : call.output;
    return settleError(call.args, output);
  }

  const decision = await runPrepareToolExecutionHook(step, call);
  if (decision.kind === 'blocked') {
    return settleError(decision.args, decision.output, { code: 'blocked' });
  }
  if (decision.kind === 'hookFailed') {
    // An abort that cut the prepare hook short is reported as an abort, not as
    // a hook failure, so consumers keep seeing the cancellation the caller
    // caused instead of a defect in the tool/hook pair.
    return step.signal.aborted
      ? settleError(decision.args, decision.output, {
          code: 'aborted',
          abortReason: abortReasonText(step.signal),
        })
      : settleError(decision.args, decision.output);
  }
  if (decision.kind === 'synthetic') {
    return settleSynthetic(decision.args, decision.result);
  }

  const validationError = validateExecutableToolArgs(call.tool, decision.args);
  if (validationError !== null) {
    return settleError(
      decision.args,
      `Invalid args for tool "${call.toolName}" after prepareToolExecution hook: ${validationError}`,
    );
  }

  const effectiveArgs = decision.args;
  let execution: ToolExecution;
  try {
    execution = await call.tool.resolveExecution(effectiveArgs);
  } catch (error) {
    if (!(error instanceof PathSecurityError)) {
      step.log?.warn('tool execution setup failed', {
        toolName: call.toolName,
        toolCallId: call.toolCall.id,
        error,
      });
    }
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
    return settleError(effectiveArgs, output);
  }

  const displayFields = toolCallDisplayFieldsFromExecution(execution);
  const settleAborted = (): Promise<PreparedToolCallTask> =>
    settleError(
      effectiveArgs,
      abortedToolOutput(call.toolName, step.signal),
      { code: 'aborted', abortReason: abortReasonText(step.signal) },
      displayFields,
    );

  if (step.signal.aborted) return settleAborted();

  if (execution.isError === true) {
    return settleSynthetic(effectiveArgs, execution, displayFields);
  }

  const authorization = await runAuthorizeToolExecutionHook(step, call, effectiveArgs, execution);
  if (step.signal.aborted) return settleAborted();

  if (authorization?.block === true) {
    return settleError(
      effectiveArgs,
      authorization.reason ?? `Tool call "${call.toolName}" was blocked`,
      { code: 'blocked' },
      displayFields,
    );
  }

  if (authorization?.syntheticResult !== undefined) {
    return settleSynthetic(effectiveArgs, authorization.syntheticResult, displayFields);
  }

  const executionMetadata = authorization?.executionMetadata ?? decision.metadata;
  await dispatchToolCall(step, call, effectiveArgs, displayFields);
  return {
    task: {
      accesses: execution.accesses ?? ToolAccesses.all(),
      start: async () => ({
        result: runRunnableToolCall(step, call, effectiveArgs, executionMetadata, execution),
      }),
    },
  };
}

async function prepareSkippedToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
): Promise<ToolCallTask<PendingToolResult>> {
  const output = 'Tool skipped because a previous tool call stopped the turn.';
  await dispatchToolCall(step, call, call.args);
  return makeResolvedToolCallTask(makeErrorToolResult(call, call.args, output));
}

function makeResolvedToolCallTask(result: PendingToolResult): ToolCallTask<PendingToolResult> {
  return {
    accesses: ToolAccesses.none(),
    start: async () => ({ result: Promise.resolve(result) }),
  };
}

/**
 * Run `prepareToolExecution` in provider order before recording `tool.call`.
 * Hook decisions can block a call or replace args before execution starts.
 */
async function runPrepareToolExecutionHook(
  step: ToolCallStepContext,
  call: RunnableToolCall,
): Promise<PrepareToolExecutionDecision> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  const { toolCall, args } = call;

  if (hooks?.prepareToolExecution === undefined) {
    return { kind: 'allowed', args };
  }

  let hookResult: PrepareToolExecutionResult | undefined;
  try {
    hookResult = await hooks.prepareToolExecution({
      toolCall,
      tool: call.tool,
      args,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
      nested: step.nested === true,
    });
  } catch (error) {
    // If the turn is cancelled while an abort-aware hook is awaited, report the
    // call as aborted instead of treating it as a hook failure.
    if (isAbortError(error) || signal.aborted) {
      return {
        kind: 'hookFailed',
        args,
        output: `Tool "${call.toolName}" was aborted during prepareToolExecution hook`,
      };
    }
    return {
      kind: 'hookFailed',
      args,
      output: `prepareToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }

  const effectiveArgs = hookResult?.updatedArgs ?? args;
  if (hookResult?.block === true) {
    return {
      kind: 'blocked',
      args: effectiveArgs,
      output: hookResult.reason ?? `Tool call "${call.toolName}" was blocked`,
    };
  }

  if (hookResult?.syntheticResult !== undefined) {
    return { kind: 'synthetic', args: effectiveArgs, result: hookResult.syntheticResult };
  }

  return { kind: 'allowed', args: effectiveArgs, metadata: hookResult?.executionMetadata };
}

async function runAuthorizeToolExecutionHook(
  step: ToolCallStepContext,
  call: RunnableToolCall,
  args: unknown,
  execution: RunnableToolExecution,
): Promise<AuthorizeToolExecutionResult | undefined> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.authorizeToolExecution === undefined) return undefined;

  try {
    return await hooks.authorizeToolExecution({
      toolCall: call.toolCall,
      tool: call.tool,
      args,
      execution,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
      nested: step.nested === true,
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return {
        block: true,
        reason: `Tool "${call.toolName}" was aborted during authorizeToolExecution hook`,
      };
    }
    return {
      block: true,
      reason: `authorizeToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }
}

function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}

async function runRunnableToolCall(
  step: ToolCallStepContext,
  call: RunnableToolCall,
  effectiveArgs: unknown,
  metadata: unknown,
  execution: RunnableToolExecution,
): Promise<PendingToolResult> {
  const { signal } = step;
  const { toolCall, toolName } = call;

  if (signal.aborted) {
    return makeErrorToolResult(
      call,
      effectiveArgs,
      abortedToolOutput(toolName, signal),
      'aborted',
      abortReasonText(signal),
    );
  }

  let toolResult: ExecutableToolResult;
  try {
    const raw = await executeTool(step, execution, toolCall, toolName, metadata);
    toolResult = coerceToolResult(raw, toolName);
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('tool execution failed', {
        toolName,
        toolCallId: toolCall.id,
        error,
      });
      return makeErrorToolResult(
        call,
        effectiveArgs,
        `Tool "${toolName}" failed: ${errorMessage(error)}`,
        'failed',
      );
    }
    return makeErrorToolResult(
      call,
      effectiveArgs,
      abortedToolOutput(toolName, signal),
      'aborted',
      abortReasonText(signal),
    );
  }

  // The tool ran to its own completion: an error result it authored itself
  // (an interrupted command included) is classified here, because only this
  // path knows whether the step's signal is what cut the call short. The catch
  // above already reports a throw from the tool itself as `failed`.
  return makeToolResult(call, effectiveArgs, tagAbortedToolResult(toolResult, signal));
}

async function finalizePendingToolResult(
  step: ToolCallStepContext,
  pendingResult: PendingToolResult,
): Promise<PendingToolResult> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.finalizeToolResult === undefined) {
    return { ...pendingResult, result: normalizeToolResult(pendingResult.result) };
  }

  try {
    const finalizedResult = await hooks.finalizeToolResult({
      toolCall: pendingResult.toolCall,
      args: pendingResult.args,
      result: pendingResult.result,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
      nested: step.nested === true,
    });
    const effectiveResult = coerceToolResult(
      finalizedResult ?? pendingResult.result,
      pendingResult.toolName,
    );
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn === true || toolResultStopsTurn(effectiveResult),
      result: normalizeToolResult(effectiveResult),
    };
  } catch (error) {
    // This is the redaction/truncation boundary. If it fails, do not persist
    // the raw tool output; write an error result instead.
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('finalizeToolResult hook failed', {
        toolName: pendingResult.toolName,
        toolCallId: pendingResult.toolCall.id,
        error,
      });
    }
    const output = aborted
      ? `Tool "${pendingResult.toolName}" aborted during finalizeToolResult hook.`
      : `finalizeToolResult hook failed for "${pendingResult.toolName}": ${errorMessage(error)}`;
    // An abort that cut the hook short is a cancellation, not a defect in the
    // hook or the tool — the same classification `prepareToolCall` gives an
    // abort inside `prepareToolExecution`. Consumers that branch on `code`
    // (TUI/RPC, the failure-streak classifier) must not have to parse this
    // message to learn that.
    const abortReason = aborted ? abortReasonText(signal) : undefined;
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn,
      result: {
        output,
        isError: true,
        ...(aborted ? { code: 'aborted' as const } : {}),
        ...(abortReason !== undefined ? { abortReason } : {}),
      },
    };
  }
}

async function executeTool(
  step: ToolCallStepContext,
  execution: RunnableToolExecution,
  toolCall: ToolCall,
  toolName: string,
  metadata: unknown,
): Promise<ExecutableToolResult> {
  const { dispatchEvent, signal, turnId } = step;

  signal.throwIfAborted();

  const executePromise = execution.execute({
    turnId,
    toolCallId: toolCall.id,
    metadata,
    signal,
    // Nested tool calls (script sandbox) re-enter this same pipeline with the
    // model-visible recording suppressed; see `executeNestedToolCall`.
    runNestedToolCall: {
      tools: (step.tools ?? []).filter((tool) => tool.name !== toolName),
      run: (request) => executeNestedToolCall(step, toolName, request),
    },
    onUpdate: (update) => {
      if (signal.aborted) return;
      dispatchEvent({
        type: 'tool.progress',
        toolCallId: toolCall.id,
        update,
      });
    },
  });
  return raceExecuteWithGraceTimeout(executePromise, signal, toolName);
}

async function raceExecuteWithGraceTimeout(
  executePromise: Promise<ExecutableToolResult>,
  signal: AbortSignal,
  toolName: string,
): Promise<ExecutableToolResult> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<ExecutableToolResult> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        const abortReason = abortReasonText(signal);
        resolve({
          output: `Tool "${toolName}" aborted by grace timeout (${String(GRACE_TIMEOUT_MS)}ms)`,
          isError: true,
          // This branch only arms once the call was aborted and the tool
          // ignored the signal, so the synthetic result is classified as an
          // abort instead of leaving consumers to read the text.
          code: 'aborted',
          ...(abortReason !== undefined ? { abortReason } : {}),
        });
      }, GRACE_TIMEOUT_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    // Tools that ignore AbortSignal may never settle. After abort, the grace
    // branch lets the turn finish with a synthetic error result.
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Some AbortSignal polyfills do not implement removeEventListener.
      }
    }
  }
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

/**
 * Validate a tool's raw return against the {@link ExecutableToolResult} contract.
 * A tool that returns `undefined`, a primitive, or an object without a valid
 * `output` field is coerced into an `isError: true` result so the loop can still
 * emit a paired `tool.result` event. This is the trust boundary between
 * arbitrary tool implementations and the rest of the loop.
 */
function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

function normalizeToolResult(r: ExecutableToolResult): ExecutableToolResult {
  let output: ExecutableToolResult['output'];
  if (typeof r.output === 'string') {
    output = r.output.length > 0 ? r.output : TOOL_OUTPUT_EMPTY;
  } else if (r.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = r.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = r.output.some((c) => c.type === 'text' && c.text.length > 0);
      output = hasNonEmptyText
        ? r.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...r.output];
    } else {
      const textJoined = r.output
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  // `nestedCalls`, `message`, `display`, and `useless` are UI/persistence
  // side channels produced by tools (script sandbox, LSP diagnostics, file
  // diffs, search results, micro-compaction hints). They must survive
  // normalization so the tool.result event (and the UI/RPC layers reading
  // it) carries them; the provider only ever sees `output`. `stopTurn` stays
  // stripped on purpose (see ExecutableToolErrorResult) — the loop consumes
  // it before this boundary.
  const nestedCalls = r.isError === true ? undefined : r.nestedCalls;
  const nested = nestedCalls !== undefined ? { nestedCalls } : {};
  const messagePart = r.message !== undefined ? { message: r.message } : {};
  if (r.isError === true) {
    // The error classification is part of the result contract, not a
    // transient: it must survive this rebuild so the tool.result event (and
    // the TUI/RPC layers reading it) can branch on the code instead of
    // pattern-matching the output text.
    const codePart = r.code !== undefined ? { code: r.code } : {};
    const abortReasonPart = r.abortReason !== undefined ? { abortReason: r.abortReason } : {};
    return { output, isError: true, ...nested, ...messagePart, ...codePart, ...abortReasonPart };
  }
  const useless = r.useless;
  const uselessPart = useless !== undefined ? { useless } : {};
  const displayPart = r.display !== undefined ? { display: r.display } : {};
  return { output, ...nested, ...messagePart, ...uselessPart, ...displayPart };
}

function makeToolResult(
  call: PreflightedToolCall,
  args: unknown,
  result: ExecutableToolResult,
): PendingToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result,
    stopTurn: toolResultStopsTurn(result),
  };
}

function toolResultStopsTurn(result: ExecutableToolResult): boolean {
  // stopTurn is declared only on the error result, but goal tools also set it
  // on successful "marked blocked/complete" results. Accept either — the goal
  // tools rely on a successful stopTurn to end the goal run without another
  // model step.
  return 'stopTurn' in result && result.stopTurn === true;
}

/**
 * Build an error result for a call the loop settled itself (aborted, failed,
 * blocked, or never run). `code` carries the machine-readable classification
 * and `abortReason` the abort's own attribution — both optional, because a
 * tool's own error result and records written before these fields existed
 * have neither.
 */
/**
 * Fallback result for a task or preparation that threw before the tool could
 * author its own failure. A throw inside an interrupt window is not a tool
 * failure: without the `aborted` stamp `classifyToolResult` would count it
 * towards the stop-loss streak and attribute a user or parent interruption to
 * the model. Non-abort failures keep the historical shape (no `code` field),
 * so classification is unchanged, and the emitted message is passed through
 * untouched.
 */
function synthesizePreparationError(
  signal: AbortSignal,
  call: PreflightedToolCall,
  args: unknown,
  error: unknown,
  output: string,
): PendingToolResult {
  if (isAbortError(error) || signal.aborted) {
    return makeErrorToolResult(call, args, output, 'aborted', abortReasonText(signal));
  }
  return makeErrorToolResult(call, args, output);
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
  code?: ExecutableToolErrorResult['code'],
  abortReason?: string,
): PendingToolResult {
  return makeToolResult(call, args, {
    output,
    isError: true,
    // Unclassified results stay field-free rather than carrying an
    // `undefined` value, so a persisted record never relies on JSON dropping
    // the key.
    ...(code !== undefined ? { code } : {}),
    // Only meaningful alongside `code: 'aborted'`.
    ...(abortReason !== undefined ? { abortReason } : {}),
  });
}

/**
 * Record `tool.call` in provider order. Reusing the provider/API tool-call id
 * keeps transcript linkage on one canonical identity.
 */
async function dispatchToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
  args: unknown,
  displayFields?: ToolCallDisplayFields | undefined,
): Promise<void> {
  const { toolCall, toolName } = call;
  // Nested calls (script sandbox) never surface as model-visible blocks: the
  // orchestrating tool's own result is the only transcript entry for the
  // batch, and the step's block ordinals belong to model-issued calls.
  if (step.nested === true) {
    return;
  }
  // Mark the executed tool-call block so the step's block sequence
  // (thinking/text/tool-call) is preserved in the trajectory. The index is
  // a per-type ordinal (tool-call counts from 0 across the step). The
  // counter is shared by reference between the base and effective step
  // objects, so batch calls that pass either object form one sequence.
  const index = step.toolCallBlockIndex.value++;
  await step.dispatchEvent({
    type: 'block.start',
    uuid: randomUUID(),
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    index,
    blockType: 'tool-call',
  });
  await step.dispatchEvent({
    type: 'tool.call',
    uuid: toolCall.id,
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    toolCallId: toolCall.id,
    name: toolName,
    args,
    description: displayFields?.description,
    display: displayFields?.display,
  });
  await step.dispatchEvent({
    type: 'block.end',
    uuid: randomUUID(),
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    index,
    blockType: 'tool-call',
  });
}

/**
 * Run a tool call issued by *another tool* (the script sandbox) through the
 * same pipeline as model-issued calls: preflight validation → prepare and
 * authorize hooks (host hooks + approval) → `resolveExecution` → execution
 * with grace timeout → finalize/normalize.
 *
 * Only the model-visible recording is suppressed: no `block.start` /
 * `tool.call` / `tool.result` events are dispatched, so the orchestrating
 * tool's own result stays the single transcript entry for the whole batch.
 * Everything else — argument validation, hooks, approval, aborts and the
 * grace timeout — behaves exactly like a direct call.
 */
async function executeNestedToolCall(
  step: ToolCallStepContext,
  parentToolName: string,
  request: NestedToolCallRequest,
): Promise<ExecutableToolResult> {
  // Re-entrancy guard: a nested call must never reach the orchestrating tool
  // again (unbounded script-in-script recursion).
  const tools = (step.tools ?? []).filter((tool) => tool.name !== parentToolName);
  const toolCall: ToolCall = {
    type: 'function',
    id: request.callId,
    name: request.name,
    arguments: JSON.stringify(request.args ?? {}),
  };
  const nestedStep: ToolCallStepContext = {
    ...step,
    tools,
    nested: true,
    // Model-visible events (and the block-index sequence they feed) belong to
    // the parent call; nested progress surfaces through the parent result.
    dispatchEvent: async () => {},
  };
  const call = preflightToolCall(tools, toolCall);
  const prepared = await prepareToolCall(nestedStep, call);
  const started = await prepared.task.start();
  const raw = await started.result;
  const finalized = await finalizePendingToolResult(nestedStep, raw);
  return finalized.result;
}
