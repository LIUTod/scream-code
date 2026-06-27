/**
 * Ltod-backed implementation of the loop `LLM` interface.
 *
 * Bridges the new `loop/llm.ts` contract onto
 * the ltod `generate()` streaming API:
 *
 *   - ltod's per-part `onMessagePart` is forwarded to loop per-delta
 *     callbacks (`onTextDelta`, `onThinkDelta`, `onToolCallDelta`).
 *   - loop per-block callbacks (`onTextPart`, `onThinkPart`) only fire
 *     after the ltod stream drains, iterating over the merged
 *     `result.message.content`. Completed
 *     blocks land on the WAL seam, raw deltas never do.
 *   - ltod's finish reasons are preserved as provider diagnostics. The loop
 *     derives loop control from the normalized response shape, not from the
 *     provider's finish-reason spelling.
 */

import {
  emptyUsage,
  generate as ltodGenerate,
  type GenerateOptions,
  isRetryableGenerateError,
  type ChatProvider,
  type GenerateCallbacks,
  type Message,
  type ModelCapability,
  type StreamedMessagePart,
} from '@scream-code/ltod';

import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LLMRequestLogContext,
  LLMStreamTiming,
} from '../../loop';
import {
  deobfuscateToolCalls,
  obfuscateMessages,
  type SecretObfuscator,
} from '../secrets';
import {
  applyCompletionBudget,
  type CompletionBudgetConfig,
} from '../../utils/completion-budget';

export const GENERATE_REQUEST_LOG_CONTEXT = '__screamRequestLogContext';

export type GenerateOptionsWithRequestLog = GenerateOptions & {
  readonly [GENERATE_REQUEST_LOG_CONTEXT]?: LLMRequestLogContext;
};

export type GenerateFn = typeof ltodGenerate;

export interface LtodLLMConfig {
  readonly provider: ChatProvider;
  readonly modelName: string;
  readonly systemPrompt: string;
  readonly capability?: ModelCapability | undefined;
  /**
   * Optional override for the ltod `generate()` entry point. Lets the
   * agent host (and its test harness) inject a scripted generator without
   * having to substitute the entire LLM implementation.
   */
  readonly generate?: GenerateFn | undefined;
  /**
   * Completion budget config resolved from agent/provider settings. The
   * final cap is applied to each request.
   */
  readonly completionBudgetConfig?: CompletionBudgetConfig | undefined;
  readonly obfuscator?: SecretObfuscator | undefined;
}

