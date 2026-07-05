import {
  ErrorCodes,
  ScreamError,
  isScreamError,
  makeErrorPayload,
  toScreamErrorPayload,
} from '#/errors';
import {
  APIEmptyResponseError,
  isRetryableGenerateError,
  type GenerateResult,
  type Message,
  type TokenUsage,
  APIContextOverflowError,
} from '@scream-code/ltod';

import type { Agent } from '..';
import { isAbortError } from '../../loop/errors';
import {
  retryBackoffDelays,
  sleepForRetry,
} from '../../loop/retry';
import { renderPrompt } from '../../utils/render-prompt';
import {
  estimateTokens,
  estimateTokensForMessages,
} from '../../utils/tokens';
import { project } from '../context/projector';
import compactionInstructionTemplate from './compaction-instruction.md';
import compactionUpdateInstructionTemplate from './compaction-update-instruction.md';
import { renderMessagesToText } from './render-messages';
import type { CompactionBeginData, CompactionResult } from './types';
import { DEFAULT_COMPACTION_CONFIG, DefaultCompactionStrategy, type CompactionStrategy } from './strategy';
import { basename, dirname } from 'pathe';
import { parseMemoryMemos } from '@scream-code/memory';
import type { TodoItem } from '../../tools/builtin/state/todo-list';
import type { ContextMessage } from '../context/types';
import {
  createFileOps,
  extractFileOpsFromMessage,
  formatFileOperations,
  type FileOperations,
} from './file-operations';


export interface CompactedHistory {
  text: string;
}

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

/** Max recursion depth for re-summarize fallback. Each level halves the
 *  input, so depth 3 means we can compress a 8x-oversized input down to a
 *  single summary by chaining 2^3 = 8 partial summaries. */
const MAX_RE_SUMMARIZE_DEPTH = 3;

class TruncatedError extends Error {}

/**
 * Recursive re-summarize fallback for context overflow. When even the
 * minimum safe split still overflows the model (typically because a single
 * message contains a giant tool result), split the input in half at a safe
 * boundary, summarize each half, then concatenate the two partial summaries
 * and re-summarize them into one. If a half still overflows, recurse.
 *
 * The split uses `canSplitAfter` from the strategy to make sure each half
 * ends at a message boundary that doesn't orphan tool results. If no safe
 * split exists in the half (e.g. one giant message), feed it as-is to the
 * model and let the outer retry loop handle the overflow.
 */
async function summarizeWithFallback(
  messages: readonly ContextMessage[],
  summarizeOnce: (msgs: readonly ContextMessage[]) => Promise<{ summary: string; usage: TokenUsage | null }>,
  depth: number = 0,
): Promise<{ summary: string; usage: TokenUsage | null }> {
  if (messages.length <= 1) {
    // Can't split further — let the outer loop retry / fail.
    return summarizeOnce(messages);
  }

  // Find a safe split near the midpoint, biased toward the back half so
  // the second chunk tends to be smaller (more recent, denser content).
  let split = -1;
  const mid = Math.floor(messages.length / 2);
  for (let i = mid; i > 0; i--) {
    if (canSplitAfterContext(messages, i - 1)) {
      split = i;
      break;
    }
  }
  if (split === -1) {
    // No safe split forward from mid; try back half.
    for (let i = mid + 1; i < messages.length; i++) {
      if (canSplitAfterContext(messages, i - 1)) {
        split = i;
        break;
      }
    }
  }
  if (split === -1) {
    return summarizeOnce(messages);
  }

  const firstHalf = messages.slice(0, split);
  const secondHalf = messages.slice(split);

  // Summarize each half. If a half overflows, recurse on it — but only if
  // we haven't hit the depth cap. At the cap, let the overflow error bubble
  // so the outer retry loop can handle it (otherwise we'd loop forever
  // re-trying the same oversized half).
  const summarizeHalf = async (half: readonly ContextMessage[]): Promise<string> => {
    try {
      return (await summarizeOnce(half)).summary;
    } catch (error) {
      if (
        (error instanceof APIContextOverflowError || error instanceof TruncatedError) &&
        depth + 1 < MAX_RE_SUMMARIZE_DEPTH
      ) {
        const nested = await summarizeWithFallback(half, summarizeOnce, depth + 1);
        return nested.summary;
      }
      throw error;
    }
  };

  const firstSummary = await summarizeHalf(firstHalf);
  const secondSummary = await summarizeHalf(secondHalf);
  const merged = `${firstSummary}\n\n---\n\n${secondSummary}`;

  // Re-summarize the merged partial summaries into one final summary.
  // Wrap them in a minimal user message so the model sees a single chunk.
  const mergedMessage: ContextMessage = {
    role: 'user',
    content: [{ type: 'text', text: merged }],
    toolCalls: [],
  };
  return summarizeOnce([mergedMessage]);
}

