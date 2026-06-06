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
} from '@scream-cli/ltod';

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
import { renderMessagesToText } from './render-messages';
import type { CompactionBeginData, CompactionResult } from './types';
import { DEFAULT_COMPACTION_CONFIG, DefaultCompactionStrategy, type CompactionStrategy } from './strategy';
import { basename, dirname } from 'pathe';
import { parseMemoryMemos } from '@scream-code/memory';
import type { TodoItem } from '../../tools/builtin/state/todo-list';

type CompactionTelemetryTrigger = CompactionBeginData['source'] | 'manual-with-prompt' | 'unknown';

export interface CompactedHistory {
  text: string;
}

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

/** Max consecutive compaction failures before auto-compaction is
 *  disabled for the remainder of the turn. Resets each turn. */
const MAX_CONSECUTIVE_FAILURES = 3;

export class FullCompaction {
  protected compactionCountInTurn = 0;
  private consecutiveCompactionFailures = 0;
  protected compacting: {
    abortController: AbortController;
    startedAt: number;
    telemetryTrigger: CompactionTelemetryTrigger;
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
      startedAt: Date.now(),
      telemetryTrigger: compactionTelemetryTrigger(data.source, data.instruction),
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
  }

  async handleOverflowError(signal: AbortSignal, error: unknown) {
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) throw error;
    // Always block on overflow errors
    await this.block(signal);
  }

  async beforeStep(signal: AbortSignal): Promise<void> {
    // Stage 1: Run micro compaction first (free, no LLM call).
    // detect() advances the internal cutoff when token usage >= 50%.
    this.agent.microCompaction.detect();

    // Stage 2: Check if full compaction is still needed, accounting for
    // the token savings micro compaction already provides.
    const effectiveTokens = this.effectiveTokenCount;

    // Stage 2a: Proactive check — will the NEXT step overflow?
    // Estimate worst-case token growth before the API call so we can
    // compact BEFORE hitting a 413, not after.
    const shouldCompact =
      this.strategy.shouldCompact(effectiveTokens) ||
      this.strategy.shouldCompactProactively(
        effectiveTokens,
        this.estimatedMaxOutputTokens,
      );

    if (shouldCompact) {
      this.checkAutoCompaction();
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
    if (!this.strategy.shouldCompact(this.tokenCountWithPending)) return false;

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
    initialCompactedCount: number,
  ): Promise<void> {
    const startedAt = Date.now();
    const originalHistory = [...this.agent.context.history];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;
    try {
      let compactedCount = initialCompactedCount;

      await this.triggerPreCompactHook(data, tokensBefore, signal);

      const model = this.agent.config.model;

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let usage: TokenUsage | null;
      let summary: string;
      while (true) {
        const messagesToCompact = originalHistory.slice(0, compactedCount);
        const messages = [
          ...project(messagesToCompact),
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: COMPACTION_INSTRUCTION(data.instruction),
              },
            ],
            toolCalls: [],
          } satisfies Message,
        ];
        class TruncatedError extends Error {}
        try {
          const response = await this.agent.generate(
            this.agent.config.provider,
            this.agent.config.systemPrompt,
            [],
            messages,
            undefined,
            { signal },
          );
          if (response.finishReason === 'truncated') {
            throw new TruncatedError();
          }
          usage = response.usage;
          summary = extractCompactionSummary(response);
          summary = this.postProcessSummary(summary);
          break;
        } catch (error) {
          if (error instanceof APIContextOverflowError || error instanceof TruncatedError) {
            compactedCount = this.strategy.reduceCompactOnOverflow(messagesToCompact);
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
      const tokensAfter = estimateTokens(summary) + estimateTokensForMessages(recent);

      const result: CompactionResult = {
        summary,
        compactedCount,
        tokensBefore,
        tokensAfter,
      };

      const active = this.compacting!;
      this.agent.telemetry.track('compaction_finished', {
        trigger_type: active.telemetryTrigger,
        before_tokens: result.tokensBefore,
        after_tokens: result.tokensAfter,
        duration_ms: Date.now() - active.startedAt,
        compacted_count: result.compactedCount,
        retry_count: retryCount,
        ...usage,
      });
      this.markCompleted();
      this.agent.emitEvent({ type: 'compaction.completed', result });
      this.agent.context.applyCompaction(result);
      this.extractAndStoreMemos(summary);
      this.triggerPostCompactHook(data, result);

      // Compaction succeeded — reset circuit breaker
      this.consecutiveCompactionFailures = 0;
    } catch (error) {
      if (!isAbortError(error)) {
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
        });
        this.markCanceled();
        if (!blockedByTurn) {
          const payload =
            isScreamError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED
              ? toScreamErrorPayload(error)
              : makeErrorPayload(ErrorCodes.COMPACTION_FAILED, String(error));
          this.agent.emitEvent({
            type: 'error',
            ...payload,
          });
        }
        this.agent.telemetry.track('compaction_failed', {
          trigger_type: compactionTelemetryTrigger(data.source, data.instruction),
          before_tokens: tokensBefore,
          duration_ms: Date.now() - startedAt,
          retry_count: retryCount,
          error_type: error instanceof Error ? error.name : 'Unknown',
        });
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
  private extractAndStoreMemos(summary: string): void {
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

    for (const memo of memos) {
      memo.sourceSessionId = sessionId;
      memo.sourceSessionTitle = '';
      void memoStore.append(memo).catch((error: unknown) => {
        this.agent.log.warn('Failed to store memory memo from compaction', {
          memoId: memo.id,
          error: String(error),
        });
      });
    }

    this.agent.log.info('Extracted memory memos from compaction', {
      count: memos.length,
      sessionId,
    });
  }

  /**
   * Append the current todo list as a markdown section to the compaction
   * summary so active tasks survive compression. This mirrors kimi-code's
   * approach: without it, the todo list is lost after compaction because
   * the original messages containing it are removed from the context window.
   */
  private postProcessSummary(summary: string): string {
    const storeData = this.agent.tools.storeData();
    const todos = (storeData['todo'] as readonly TodoItem[] | undefined) ?? [];
    if (todos.length === 0) return summary;

    const lines = todos.map((t) => {
      const marker = t.status === 'done' ? 'x' : t.status === 'in_progress' ? '-' : ' ';
      return `- [${marker}] ${t.title}`;
    });
    const todoMarkdown = ['## TODO List', '', ...lines].join('\n');
    return `${summary.trim()}\n\n${todoMarkdown}`;
  }
}

function extractCompactionSummary(response: GenerateResult): string {
  const summary =
    typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

  if (summary.trim().length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }
  return summary;
}

export const COMPACTION_INSTRUCTION = (customInstruction = ''): string =>
  renderPrompt(compactionInstructionTemplate, { customInstruction });

function compactionTelemetryTrigger(
  trigger: CompactionBeginData['source'] | undefined,
  instruction: string | undefined,
): CompactionTelemetryTrigger {
  if (trigger === undefined) return 'unknown';
  if (trigger === 'manual' && instruction !== undefined && instruction.length > 0) {
    return 'manual-with-prompt';
  }
  return trigger;
}