export class LtodLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;

  private readonly provider: ChatProvider;
  private readonly generate: GenerateFn;
  private readonly completionBudgetConfig: CompletionBudgetConfig | undefined;
  private readonly obfuscator: SecretObfuscator | undefined;

  constructor(config: LtodLLMConfig) {
    this.provider = config.provider;
    this.modelName = config.modelName;
    this.systemPrompt = config.systemPrompt;
    this.capability = config.capability;
    this.generate = config.generate ?? ltodGenerate;
    this.completionBudgetConfig = config.completionBudgetConfig;
    this.obfuscator = config.obfuscator;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    let requestStartedAt = Date.now();
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    const markRequestStart = (): void => {
      requestStartedAt = Date.now();
    };
    const markStreamEnd = (): void => {
      streamEndedAt = Date.now();
    };
    const markStreamOutput = (): void => {
      firstChunkAt ??= Date.now();
    };
    const { callbacks, flushPending } = buildLtodCallbacks(
      params,
      markStreamOutput,
      this.obfuscator,
    );

    // Compute and apply the per-request completion budget against a
    // throwaway shallow clone. `effectiveProvider` is local to this call
    // and never written back to `this.provider`, so retries (handled at
    // a higher layer) keep using the same long-lived provider/client.
    const effectiveProvider = applyCompletionBudget({
      provider: this.provider,
      budget: this.completionBudgetConfig,
      capability: this.capability,
    });

    const outboundMessages =
      this.obfuscator && this.obfuscator.hasSecrets()
        ? obfuscateMessages(this.obfuscator, params.messages)
        : params.messages;

    const result = await this.generate(
      effectiveProvider,
      this.systemPrompt,
      [...params.tools],
      outboundMessages,
      callbacks,
      generateOptions(params, {
        onRequestStart: markRequestStart,
        onStreamEnd: () => {
          markStreamEnd();
          flushPending();
        },
      }),
    );

    // result.message stays in placeholder form so persisted assistant
    // messages carry `#XXXXXX#` tokens, not raw secrets. Deobfuscation
    // happens at two seams: streaming deltas (for TUI display) and
    // response.toolCalls (so tool execution gets real secret values).
    // Persisted assistant toolCalls carry real secrets (from deobfuscated
    // response.toolCalls), but obfuscateMessages re-obfuscates them on
    // the next outbound pass so the provider never sees them.

    // Replay merged content parts onto loop per-block callbacks after the
    // stream drained. This preserves WAL append order and stops partial
    // parts from landing if the upstream stream aborts mid-message.
    if (params.onTextPart !== undefined || params.onThinkPart !== undefined) {
      for (const part of result.message.content) {
        if (part.type === 'text' && params.onTextPart !== undefined) {
          await params.onTextPart(part);
        } else if (part.type === 'think' && params.onThinkPart !== undefined) {
          await params.onThinkPart(part);
        }
      }
    }

    const response: LLMChatResponse = {
      toolCalls:
        this.obfuscator && this.obfuscator.hasSecrets()
          ? deobfuscateToolCalls(this.obfuscator, result.message.toolCalls)
          : [...result.message.toolCalls],
      providerFinishReason: result.finishReason ?? undefined,
      rawFinishReason: result.rawFinishReason ?? undefined,
      usage: result.usage ?? emptyUsage(),
      streamTiming:
        firstChunkAt === undefined
          ? undefined
          : buildStreamTiming(requestStartedAt, firstChunkAt, streamEndedAt),
    };

    return response;
  }

  isRetryableError(error: unknown): boolean {
    return isRetryableGenerateError(error);
  }
}