/** Same split-safety rule as DefaultCompactionStrategy.canSplitAfter, but
 *  operates on ContextMessage (which carries toolCalls on assistant msgs). */
function canSplitAfterContext(messages: readonly ContextMessage[], index: number): boolean {
  const m = messages[index];
  if (m === undefined) return false;
  if (m.role === 'user') return false;
  if (m.role === 'assistant' && m.toolCalls.length > 0) return false;
  if (messages[index + 1]?.role === 'tool') return false;
  return true;
}

/** Max consecutive compaction failures before auto-compaction is
 *  disabled for the remainder of the turn. Resets each turn. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Minimal system prompt used during compaction. The full agent system
 *  prompt contains tool descriptions and runtime injections that contradict
 *  the compaction instruction ("DO NOT CALL ANY TOOLS"). This compact prompt
 *  keeps the LLM focused and explicitly references the memory-memo extraction
 *  section inside compaction-instruction.md. */
const COMPACTION_SYSTEM_PROMPT =
  'You are a conversation context compaction assistant. ' +
  'Your job is to summarize the conversation above into a structured summary. ' +
  'Output text only. DO NOT CALL ANY TOOLS. ' +
  'Follow the compaction instruction in the last user message exactly. ' +
  'Pay special attention to the Memory Memo Extraction section — ' +
  'you MUST output memory-memo blocks for every completed task loop.';

export class FullCompaction {
  protected compactionCountInTurn = 0;
  private consecutiveCompactionFailures = 0;
  private _shouldInjectSessionSummary = false;
  private compactionTimedOut = false;
  /** Token count below which compaction should not re-trigger. Set after a
   *  successful compaction to 110% of the post-compaction token count, so
   *  that a context sitting just above triggerRatio doesn't immediately
   *  re-trigger on every step. Reset each turn. */
  private lowWaterMark = 0;
  /** Whether a reactive (overflow-triggered) compaction has already been
   *  attempted this turn. Prevents the overflow → compact → still near
   *  limit → overflow → compact cycle from consuming the entire
   *  maxCompactionPerTurn budget with marginal savings. */
  private reactiveAttempted = false;
  protected compacting: {
    abortController: AbortController;
    promise: Promise<void>;
    blockedByTurn: boolean;
  } | null = null;
  protected _compactedHistory: CompactedHistory[] = [];
  protected readonly strategy: CompactionStrategy;

  constructor(
    protected readonly agent: Agent,
    strategy?: CompactionStrategy,
  ) {
    this.strategy =
      strategy ??
      new DefaultCompactionStrategy(
        () => agent.config.modelCapabilities.max_context_tokens,
        {
          ...DEFAULT_COMPACTION_CONFIG,
          reservedContextSize:
            agent.screamConfig?.loopControl?.reservedContextSize ??
            DEFAULT_COMPACTION_CONFIG.reservedContextSize,
          triggerRatio:
            agent.screamConfig?.loopControl?.compactionTriggerRatio ??
            DEFAULT_COMPACTION_CONFIG.triggerRatio,
        }
      );
  }

  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  get compactedHistory(): readonly CompactedHistory[] {
    return this._compactedHistory;
  }

