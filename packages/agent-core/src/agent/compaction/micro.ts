import type { ContentPart } from '@scream-code/ltod';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import { flags } from '../../flags';
import { estimateTokens, estimateTokensForMessages } from '../../utils/tokens';

export interface MicroCompactionConfig {
  /** Number of most recent messages to always keep untouched. */
  keepRecentMessages: number;
  /** Token budget for the recent window. If the trailing N messages exceed
   *  this many tokens, the cutoff moves further back until the window fits,
   *  so a few giant tool results can't pin the cutoff behind them and starve
   *  the prefix of reclaimable content. */
  keepRecentTokens: number;
  /** Only advance the cutoff if doing so reclaims at least this many tokens.
   *  Stops micro-compaction from churning the prefix when there's nothing
   *  left to gain (e.g. all old tool results already elided). */
  pruneMinReclaimTokens: number;
  /** Only truncate tool results with at least this many tokens. */
  minContentTokens: number;
  /** Minimum context usage ratio (0-1) before micro-compaction triggers. */
  minContextUsageRatio: number;
  /** Placeholder text for truncated tool results. */
  truncatedMarker: string;
  /** Placeholder text for tool results explicitly marked useless. */
  uselessMarker: string;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  keepRecentTokens: 40_000,
  pruneMinReclaimTokens: 20_000,
  minContentTokens: 100,
  minContextUsageRatio: 0.5,
  truncatedMarker: '[Old tool result content cleared]',
  uselessMarker: '[Uneventful result elided]',
};

/**
 * Compute the cutoff index: everything at index < cutoff is eligible for
 * truncation. The default floor is `keepRecentMessages` (the message-count
 * protection window). But if the trailing window exceeds `keepRecentTokens`,
 * the cutoff walks forward (toward the tail) until the window fits — so a
 * few giant tool results can't pin the cutoff behind them and starve the
 * prefix of reclaimable content.
 */
function computeCutoff(
  messages: readonly ContextMessage[],
  config: MicroCompactionConfig,
): number {
  const messageFloor = Math.max(0, messages.length - config.keepRecentMessages);
  // Walk forward from the floor while the trailing window is over budget.
  // Accumulate tokens from the cutoff position toward the tail so we don't
  // re-walk the whole suffix on every step.
  let windowTokens = estimateTokensForMessages(messages.slice(messageFloor));
  let cutoff = messageFloor;
  while (cutoff < messages.length && windowTokens > config.keepRecentTokens) {
    const removed = messages[cutoff]!;
    windowTokens -= estimateTokensForMessages([removed]);
    cutoff += 1;
  }
  return cutoff;
}

/**
 * Walk the message list and find Read tool calls whose file paths were
 * superseded by a later Read of the same path. Returns a map from the
 * superseded tool call's ID to the file path (for the marker text).
 *
 * Only considers tool results before the cutoff line — newer reads are
 * protected and their results are kept verbatim.
 */
function findSupersededPaths(
  messages: readonly ContextMessage[],
  cutoff: number,
): Map<string, string> {
  const superseded = new Map<string, string>();
  const readCalls = new Map<string, { filePath: string; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;

    if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        if (
          tc.name === 'Read' &&
          tc.id !== undefined &&
          tc.arguments !== undefined
        ) {
          const filePath = (
            typeof tc.arguments === 'object' && tc.arguments !== null
              ? (tc.arguments as Record<string, unknown>)['file_path']
              : undefined
          ) as string | undefined;
          if (filePath !== undefined) {
            for (const [prevId, prev] of readCalls) {
              if (prev.filePath === filePath && prev.index < cutoff) {
                superseded.set(prevId, filePath);
              }
            }
            readCalls.set(tc.id, { filePath, index: i });
          }
        }
      }
    }
  }

  return superseded;
}

/**
 * Lightweight compaction that truncates old tool results without an LLM call.
 *
 * When the context window is filling up (>= 50% by default), old tool result
 * messages are replaced with a short placeholder. This frees up tokens for the
 * model without the cost and latency of a full compaction.
 *
 * Triggered automatically during context construction via {@link compact}.
 */
export class MicroCompaction {
  private cutoff = 0;
  readonly config: MicroCompactionConfig;