function buildStreamTiming(
  requestStartedAt: number,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
): LLMStreamTiming {
  const outputEndedAt = streamEndedAt ?? Date.now();
  return {
    firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
}

function generateOptions(
  params: LLMChatParams,
  hooks: Pick<GenerateOptions, 'onRequestStart' | 'onStreamEnd'>,
): GenerateOptionsWithRequestLog {
  return {
    signal: params.signal,
    onRequestStart: hooks.onRequestStart,
    onStreamEnd: hooks.onStreamEnd,
    [GENERATE_REQUEST_LOG_CONTEXT]: params.requestLogContext,
  };
}

function buildLtodCallbacks(
  params: LLMChatParams,
  markStreamOutput: () => void,
  obfuscator?: SecretObfuscator,
): { callbacks: GenerateCallbacks; flushPending: () => void } {
  type ToolCallIdentity = { readonly toolCallId: string; readonly name: string };
  type BufferedToolCallDelta = { readonly argumentsPart?: string | undefined };

  const toolCallIdentities = new Map<number | string, ToolCallIdentity>();
  const pendingIndexedToolCallDeltas = new Map<number | string, BufferedToolCallDelta[]>();
  let lastToolCallIdentity: ToolCallIdentity | undefined;

  // Partial-placeholder buffers: when a delta ends with an incomplete
  // `#XXXXXX#` fragment, hold it back until the next delta completes (or
  // doesn't). Separate buffers per content type so interleaved text/think
  // deltas don't cross-contaminate. ToolCall argument deltas get a
  // per-toolCallId buffer so parallel tool calls don't cross-contaminate.
  let pendingTextTail = '';
  let pendingThinkTail = '';
  const pendingToolCallTails = new Map<string, string>();

  const PARTIAL_PLACEHOLDER_RE = /#[A-Z2-9]{0,6}$/;

  const deobfuscateWithBuffer = (
    text: string,
    setBuffer: (v: string) => void,
    getBuffer: () => string,
  ): string => {
    if (obfuscator === undefined || !obfuscator.hasSecrets()) {
      return getBuffer() + text;
    }
    const combined = getBuffer() + text;
    setBuffer('');
    const deobfuscated = obfuscator.deobfuscate(combined);
    const partialMatch = deobfuscated.match(PARTIAL_PLACEHOLDER_RE);
    if (partialMatch !== null && partialMatch[0].length > 0) {
      setBuffer(partialMatch[0]);
      return deobfuscated.slice(0, deobfuscated.length - partialMatch[0].length);
    }
    return deobfuscated;
  };

  const emitToolCallDelta = (delta: {
    toolCallId: string;
    name: string;
    argumentsPart?: string;
  }): void => {
    if (params.onToolCallDelta === undefined) return;
    if (delta.argumentsPart !== undefined) {
      const id = delta.toolCallId;
      const out = deobfuscateWithBuffer(
        delta.argumentsPart,
        (v) => pendingToolCallTails.set(id, v),
        () => pendingToolCallTails.get(id) ?? '',
      );
      if (out.length > 0) {
        delta = { ...delta, argumentsPart: out };
      } else {
        return;
      }
    }
    params.onToolCallDelta(delta);
  };

  return {
    callbacks: {
      onMessagePart: (part: StreamedMessagePart) => {
        markStreamOutput();
        if (part.type === 'text') {
          if (params.onTextDelta === undefined) return;
          const out = deobfuscateWithBuffer(
            part.text,
            (v) => { pendingTextTail = v; },
            () => pendingTextTail,
          );
          if (out.length > 0) params.onTextDelta(out);
          return;
        }
        if (part.type === 'think') {
          if (params.onThinkDelta === undefined) return;
          const out = deobfuscateWithBuffer(
            part.think,
            (v) => { pendingThinkTail = v; },
            () => pendingThinkTail,
          );
          if (out.length > 0) params.onThinkDelta(out);
          return;
        }
        if (part.type === 'function') {
          const identity = { toolCallId: part.id, name: part.name };
          lastToolCallIdentity = identity;
          if (part._streamIndex !== undefined) {
            toolCallIdentities.set(part._streamIndex, identity);
          }
          emitToolCallDelta({
            toolCallId: part.id,
            name: part.name,
            ...(part.arguments !== null ? { argumentsPart: part.arguments } : {}),
          });
          if (part._streamIndex !== undefined) {
            const pendingDeltas = pendingIndexedToolCallDeltas.get(part._streamIndex);
            if (pendingDeltas !== undefined) {
              pendingIndexedToolCallDeltas.delete(part._streamIndex);
              for (const delta of pendingDeltas) {
                emitToolCallDelta({
                  toolCallId: identity.toolCallId,
                  name: identity.name,
                  ...delta,
                });
              }
            }
          }
          return;
        }
        if (part.type === 'tool_call_part') {
          const argumentsPart = part.argumentsPart;
          const delta = argumentsPart !== null ? { argumentsPart } : {};
          if (part.index !== undefined) {
            const identity = toolCallIdentities.get(part.index);
            if (identity === undefined) {
              const pendingDeltas = pendingIndexedToolCallDeltas.get(part.index) ?? [];
              pendingDeltas.push(delta);
              pendingIndexedToolCallDeltas.set(part.index, pendingDeltas);
              return;
            }
            emitToolCallDelta({
              toolCallId: identity.toolCallId,
              name: identity.name,
              ...delta,
            });
            return;
          }
          const identity = lastToolCallIdentity;
          if (identity === undefined) return;
          emitToolCallDelta({
            toolCallId: identity.toolCallId,
            name: identity.name,
            ...delta,
          });
        }
      },
    },
    flushPending: () => {
      if (pendingTextTail.length > 0 && params.onTextDelta !== undefined) {
        params.onTextDelta(pendingTextTail);
        pendingTextTail = '';
      }
      if (pendingThinkTail.length > 0 && params.onThinkDelta !== undefined) {
        params.onThinkDelta(pendingThinkTail);
        pendingThinkTail = '';
      }
      if (params.onToolCallDelta !== undefined) {
        for (const [id, tail] of pendingToolCallTails) {
          if (tail.length > 0) {
            params.onToolCallDelta({ toolCallId: id, name: '', argumentsPart: tail });
          }
        }
        pendingToolCallTails.clear();
      }
    },
  };
}

export function buildMessagesWithSystem(systemPrompt: string, history: Message[]): Message[] {
  return [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }], toolCalls: [] },
    ...history,
  ];
}