  /** One-shot: true if session memory summary should be injected at the next step. */
  shouldInjectSessionSummary(): boolean {
    if (this._shouldInjectSessionSummary) {
      this._shouldInjectSessionSummary = false;
      return true;
    }
    return false;
  }

  begin(data: Readonly<CompactionBeginData>): void {
    if (this.compacting) return;
    if (data.source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    if (this.compactionCountInTurn > this.strategy.maxCompactionPerTurn) return;
    if (this.agent.records.restoring) {
      return;
    }
    const compactedCount = this.strategy.computeCompactCount(this.agent.context.history, data.source);
    if (compactedCount === 0) {
      throw new ScreamError(ErrorCodes.COMPACTION_UNABLE, 'No prefix that can be compacted in current history.');
    }
    this.agent.records.logRecord({
      type: 'full_compaction.begin',
      ...data,
    });
    this.startCompactionWorker(data, compactedCount);
  }

  private startCompactionWorker(
    data: Readonly<CompactionBeginData>,
    compactedCount: number,
  ): void {
    const abortController = new AbortController();
    this.agent.emitEvent({
      type: 'compaction.started',
      trigger: data.source,
      instruction: data.instruction,
    });
    const active = {
      abortController,
      promise: Promise.resolve(),
      blockedByTurn: false,
    };
    this.compacting = active;
    active.promise = this.compactionWorker(abortController.signal, data, compactedCount);
  }

  cancel(): void {
    this.markCanceled();
  }

  private markCanceled(reason?: string): void {
    if (!this.compacting) return;
    this.agent.records.logRecord({
      type: 'full_compaction.cancel',
    });
    this.compacting.abortController.abort();
    this.compacting = null;
    this.agent.emitEvent({ type: 'compaction.cancelled', reason });
  }

  markCompleted() {
    this.agent.records.logRecord({
      type: 'full_compaction.complete',
    });
    this.compacting = null;
    this._compactedHistory.push({
      text: renderMessagesToText(this.agent.context.history),
    });
  }

  private get tokenCountWithPending(): number {
    return this.agent.context.tokenCountWithPending;
  }

  resetForTurn(): void {
    this.compactionCountInTurn = 0;
    this.consecutiveCompactionFailures = 0;
    this.lowWaterMark = 0;
    this.reactiveAttempted = false;
  }

  async handleOverflowError(signal: AbortSignal, error: unknown) {
    if (this.reactiveAttempted) {
      throw error;
    }
    const didStartCompaction = this.beginAutoCompaction(false);
    if (!didStartCompaction && !this.compacting) {
      if (this.consecutiveCompactionFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.agent.emitEvent({
          type: 'warning',
          message: '压缩熔断器已打开，使用 /compact 手动重试。',
          code: 'compaction_circuit_open_overflow',
        });
      }
      throw error;
    }
    this.reactiveAttempted = true;
  }

  async beforeStep(signal: AbortSignal): Promise<void> {
    // Stage 1: Run micro compaction first (free, no LLM call).
    // detect() advances the internal cutoff when token usage >= 50%.
    this.agent.microCompaction.detect();

    // Stage 2: Check if full compaction is still needed, accounting for
    // the token savings micro compaction already provides.
    const effectiveTokens = this.effectiveTokenCount;

    const isReactiveTrigger = this.strategy.shouldCompact(effectiveTokens) &&
      effectiveTokens >= this.lowWaterMark;
    const isProactiveTrigger = !isReactiveTrigger &&
      this.strategy.shouldCompactProactively(
        effectiveTokens,
        this.estimatedMaxOutputTokens,
      );

    if (isReactiveTrigger) {
      this.checkAutoCompaction();
    } else if (isProactiveTrigger) {
      this.beginAutoCompaction();
    }

    // Stage 3: Block if we're past the blocking threshold.
    if (this.strategy.shouldBlock(effectiveTokens)) {
      await this.block(signal);
    }
  }

  /** Conservative estimate of max output tokens for one API call. */
  private get estimatedMaxOutputTokens(): number {
    const ctx = this.agent.config.modelCapabilities.max_context_tokens;
    // 5% of context window, bounded between 8K and 32K.
    // For 200K context: 10K; for 32K context: 8K; for 1M: 32K.
    if (ctx > 0) return Math.max(8192, Math.min(32768, Math.floor(ctx * 0.05)));
    return 16384; // unknown context window
  }

  /** Token count adjusted for micro compaction savings. */
  private get effectiveTokenCount(): number {
    const raw = this.tokenCountWithPending;
    const savings = this.agent.microCompaction.estimateSavings(
      this.agent.context.history,
    );
    return Math.max(0, raw - savings);
  }

  async afterStep(): Promise<void> {
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
    // Do not block after the step
  }

  private checkAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
    const effectiveTokens = this.effectiveTokenCount;
    if (!this.strategy.shouldCompact(effectiveTokens)) return false;
    if (effectiveTokens < this.lowWaterMark) return false;

    return this.beginAutoCompaction(throwOnLimit);
  }

