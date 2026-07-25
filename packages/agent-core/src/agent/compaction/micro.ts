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
  /** Placeholder text for zero-match Grep/Glob results elided by micro-compaction. */
  noMatchesMarker: string;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  keepRecentTokens: 40_000,
  pruneMinReclaimTokens: 20_000,
  minContentTokens: 100,
  minContextUsageRatio: 0.5,
  truncatedMarker: '[Old tool result content cleared]',
  uselessMarker: '[Uneventful result elided]',
  noMatchesMarker: '[no matches]',
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

/** Tool names whose results are file reads eligible for supersede pruning. */
const READ_TOOL_NAMES = new Set(['Read', 'ReadGroup']);

/** Tool names whose empty results can be elided as a no-match marker. */
const SEARCH_TOOL_NAMES = new Set(['Grep', 'Glob']);

/** Exact tool-result texts that indicate a zero-match search result. */
const ZERO_MATCH_TEXTS = new Set(['No matches found', 'No non-sensitive matches found']);

/**
 * Parse a tool call's arguments JSON. Returns undefined for null or malformed
 * JSON - persisted history can carry truncated arguments that must not crash
 * compaction. `ToolCall.arguments` is a JSON string (or null), never a parsed
 * object, so every consumer must go through this helper.
 */
function parseToolCallArguments(
  argumentsJson: string | null | undefined,
): Record<string, unknown> | undefined {
  if (argumentsJson === null || argumentsJson === undefined) return undefined;
  try {
    const parsed = JSON.parse(argumentsJson);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the file paths targeted by a read tool call. `Read` carries a
 * single `path`; `ReadGroup` carries a `paths` array. Returns an empty array
 * for non-read tools or calls whose arguments don't yield usable paths.
 */
function extractReadFilePaths(
  name: string,
  args: Record<string, unknown> | undefined,
): readonly string[] {
  if (args === undefined) return [];
  if (name === 'Read') {
    const path = typeof args['path'] === 'string' ? (args['path'] as string) : undefined;
    return path !== undefined && path.length > 0 ? [path] : [];
  }
  if (name === 'ReadGroup') {
    const paths = args['paths'];
    if (!Array.isArray(paths)) return [];
    return paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
  return [];
}

/** Concatenate the `text` parts of a message's content into a single string. */
function extractTextContent(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (typeof part === 'object' && part !== null && part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

/** Build a toolCallId -> tool-name map by scanning assistant messages. */
function buildToolCallNameMap(
  messages: readonly ContextMessage[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const tc of msg.toolCalls) {
      names.set(tc.id, tc.name);
    }
  }
  return names;
}

/**
 * Whether a tool result is a zero-match Grep/Glob result eligible for elision.
 * Only exact-match the canonical empty-result texts so results carrying extra
 * information (sensitive-file filter notices, pagination notices, errors) are
 * preserved verbatim.
 */
function isZeroMatchSearchResult(
  toolName: string | undefined,
  content: readonly ContentPart[],
): boolean {
  if (toolName === undefined || !SEARCH_TOOL_NAMES.has(toolName)) return false;
  const text = extractTextContent(content).trim();
  return ZERO_MATCH_TEXTS.has(text);
}

/**
 * Walk the message list and find Read/ReadGroup tool calls whose file paths
 * were superseded by a later read of the same path. Returns a map from the
 * superseded tool call's ID to the list of file paths covered by the newer
 * read (a ReadGroup can cover several).
 *
 * Only considers tool results before the cutoff line - newer reads are
 * protected and their results are kept verbatim. The comparison uses the raw
 * path strings from the tool arguments; path canonicalization would need
 * workspace context the compaction layer doesn't have, so the same file read
 * via two different spellings is treated as two different files (safe: it
 * just misses a supersede opportunity rather than dropping a distinct result).
 */
function findSupersededPaths(
  messages: readonly ContextMessage[],
  cutoff: number,
): Map<string, readonly string[]> {
  const superseded = new Map<string, readonly string[]>();
  const latestReadByPath = new Map<string, { toolCallId: string; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.role !== 'assistant' || msg.toolCalls.length === 0) continue;
    for (const tc of msg.toolCalls) {
      if (!READ_TOOL_NAMES.has(tc.name)) continue;
      const args = parseToolCallArguments(tc.arguments);
      const paths = extractReadFilePaths(tc.name, args);
      if (paths.length === 0) continue;
      for (const filePath of paths) {
        const prev = latestReadByPath.get(filePath);
        if (prev !== undefined && prev.index < cutoff) {
          const existing = superseded.get(prev.toolCallId);
          if (existing === undefined) {
            superseded.set(prev.toolCallId, [filePath]);
          } else if (!existing.includes(filePath)) {
            superseded.set(prev.toolCallId, [...existing, filePath]);
          }
        }
        latestReadByPath.set(filePath, { toolCallId: tc.id, index: i });
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
   * before the cutoff line with truncated markers. Read/ReadGroup results
   * for files that were re-read later get a supersede marker (listing the
   * covered paths) so the model knows the old content is stale. Zero-match
   * Grep/Glob results are elided to a short `[no matches]` notice regardless
   * of size. Tool results explicitly marked useless are elided with a short
   * notice regardless of size, since they carry no actionable information.
   */
  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    const config = this.config;
    const superseded = findSupersededPaths(messages, this.cutoff);
    const toolNames = buildToolCallNameMap(messages);
    const result: ContextMessage[] = [];
    let i = 0;
    for (const msg of messages) {
      const isOld = i < this.cutoff;
      const toolCallId = msg.toolCallId;
      const isTool = msg.role === 'tool' && toolCallId !== undefined;
      const isUseless = isOld && isTool && msg.useless === true;
      const isZeroMatch =
        isOld &&
        isTool &&
        toolCallId !== undefined &&
        isZeroMatchSearchResult(toolNames.get(toolCallId), msg.content);
      const isOversizedTruncatable =
        isOld &&
        isTool &&
        estimateTokensForMessages([msg]) >= config.minContentTokens;
      if (isUseless) {
        result.push({
          ...msg,
          content: [{ type: 'text', text: config.uselessMarker } as ContentPart],
        } as ContextMessage);
      } else if (isZeroMatch) {
        result.push({
          ...msg,
          content: [{ type: 'text', text: config.noMatchesMarker } as ContentPart],
        } as ContextMessage);
      } else if (isOversizedTruncatable) {
        const paths = toolCallId !== undefined ? superseded.get(toolCallId) : undefined;
        const marker =
          paths !== undefined && paths.length > 0
            ? `[Superseded by a newer read of ${paths.join(', ')}]`
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
    let noMatchesMarkerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let beforeTokens = 0;
    let afterTokens = 0;
    const toolNames = buildToolCallNameMap(messages);
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForMessages([message]);
      const isUseless = message.useless === true;
      const isZeroMatch = isZeroMatchSearchResult(
        toolNames.get(message.toolCallId),
        message.content,
      );
      if (!isUseless && !isZeroMatch && contentTokens < this.config.minContentTokens) continue;

      if (isUseless) {
        uselessMarkerTokenCount ??= estimateTokens(this.config.uselessMarker);
        truncatedToolResultCount += 1;
        beforeTokens += contentTokens;
        afterTokens += uselessMarkerTokenCount;
      } else if (isZeroMatch) {
        noMatchesMarkerTokenCount ??= estimateTokens(this.config.noMatchesMarker);
        truncatedToolResultCount += 1;
        beforeTokens += contentTokens;
        afterTokens += noMatchesMarkerTokenCount;
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
