/**
 * Executes one provider step.
 *
 * A step owns the provider call, atomic transcript envelope, streaming callback
 * wiring, tool-call lifecycle, and post-step hooks. Provider usage is recorded
 * immediately after `llm.chat` returns so a later abort during tool execution
 * does not lose model usage that was already spent.
 */

import { randomUUID } from 'node:crypto';

import { isImageFormatError, isRecoverableRequestStructureError, isRequestTooLargeError, type TokenUsage } from '@scream-code/ltod';
import type { Logger } from '#/logging/types';

import type { LoopEventDispatcher } from './events';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';
import { degradeMedia, stripMedia } from './media-projection';
import { chatWithRetry } from './retry';
import { recordUnexecutedToolCalls, runToolCallBatch, type ToolCallStepContext } from './tool-call';
import type { ExecutableTool, LoopHooks, LoopMessageBuilder, LoopStepStopReason, MediaProjectionState, RecordStepUsageResult } from './types';

type ChatStreamingCallbacks = Pick<
  LLMChatParams,
  'onTextDelta' | 'onThinkDelta' | 'onToolCallDelta' | 'onTextPart' | 'onThinkPart'
>;

export interface ExecuteLoopStepDeps {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly buildMessages: LoopMessageBuilder;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly tools?: readonly ExecutableTool[] | undefined;
  /**
   * Per-step tool table builder. When present it wins over `tools` and is
   * re-invoked before every step, so a tool loaded mid-turn is dispatchable
   * on the very next step and runtime tool visibility stays fresh.
   */
  readonly buildTools?: (() => readonly ExecutableTool[]) | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly currentStep: number;
  readonly maxRetryAttempts?: number;
  readonly recordUsage:
    (usage: TokenUsage) => RecordStepUsageResult | void | Promise<RecordStepUsageResult | void>;
  readonly hasPendingSteer?: (() => boolean) | undefined;
  readonly mediaProjection?: MediaProjectionState | undefined;
  /**
   * Crash-recovery draft sink: receives throttled full snapshots of the
   * in-flight stream (and an empty pair to clear once real parts land).
   * Implementations write a `context.stream_draft` wire record directly.
   */
  readonly onStreamingDraft?: ((text: string, think: string) => void) | undefined;
}