  private beginAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
    if (this.consecutiveCompactionFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Circuit breaker open — auto compaction is disabled for this turn.
      // Manual /compact still works via begin() which bypasses this method.
      return false;
    }
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new ScreamError(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    this.begin({ source: 'auto', instruction: undefined });
    return this.compacting !== null;
  }

  private async block(signal: AbortSignal): Promise<void> {
    const active = this.compacting;
    if (!active) return;

    active.blockedByTurn = true;

    const BLOCK_TIMEOUT_MS = 60_000; // 60 seconds

    const timeoutId = setTimeout(() => {
      // Only cancel if this exact compaction is still the active one.
      // It may have completed between the timer firing and this callback
      // executing (race between microtask queue and timer queue).
      if (this.compacting === active) {
        this.compactionTimedOut = true;
        this.markCanceled(
          '压缩超时（60秒），已取消。请使用 /compact 手动重试。',
        );
      }
    }, BLOCK_TIMEOUT_MS);

    const onAbort = (): void => {
      clearTimeout(timeoutId);
      if (this.compacting === active) {
        this.cancel();
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    this.agent.emitEvent({
      type: 'compaction.blocked',
      turnId: this.agent.turn.currentId,
    });

    try {
      await active.promise;
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async compactionWorker(
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
    compactedCount: number,
  ): Promise<void> {
    const originalHistory = [...this.agent.context.history];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    const model = this.agent.config.model;
    // Detect a prior compaction summary at the head of history. If present,
    // use the iterative-update instruction so the LLM merges new content into
    // the existing summary instead of producing a fresh one from scratch.
    const previousSummary = extractPreviousSummary(originalHistory);
    const isUpdate = previousSummary !== null;
    let retryCount = 0;
    try {
      await this.triggerPreCompactHook(data, tokensBefore, signal);

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      const summarizeOnce = async (
        messagesToCompact: readonly ContextMessage[],
      ): Promise<{ summary: string; usage: TokenUsage | null }> => {
        const instruction = isUpdate
          ? COMPACTION_UPDATE_INSTRUCTION(data.instruction)
          : COMPACTION_INSTRUCTION(data.instruction);
        const messages = [
          ...project(messagesToCompact),
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: instruction,
              },
            ],
            toolCalls: [],
          } satisfies Message,
        ];
        const response = await this.agent.generate(
          this.agent.config.provider,
          COMPACTION_SYSTEM_PROMPT,
          [],
          messages,
          undefined,
          { signal },
        );
        if (response.finishReason === 'truncated') {
          throw new TruncatedError();
        }
        return {
          summary: extractCompactionSummary(response, model),
          usage: response.usage,
        };
      };

      let usage: TokenUsage | null;
      let summary: string;
      while (true) {
        const messagesToCompact = originalHistory.slice(0, compactedCount);
        try {
          const result = await summarizeOnce(messagesToCompact);
          usage = result.usage;
          summary = result.summary;
          break;
        } catch (error) {
          if (error instanceof APIContextOverflowError || error instanceof TruncatedError) {
            // Context overflow: shrink the input and retry. If we've already
            // shrunk to the minimum safe split, fall back to re-summarizing
            // the input in halves and merging — this handles the case where
            // a single oversized message (e.g. a huge tool result) makes
            // even the smallest split too large for the model.
            const reduced = this.strategy.reduceCompactOnOverflow(messagesToCompact);
            if (reduced < compactedCount) {
              compactedCount = reduced;
            } else {
              this.agent.log.warn('compaction overflow at minimum split, falling back to re-summarize', {
                compactedCount,
                tokensBefore: estimateTokensForMessages(messagesToCompact),
              });
              const result = await summarizeWithFallback(messagesToCompact, summarizeOnce);
              summary = result.summary;
              usage = result.usage;
              break;
            }
          }
          else if (!isRetryableGenerateError(error)) {
            throw error;
          }
          if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          await sleepForRetry(delays[retryCount]!, signal);
          retryCount += 1;
        }
      }

      if (usage !== null) {
        this.agent.usage.record(model, usage);
      }

      const newHistory = this.agent.context.history;
      for (let i = 0; i < originalHistory.length; i++) {
        if (newHistory[i] !== originalHistory[i]) {
          this.markCanceled('上下文已被更改（如 /revoke），压缩已取消');
          return undefined;
        }
      }

      const recent = originalHistory.slice(compactedCount);
      const messagesToCompactForOps = originalHistory.slice(0, compactedCount);
      const fileOps = createFileOps();
      for (const msg of messagesToCompactForOps) {
        extractFileOpsFromMessage(msg, fileOps);
      }
      const processedSummary = this.postProcessSummary(summary, fileOps);
      const tokensAfter = estimateTokens(processedSummary) + estimateTokensForMessages(recent);

      const result: CompactionResult = {
        summary: processedSummary,
        compactedCount,
        tokensBefore,
        tokensAfter,
        ...(isUpdate ? { isUpdate: true } : {}),
      };
      this.markCompleted();
      this.agent.emitEvent({ type: 'compaction.completed', result });
      this.agent.context.applyCompaction(result);
      // Set lowWaterMark AFTER applyCompaction so effectiveTokenCount reflects
      // the compressed context. 110% margin accounts for normal per-step token
      // growth that shouldn't count as "needing compaction again."
      this.lowWaterMark = Math.floor(this.effectiveTokenCount * 1.1);
      await this.extractAndStoreMemos(processedSummary);
      this.triggerPostCompactHook(data, result);

      // Compaction succeeded — reset circuit breaker
      this.consecutiveCompactionFailures = 0;
      this._shouldInjectSessionSummary = true;
    } catch (error) {
      const wasTimedOut = this.compactionTimedOut;
      this.compactionTimedOut = false;
      if (!isAbortError(error) || wasTimedOut) {
        const active = this.compacting;
        const blockedByTurn = active?.blockedByTurn === true;

        // Track consecutive failures for circuit breaker
        this.consecutiveCompactionFailures += 1;
        if (this.consecutiveCompactionFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.agent.emitEvent({
            type: 'warning',
            message:
              `压缩连续失败 ${String(this.consecutiveCompactionFailures)} 次，已自动暂停本回合的自动压缩。使用 /compact 手动重试。`,
            code: 'compaction_circuit_open',
          });
        }

        this.agent.log.error('compaction failed', {
          code: isScreamError(error) ? error.code : undefined,
          error,
          model,
          retryCount,
          compactedCount,
          tokensBefore,
        });
        this.markCanceled();
        if (!blockedByTurn) {
          const details: Record<string, unknown> = { model, retryCount };
          const payload =
            isScreamError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED
              ? toScreamErrorPayload(error)
              : makeErrorPayload(ErrorCodes.COMPACTION_FAILED, String(error), { details });
          this.agent.emitEvent({
            type: 'error',
            ...payload,
          });
        }
        if (blockedByTurn) {
          if (isScreamError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED) throw error;
          throw new ScreamError(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
        }
      }
    }
  }

  private async triggerPreCompactHook(
    data: Readonly<CompactionBeginData>,
    tokenCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.agent.hooks?.trigger('PreCompact', {
      matcherValue: data.source,
      signal,
      inputData: {
        trigger: data.source,
        tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  private triggerPostCompactHook(
    data: Readonly<CompactionBeginData>,
    result: CompactionResult,
  ): void {
    void this.agent.hooks?.fireAndForgetTrigger('PostCompact', {
      matcherValue: data.source,
      inputData: {
        trigger: data.source,
        estimatedTokenCount: result.tokensAfter,
      },
    });
  }

  /** Extract memory memos from compaction summary and store them. */
  private async extractAndStoreMemos(summary: string): Promise<void> {
    const memoStore = this.agent.memoStore;
    if (!memoStore) {
      this.agent.log.info('Memory memo store not available, skipping extraction');
      return;
    }

    this.agent.log.info('Scanning compaction summary for memory memos', {
      summaryLen: summary.length,
    });

    const memos = parseMemoryMemos(summary);
    this.agent.log.info('Memory memo parse result', {
      memoCount: memos.length,
    });

    if (memos.length === 0) return;

    // homedir = <projectDir>/<sessionId>/agents/<agentId>
    // sessionId is the second directory up from homedir
    const sessionId = this.agent.homedir
      ? basename(dirname(dirname(this.agent.homedir)))
      : 'unknown';

    const sessionTitle = await this.agent.getSessionTitle();

    const results = await Promise.allSettled(
      memos.map((memo) => {
        memo.sourceSessionId = sessionId;
        memo.sourceSessionTitle = sessionTitle ?? '';
        memo.projectDir = this.agent.config.cwd;
        return memoStore.append(memo);
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.agent.log.warn('Some memory memos failed to store from compaction', {
        failed,
        total: memos.length,
      });
    }

    this.agent.log.info('Extracted memory memos from compaction', {
      count: memos.length,
      sessionId,
    });
  }

  /**
   * Append the current todo list and file operations as markdown sections to
   * the compaction summary so active tasks and file context survive
   * compression. Without this, both are lost after compaction because the
   * original messages containing them are removed from the context window.
   */
  private postProcessSummary(summary: string, fileOps: FileOperations): string {
    const storeData = this.agent.tools.storeData();
    const todos = (storeData['todo'] as readonly TodoItem[] | undefined) ?? [];

    const sections: string[] = [summary.trim()];

    if (todos.length > 0) {
      const lines = todos.map((t) => {
        const marker = t.status === 'done' ? 'x' : t.status === 'in_progress' ? '-' : ' ';
        return `- [${marker}] ${t.title}`;
      });
      sections.push(['## TODO List', '', ...lines].join('\n'));
    }

    const filesSection = formatFileOperations(fileOps);
    if (filesSection.length > 0) sections.push(filesSection);

    return sections.join('\n\n');
  }
}
function extractCompactionSummary(response: GenerateResult, model: string): string {
  const summary =
    typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

  if (summary.trim().length === 0) {
    throw new APIEmptyResponseError(
      `The compaction response did not contain a non-empty summary. ` +
        `Model "${model}" returned empty content. ` +
        `Common causes: output token limit set too low, an incompatible model, ` +
        `or a provider/proxy that dropped the stream. ` +
        `Try /compact again, switch models, or check your provider configuration.`,
    );
  }
  return summary;
}

export const COMPACTION_INSTRUCTION = (customInstruction = ''): string =>
  renderPrompt(compactionInstructionTemplate, { customInstruction });

export const COMPACTION_UPDATE_INSTRUCTION = (customInstruction = ''): string =>
  renderPrompt(compactionUpdateInstructionTemplate, { customInstruction });

/**
 * If history starts with a compaction_summary message, return its text so the
 * next compaction can merge new content into it instead of starting fresh.
 * Returns null when no prior summary exists (first compaction in the session).
 */
function extractPreviousSummary(history: readonly ContextMessage[]): string | null {
  const head = history[0];
  if (head?.origin?.kind !== 'compaction_summary') return null;
  const text = head.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
  return text.length > 0 ? text : null;
}

