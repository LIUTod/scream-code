/**
 * Public contracts for the stateless agent loop.
 *
 * This file defines the narrow surfaces that connect a Ltod conversation to
 * tool execution, phase hooks, and turn results. Host-layer metadata, policy,
 * archival limits, and UI concerns stay outside these contracts.
 *
 * Field naming is camelCase unless a reused Ltod type says otherwise.
 * Optional fields use `?: T | undefined` intentionally under
 * `exactOptionalPropertyTypes: true`.
 */

import type { ContentPart, Message, TokenUsage, Tool, ToolCall } from '@scream-code/ltod';

import type { ToolInputDisplay, ToolResultDisplay } from '../tools/display';
import type { ToolAccesses } from './tool-access';
import type { LLM } from './llm';

export type { ToolCall };

export type LoopMessageBuilder = () => Message[] | Promise<Message[]>;

/**
 * Stop reason for one completed model step.
 *
 * `tool_use` is a loop-control signal: the loop executes the requested tools and
 * continues with another step. The other values are terminal for the current
 * turn unless a host hook explicitly asks the loop to continue.
 */
export type LoopStepStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'filtered'
  | 'paused'
  | 'unknown';

export type LoopTerminalStepStopReason = Exclude<LoopStepStopReason, 'tool_use'>;

/**
 * Stop reasons that can be returned in a normal `TurnResult`.
 *
 * `tool_use` is intentionally absent because it cannot be the final result of a
 * completed turn. Errors and max-step exhaustion are represented by thrown
 * errors, not by this union. Compaction is a host-level retry concern rather
 * than a stop reason.
 */
export type LoopTurnStopReason = LoopTerminalStepStopReason | 'aborted';

/**
 * Shared mutable state tracking the active media projection mode for a turn.
 * When a step fails because the provider rejects media (too large, bad
 * format), the recovery logic flips the mode and subsequent steps in the
 * same turn use the degraded/stripped projection directly, avoiding a
 * wasted failed request per step.
 */
export interface MediaProjectionState {
  mode: 'normal' | 'degraded' | 'stripped';
}

/**
 * @deprecated Legacy umbrella union. Use `LoopStepStopReason` for per-step
 * model responses and `LoopTurnStopReason` for `TurnResult`.
 */
export type StopReason = LoopStepStopReason | 'aborted';

export interface TurnResult {
  stopReason: LoopTurnStopReason;
  steps: number;
  usage: TokenUsage;
}

export type ExecutableToolOutput = string | ContentPart[];

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  /**
   * Optional human-readable side channel for tool-result metadata that
   * should not contaminate the data stream the model sees (e.g. a
   * "Task snapshot retrieved." brief for TaskOutput). Distinct from
   * `output`: callers rendering tool results decide whether to surface
   * this to the user.
   */
  readonly message?: string | undefined;
  /**
   * Structured result metadata for TUI renderers. When present, renderers
   * use this instead of parsing the text `output`. The model still sees
   * `output`; this field is a side channel for the UI layer. Tools that
   * produce structured data (e.g. Grep matches) fill this in; others
   * leave it undefined and renderers fall back to text.
   */
  readonly display?: ToolResultDisplay | undefined;
  /**
   * Calls this tool made *through the loop pipeline* while it ran (the script
   * sandbox executing `tools.<name>()`). Persisted with the `tool.result`
   * event so the UI can render a summary and resume keeps it; never shown to
   * the model — only `output` reaches the provider.
   */
  readonly nestedCalls?: readonly NestedToolCallRecord[] | undefined;
  /**
   * Hint that this result is uneventful and unlikely to be referenced
   * again (e.g. "no matches found", empty output). When set on a tool
   * result entering the context, the corresponding ContextMessage is
   * marked useless so micro compaction can elide it later without losing
   * actionable information.
   */
  readonly useless?: boolean | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  /** See {@link ExecutableToolSuccessResult.message}. */
  readonly message?: string | undefined;
  /**
   * Internal loop-control hint. Tool result events strip this field before
   * persistence; it only tells the current turn whether another model step is
   * allowed after this tool batch.
   */
  readonly stopTurn?: boolean | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  text?: string | undefined;
  percent?: number | undefined;
  /** Vendor-defined event identifier when `kind === 'custom'`. */
  customKind?: string | undefined;
  /** Opaque payload paired with `customKind`. */
  customData?: unknown;
}

/**
 * One nested tool call made by an orchestrating tool (script sandbox).
 * Mirrors the reference implementation's record: calls over the recording
 * caps still run; only the record degrades (`incomplete`, args omitted).
 */
export interface NestedToolCallRecord {
  /** Call id (`<parentToolCallId>/<n>`), unique within the parent result. */
  readonly callId: string;
  readonly name: string;
  /** Single-line argument preview, omitted once the argument byte budget is
   *  exhausted (see `incomplete`). */
  readonly argsPreview?: string | undefined;
  status: 'ok' | 'error';
  durationMs: number;
  /** Set when the arguments were dropped from the record for size reasons. */
  readonly incomplete?: boolean | undefined;
}

/** Request accepted by {@link NestedToolRunner.run}. */
export interface NestedToolCallRequest {
  readonly name: string;
  readonly args: unknown;
  readonly callId: string;
}