  constructor(
    public readonly agent: Agent,
    config?: Partial<MicroCompactionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Reset the internal cutoff line (e.g. after a full compaction). */
  reset(): void {
    this.cutoff = 0;
  }

  /** Advance the cutoff line and log the change. */
  private apply(cutoff: number): void {
    this.agent.records.logRecord({
      type: 'micro_compaction.apply',
      cutoff,
    } as Record<string, unknown> as never);
    this.cutoff = cutoff;
  }

  /** Check whether micro-compaction is warranted and advance the cutoff. */
  detect(): void {
    if (!flags.enabled('micro-compaction')) return;
    const config = this.config;
    const { history } = this.agent.context;
    const maxContextTokens = this.agent.config.modelCapabilities.max_context_tokens;
    const contextTokens = this.agent.context.tokenCountWithPending;
    const contextUsageRatio =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : 0;
    if (contextUsageRatio < config.minContextUsageRatio) return;

    const nextCutoff = computeCutoff(history, config);
    // Idempotent: don't move the cutoff if it's already at or past the
    // computed position. Re-running detect() in a single turn (full.ts
    // beforeStep + context.messages) should not churn the record log or
    // re-truncate already-truncated content.
    if (nextCutoff <= this.cutoff) return;

    // Gate: only advance when there's something to gain. If the new cutoff
    // would reclaim fewer than pruneMinReclaimTokens, the prefix is already
    // mostly markers — leave it alone and let full compaction take over.
    const { beforeTokens, afterTokens } = this.measureEffect(history, nextCutoff);
    if (beforeTokens - afterTokens < config.pruneMinReclaimTokens) return;

    this.apply(nextCutoff);
  }

  /**
   * Apply micro-compaction to a message list: replace old tool results
   * before the cutoff line with truncated markers. Read results for files
   * that were re-read later get a supersede marker so the model knows
   * the old content is stale. Tool results explicitly marked useless are
   * elided with a short notice regardless of size, since they carry no
   * actionable information.
   */
  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    const config = this.config;
    const superseded = findSupersededPaths(messages, this.cutoff);
    const result: ContextMessage[] = [];
    let i = 0;
    for (const msg of messages) {
      const isUseless =
        i < this.cutoff &&
        msg.role === 'tool' &&
        msg.toolCallId !== undefined &&
        msg.useless === true;
      const isOversizedTruncatable =
        i < this.cutoff &&
        msg.role === 'tool' &&
        msg.toolCallId !== undefined &&
        estimateTokensForMessages([msg]) >= config.minContentTokens;
      if (isUseless) {
        result.push({
          ...msg,
          content: [{ type: 'text', text: config.uselessMarker } as ContentPart],
        } as ContextMessage);
      } else if (isOversizedTruncatable) {
        const marker =
          msg.toolCallId !== undefined && superseded.has(msg.toolCallId)
            ? `[Superseded by a newer read of ${superseded.get(msg.toolCallId)}]`
            : config.truncatedMarker;
        result.push({
          ...msg,
          content: [{ type: 'text', text: marker } as ContentPart],
        } as ContextMessage);
      } else {
        result.push(msg);
      }
      i++;
    }
    return result;
  }

  /**
   * Estimate how many tokens micro-compaction would save at the current
   * cutoff. Used by the unified compaction pipeline so Full can decide
   * whether it still needs to run after Micro has been applied.
   */
  estimateSavings(messages: readonly ContextMessage[]): number {
    const { beforeTokens, afterTokens } = this.measureEffect(messages, this.cutoff);
    return beforeTokens - afterTokens;
  }

  private measureEffect(
    messages: readonly ContextMessage[],
    cutoff: number,
  ): { truncatedToolResultCount: number; beforeTokens: number; afterTokens: number } {
    let markerTokenCount: number | undefined;
    let uselessMarkerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let beforeTokens = 0;
    let afterTokens = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForMessages([message]);
      const isUseless = message.useless === true;
      if (!isUseless && contentTokens < this.config.minContentTokens) continue;

      if (isUseless) {
        uselessMarkerTokenCount ??= estimateTokens(this.config.uselessMarker);
        truncatedToolResultCount += 1;
        beforeTokens += contentTokens;
        afterTokens += uselessMarkerTokenCount;
      } else {
        markerTokenCount ??= estimateTokens(this.config.truncatedMarker);
        truncatedToolResultCount += 1;
        beforeTokens += contentTokens;
        afterTokens += markerTokenCount;
      }
    }
    return { truncatedToolResultCount, beforeTokens, afterTokens };
  }
}