export async function executeLoopStep(deps: ExecuteLoopStepDeps): Promise<{
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
  /** Tool calls rejected during preflight in this step (unknown tool / malformed args). */
  readonly rejectedCalls: number;
  /** Total tool calls in this step's response. */
  readonly totalCalls: number;
}> {
  const {
    turnId,
    signal,
    buildMessages,
    dispatchEvent,
    llm,
    tools,
    buildTools,
    hooks,
    log,
    currentStep,
    maxRetryAttempts,
    recordUsage,
    mediaProjection,
  } = deps;

  if (hooks?.beforeStep !== undefined) {
    const beforeStep = await hooks.beforeStep({
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    if (beforeStep?.block === true) {
      throw new Error(beforeStep.reason ?? `Step ${String(currentStep)} was blocked`);
    }
  }

  signal.throwIfAborted();

  // Resolve the tool table AFTER beforeStep so it reflects the same state as
  // the messages built below (beforeStep can run compaction, which discards
  // loaded dynamic tool schemas). buildTools wins over the static snapshot.
  const effectiveTools = buildTools !== undefined ? buildTools() : tools;

  const messages = await buildMessages();
  signal.throwIfAborted();

  const stepUuid = randomUUID();

  const step: ToolCallStepContext = {
    tools: effectiveTools,
    hooks,
    log,
    dispatchEvent,
    llm,
    signal,
    turnId,
    currentStep,
    stepUuid,
    hasPendingSteer: deps.hasPendingSteer,
  };

  await dispatchEvent({
    type: 'step.begin',
    uuid: stepUuid,
    turnId,
    step: currentStep,
  });

  // Apply sticky media projection from a previous step's recovery (so the
  // same degradation is used without a wasted failed request per step).
  let effectiveMessages = messages;
  if (mediaProjection?.mode === 'degraded') {
    effectiveMessages = degradeMedia(messages);
  } else if (mediaProjection?.mode === 'stripped') {
    effectiveMessages = stripMedia(messages);
  }

  const chatParams: LLMChatParams = {
    messages: effectiveMessages,
    tools: effectiveTools ?? [],
    signal,
    ...createChatStreamingCallbacks({
      dispatchEvent,
      turnId,
      currentStep,
      stepUuid,
      onStreamingDraft: deps.onStreamingDraft ?? (() => {}),
    }),
  };

  let response: LLMChatResponse;
  try {
    response = await chatWithRetry({
      llm,
      params: chatParams,
      dispatchEvent,
      turnId,
      currentStep,
      stepUuid,
      maxAttempts: maxRetryAttempts,
      log,
    });
  } catch (error) {
    // Media degradation recovery: if the provider rejects the request
    // because of media (too large or bad format), transform the messages
    // and retry once. The sticky `mediaProjection` state ensures
    // subsequent steps in the same turn use the degraded projection
    // directly without re-failing.
    if (mediaProjection !== undefined && !signal.aborted) {
      if (
        isRequestTooLargeError(error) &&
        mediaProjection.mode !== 'degraded' &&
        mediaProjection.mode !== 'stripped'
      ) {
        mediaProjection.mode = 'degraded';
        effectiveMessages = degradeMedia(messages);
        log?.warn('request too large - retrying with media degraded');
        response = await chatWithRetry({
          llm,
          params: { ...chatParams, messages: effectiveMessages },
          dispatchEvent,
          turnId,
          currentStep,
          stepUuid,
          maxAttempts: maxRetryAttempts,
          log,
        });
      } else if (
        isRequestTooLargeError(error) &&
        mediaProjection.mode === 'degraded'
      ) {
        mediaProjection.mode = 'stripped';
        effectiveMessages = stripMedia(messages);
        log?.warn('request still too large with degraded media - retrying with all media stripped');
        response = await chatWithRetry({
          llm,
          params: { ...chatParams, messages: effectiveMessages },
          dispatchEvent,
          turnId,
          currentStep,
          stepUuid,
          maxAttempts: maxRetryAttempts,
          log,
        });
      } else if (
        isImageFormatError(error) &&
        mediaProjection.mode !== 'stripped'
      ) {
        mediaProjection.mode = 'stripped';
        effectiveMessages = stripMedia(messages);
        log?.warn('image format error - retrying with all media stripped');
        response = await chatWithRetry({
          llm,
          params: { ...chatParams, messages: effectiveMessages },
          dispatchEvent,
          turnId,
          currentStep,
          stepUuid,
          maxAttempts: maxRetryAttempts,
          log,
        });
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }
  const usage = response.usage;
  const usageResult = await recordUsage(usage);
  const stopTurnAfterUsage = usageResult?.stopTurn === true;
  const stopReason = deriveStepStopReason(response);

  // Execute tools only when the normalized response shape represents a tool
  // step. Provider terminal diagnostics such as filtering or truncation must
  // not trigger side-effecting tool execution even if a malformed response also
  // contains tool calls.
  let effectiveStopReason: LoopStepStopReason =
    stopTurnAfterUsage && stopReason === 'tool_use' ? 'end_turn' : stopReason;
  let rejectedCalls = 0;
  let totalCalls = 0;
  if (effectiveStopReason === 'tool_use') {
    const toolBatch = await runToolCallBatch(step, response);
    rejectedCalls = toolBatch.rejectedCount;
    totalCalls = toolBatch.totalCalls;
    if (toolBatch.stopTurn) effectiveStopReason = 'end_turn';
  } else if (
    (stopReason === 'paused' || stopReason === 'unknown' || stopReason === 'max_tokens') &&
    response.toolCalls.length > 0
  ) {
    // The provider stream broke off (paused / overloaded / token limit) while
    // the response still carries tool calls - possibly cut off mid-arguments.
    // Record each call and close it with a synthetic interrupted result:
    // dropping them would lose the model's intent and can persist an
    // assistant message strict providers reject as empty.
    await recordUnexecutedToolCalls(step, response);
  }

  // When a tool batch runs, it drains paired `tool.result` events even when
  // cancellation is requested. Check the signal here before sealing the step.
  signal.throwIfAborted();

  await dispatchEvent({
    type: 'step.end',
    uuid: stepUuid,
    turnId,
    step: currentStep,
    usage,
    finishReason: effectiveStopReason,
    llmFirstTokenLatencyMs: response.streamTiming?.firstTokenLatencyMs,
    llmStreamDurationMs: response.streamTiming?.streamDurationMs,
    reportedModel: response.model,
    ...stepEndProviderDiagnostics(response, effectiveStopReason),
  });

  let stopTurnAfterStep = stopTurnAfterUsage;
  if (hooks?.afterStep !== undefined) {
    try {
      const afterStep = await hooks.afterStep({
        turnId,
        stepNumber: currentStep,
        usage,
        stopReason: effectiveStopReason,
        signal,
        llm,
      });
      stopTurnAfterStep = stopTurnAfterStep || afterStep?.stopTurn === true;
    } catch {
      // The step is already sealed; observer hooks cannot change the result.
    }
  }

  return {
    usage,
    stopReason:
      stopTurnAfterStep && effectiveStopReason === 'tool_use' ? 'end_turn' : effectiveStopReason,
    rejectedCalls,
    totalCalls,
  };
}

function deriveStepStopReason(response: LLMChatResponse): LoopStepStopReason {
  switch (response.providerFinishReason) {
    case 'truncated':
      return 'max_tokens';
    case 'filtered':
      return 'filtered';
    case 'paused':
      return 'paused';
    case 'other':
      return 'unknown';
    case 'completed':
    case undefined:
      return response.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      return response.toolCalls.length > 0 ? 'tool_use' : 'unknown';
    default: {
      const _exhaustive: never = response.providerFinishReason;
      return _exhaustive;
    }
  }
}

function stepEndProviderDiagnostics(
  response: LLMChatResponse,
  stopReason: LoopStepStopReason,
): Pick<LLMChatResponse, 'providerFinishReason' | 'rawFinishReason'> {
  const providerFinishReason = response.providerFinishReason;
  if (
    (providerFinishReason === 'completed' && stopReason === 'end_turn') ||
    (providerFinishReason === 'tool_calls' && stopReason === 'tool_use')
  ) {
    return {};
  }

  return {
    ...(providerFinishReason !== undefined ? { providerFinishReason } : {}),
    ...(response.rawFinishReason !== undefined
      ? { rawFinishReason: response.rawFinishReason }
      : {}),
  };
}

/**
 * Accumulates the in-flight stream for the crash-recovery draft and flushes
 * it through `onDraft` at most once per 1.5s or 4k new characters, so a fast
 * stream does not write the wire on every delta while a slow stream still
 * checkpoints promptly. Failures in the sink never break the stream.
 */
export class StreamDraftTracker {
  private text = '';
  private think = '';
  private charsSinceFlush = 0;
  private lastFlushAt = Date.now();
  private wireHasDraft = false;

  constructor(private readonly onDraft: (text: string, think: string) => void) {}

  onText(delta: string): void {
    this.text += delta;
    this.charsSinceFlush += delta.length;
    this.maybeFlush();
  }

  onThink(delta: string): void {
    this.think += delta;
    this.charsSinceFlush += delta.length;
    this.maybeFlush();
  }

  /**
   * Real content parts are landing: drop the draft (persisted as empty) — but
   * only if the wire actually carries one. A stream that finished before any
   * draft flush (fast mock streams, short replies) must not pollute the wire
   * with an empty clear record.
   */
  clear(): void {
    if (!this.wireHasDraft) return;
    this.text = '';
    this.think = '';
    this.charsSinceFlush = 0;
    this.flush();
  }

  private maybeFlush(): void {
    if (Date.now() - this.lastFlushAt < DRAFT_FLUSH_INTERVAL_MS && this.charsSinceFlush < DRAFT_FLUSH_MIN_CHARS) {
      return;
    }
    this.flush();
  }

  private flush(): void {
    this.lastFlushAt = Date.now();
    this.charsSinceFlush = 0;
    try {
      this.onDraft(this.text, this.think);
      this.wireHasDraft = this.text.length > 0 || this.think.length > 0;
    } catch {
      // Drafting is best-effort; never break the stream over it.
    }
  }
}

const DRAFT_FLUSH_INTERVAL_MS = 1_500;
const DRAFT_FLUSH_MIN_CHARS = 4_096;

// Exported for tests: the streaming-callback wiring (draft clear semantics).
export function createChatStreamingCallbacks(deps: {
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  /**
   * Throttled full snapshot of the in-flight stream so a process that dies
   * mid-turn still leaves the generated text on the wire. Cleared (empty
   * strings) right before the first real content part lands, because parts
   * only dispatch after the provider stream drains (ltod-llm.ts) and the
   * persisted record must never contradict what restore replays.
   */
  readonly onStreamingDraft: (text: string, think: string) => void;
}): ChatStreamingCallbacks {
  const { dispatchEvent, turnId, currentStep, stepUuid, onStreamingDraft } = deps;
  let textIndex = 0;
  let thinkIndex = 0;
  const draftTracker = new StreamDraftTracker(onStreamingDraft);

  return {
    onTextDelta: (delta) => {
      draftTracker.onText(delta);
      dispatchEvent({ type: 'text.delta', delta });
    },
    onThinkDelta: (delta) => {
      draftTracker.onThink(delta);
      dispatchEvent({ type: 'thinking.delta', delta });
    },
    onToolCallDelta: (delta) => {
      dispatchEvent({
        type: 'tool.call.delta',
        toolCallId: delta.toolCallId,
        name: delta.name,
        argumentsPart: delta.argumentsPart,
      });
    },
    onTextPart: async (part) => {
      const index = textIndex++;
      // First real part is landing: drop the draft so a restore never shows
      // both the partial draft and the persisted message.
      draftTracker.clear();
      await dispatchEvent({
        type: 'block.start',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        index,
        blockType: 'text',
      });
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
      await dispatchEvent({
        type: 'block.end',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        index,
        blockType: 'text',
      });
    },
    onThinkPart: async (part) => {
      const index = thinkIndex++;
      // Mirror onTextPart: the think draft (if any) must leave the wire once
      // its real part lands. Without this, a long-thinking tool step leaves
      // a stale draft that a later short text step cannot clear (its own
      // tracker never flushed), and a completed turn would restore with a
      // false "reply incomplete" marker.
      draftTracker.clear();
      await dispatchEvent({
        type: 'block.start',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        index,
        blockType: 'thinking',
      });
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
      await dispatchEvent({
        type: 'block.end',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        index,
        blockType: 'thinking',
      });
    },
  };
}