/**
 * Runs tool calls issued by *another tool* through the full loop pipeline
 * (preflight validation, prepare/authorize hooks — including approval — and
 * result normalization) without recording model-visible call/result events:
 * the orchestrating tool's own result is the only transcript entry for the
 * whole batch.
 */
export interface NestedToolRunner {
  /** Tools callable from the nested caller: the current step's offered set
   *  minus the orchestrating tool itself. */
  readonly tools: readonly ExecutableTool[];
  run(request: NestedToolCallRequest): Promise<ExecutableToolResult>;
}

/**
 * Per-call context passed to tool implementations.
 */
export interface ExecutableToolContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
  /**
   * Present when the loop supports nested tool calls. Tools that orchestrate
   * other tools (script sandbox) use it instead of invoking tools directly,
   * so every nested call keeps validation, hooks and approval guarantees.
   */
  readonly runNestedToolCall?: NestedToolRunner | undefined;
}

export interface RunnableToolExecution {
  readonly isError?: false | undefined;
  readonly accesses?: ToolAccesses | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly description?: string;
  readonly approvalRule: string;
  readonly matchesRule?: ((ruleArgs: string) => boolean) | undefined;
  readonly execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>;
}

export type ToolExecution = RunnableToolExecution | ExecutableToolErrorResult;

export interface ExecutableTool<Input = unknown> extends Tool {
  resolveExecution(input: Input): ToolExecution | Promise<ToolExecution>;
}

/**
 * Step hooks are aligned to recorded phase boundaries: `beforeStep` runs before
 * `step.begin`, while `afterStep` runs after `step.end`.
 */

export interface LoopStepHookContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly llm: LLM;
}

export interface ToolExecutionHookContext extends LoopStepHookContext {
  readonly toolCall: ToolCall;
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
  /**
   * True when the call was issued by another tool (script sandbox) rather
   * than by the model. Hooks that keep per-step bookkeeping — the same-step
   * dedup ledger in particular — must skip nested calls: they share the
   * parent's step but are not part of the model's call batch, and registering
   * them can deadlock the parent (its own result would wait on a nested
   * duplicate of itself).
   */
  readonly nested?: boolean | undefined;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface AuthorizeToolExecutionResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly syntheticResult?: ExecutableToolResult | undefined;
  readonly executionMetadata?: unknown;
}

export interface PrepareToolExecutionResult extends AuthorizeToolExecutionResult {
  readonly updatedArgs?: unknown;
}

export interface FinalizeToolResultContext extends ToolExecutionHookContext {
  readonly result: ExecutableToolResult;
}

export interface LoopAfterStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}

export interface LoopStoppedStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopTerminalStepStopReason;
}

export interface BeforeStepResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface ShouldContinueAfterStopResult {
  readonly continue: boolean;
}

/** Return value of `recordUsage` when the host wants to stop the turn early. */
export interface RecordStepUsageResult {
  readonly stopTurn?: boolean | undefined;
}

/** Return value of `afterStep` hook when it wants to stop the turn early. */
export interface AfterStepResult {
  readonly stopTurn?: boolean | undefined;
}

export type BeforeStepHook = (ctx: LoopStepHookContext) => Promise<BeforeStepResult | undefined>;

export type AfterStepHook = (ctx: LoopAfterStepContext) => Promise<AfterStepResult | undefined>;

export type PrepareToolExecutionHook = (
  ctx: ToolExecutionHookContext,
) => Promise<PrepareToolExecutionResult | undefined>;

export type AuthorizeToolExecutionHook = (
  ctx: ResolvedToolExecutionHookContext,
) => Promise<AuthorizeToolExecutionResult | undefined>;

export type FinalizeToolResultHook = (
  ctx: FinalizeToolResultContext,
) => Promise<ExecutableToolResult | undefined>;

export type ShouldContinueAfterStopHook = (
  ctx: LoopStoppedStepContext,
) => Promise<ShouldContinueAfterStopResult | undefined>;

/**
 * Groups every awaited phase hook.
 *
 * Hooks can affect control flow at deterministic transcript points. Event
 * listeners observe output and cannot change turn behavior.
 *
 * Tool hooks run serially in provider tool-call order before the matching
 * durable event is recorded, so preparation and finalization decisions are
 * resolved at stable transcript points.
 */
export interface LoopHooks {
  beforeStep?: BeforeStepHook | undefined;
  afterStep?: AfterStepHook | undefined;
  prepareToolExecution?: PrepareToolExecutionHook | undefined;
  /**
   * Called when a tool call is rejected in preflight (unknown tool / malformed
   * args). Return a reminder string to append to the rejection output when a
   * repeated-streak threshold is hit (3/5/8), or null/void for none.
   */
  onToolCallRejected?:
    | ((ctx: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly args: unknown;
        readonly rawArguments: string | null;
        /** True for calls issued by another tool (script sandbox); such calls
         *  must stay out of per-step bookkeeping such as the dedup ledger. */
        readonly nested?: boolean | undefined;
      }) => string | null | void | Promise<string | null | void>)
    | undefined;
  authorizeToolExecution?: AuthorizeToolExecutionHook | undefined;
  finalizeToolResult?: FinalizeToolResultHook | undefined;
  shouldContinueAfterStop?: ShouldContinueAfterStopHook | undefined;
}
