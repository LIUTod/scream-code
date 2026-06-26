import { createToolMessage, type ContentPart, type Message } from '@scream-code/ltod';

import type { Agent } from '..';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../loop';
import { estimateTokens, estimateTokensForMessages } from '../../utils/tokens';
import type { CompactionResult } from '../compaction';
import { project } from './projector';
import {
  USER_PROMPT_ORIGIN,
  type AgentContextData,
  type ContextMessage,
  type PromptOrigin,
} from './types';

export * from './types';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

/** Maximum token count for tool results persisted in conversation history.
 *  Results exceeding this limit are truncated to avoid bloating every
 *  subsequent API request with stale data.  The model can re-read the
 *  full content via read_file when needed. */
const MAX_TOOL_RESULT_TOKENS = 8000;

const TOOL_TRUNCATION_NOTICE =
  '\n[content truncated — use read_file to re-read if needed]';

export interface ContextMemorySnapshot {
  readonly history: readonly ContextMessage[];
  readonly tokenCount: number;
  readonly tokenCountCoveredMessageCount: number;
  readonly openSteps: ReadonlyMap<string, ContextMessage>;
  readonly pendingToolResultIds: ReadonlySet<string>;
  readonly deferredMessages: readonly ContextMessage[];
}

export class ContextMemory {
  private _history: ContextMessage[] = [];
  private _tokenCount = 0;
  private tokenCountCoveredMessageCount = 0;
  private openSteps: Map<string, ContextMessage> = new Map();
  private pendingToolResultIds = new Set<string>();
  private deferredMessages: ContextMessage[] = [];

  constructor(protected readonly agent: Agent) {}

  snapshot(): ContextMemorySnapshot {
    return {
      history: [...this._history],
      tokenCount: this._tokenCount,
      tokenCountCoveredMessageCount: this.tokenCountCoveredMessageCount,
      openSteps: new Map(this.openSteps),
      pendingToolResultIds: new Set(this.pendingToolResultIds),
      deferredMessages: [...this.deferredMessages],
    };
  }

  restore(snapshot: ContextMemorySnapshot): void {
    this._history = [...snapshot.history];
    this._tokenCount = snapshot.tokenCount;
    this.tokenCountCoveredMessageCount = snapshot.tokenCountCoveredMessageCount;
    this.openSteps = new Map(snapshot.openSteps);
    this.pendingToolResultIds = new Set(snapshot.pendingToolResultIds);
    this.deferredMessages = [...snapshot.deferredMessages];
  }

  appendUserMessage(
    content: readonly ContentPart[],
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): void {
    this.appendMessage({
      role: 'user',
      content: [...content],
      toolCalls: [],
      origin,
    });
  }

  appendSystemReminder(content: string, origin: PromptOrigin): void {
    const text = `<system-reminder>\n${content}\n</system-reminder>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin,
    });
  }

  clear(): void {
    this.agent.records.logRecord({ type: 'context.clear' });
    this._history = [];
    this._tokenCount = 0;
    this.tokenCountCoveredMessageCount = 0;
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
    this.agent.injection.onContextClear();
    this.agent.emitStatusUpdated();
  }

  /**
   * Remove the last N user-prompt turns from the conversation history.
   * This is the core of the `/undo` command: it walks the history backward,
   * removes all messages belonging to each undone turn, and adjusts token
   * accounting and injection positions.
   */
  undo(count: number): void {
    if (count <= 0 || this._history.length === 0) return;

    this.agent.records.logRecord({ type: 'context.undo', count });

    let removedUserCount = 0;
    let stoppedAtBoundary = false;
    for (let i = this._history.length - 1; i >= 0; i--) {
      const message = this._history[i];
      if (message === undefined) continue;
      // Don't cross injection or compaction summary boundaries.
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') {
        stoppedAtBoundary = true;
        break;
      }

      this._history.splice(i, 1);
      this.agent.injection.onContextMessageRemoved(i);

      if (i < this.tokenCountCoveredMessageCount) {
        this.tokenCountCoveredMessageCount--;
        // Clamp to zero — the real token count from API usage can differ
        // from estimates, and subtraction could otherwise go negative.
        this._tokenCount = Math.max(
          0,
          this._tokenCount - estimateTokensForMessages([message]),
        );
      }

      if (isRealUserPrompt(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }

    // Clean up orphaned injection messages that are now adjacent (would
    // produce consecutive user-role messages that some APIs reject).
    for (let i = this._history.length - 1; i >= 0; i--) {
      const msg = this._history[i];
      if (msg?.origin?.kind !== 'injection') continue;
      const prev = this._history[i - 1];
      const next = this._history[i + 1];
      if (
        prev?.origin?.kind === 'injection' ||
        next?.origin?.kind === 'injection' ||
        i === 0 // leading injection
      ) {
        this._history.splice(i, 1);
      }
    }

    if (!this.agent.records.restoring && (stoppedAtBoundary || removedUserCount < count)) {
      // Throw nothing — this is a best-effort operation.
    }

  }

  applyCompaction(summary: CompactionResult): void {
    this.agent.records.logRecord({
      type: 'context.apply_compaction',
      ...summary,
    });
    this._history = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: summary.summary }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      },
      ...this._history.slice(summary.compactedCount),
    ];
    this.openSteps.clear();
    this.flushDeferredMessagesIfToolExchangeClosed();
    this._tokenCount = summary.tokensAfter;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.injection.onContextCompacted(summary.compactedCount);
    this.agent.emitStatusUpdated();
    this.agent.microCompaction.reset();
  }

  data(): AgentContextData {
    return {
      history: this.history,
      tokenCount: this.tokenCount,
    };
  }

  get tokenCount(): number {
    return this._tokenCount;
  }

  get tokenCountWithPending(): number {
    const pendingMessages = this._history.slice(this.tokenCountCoveredMessageCount);
    return this._tokenCount + estimateTokensForMessages(project(pendingMessages));
  }

  get history(): readonly ContextMessage[] {
    return this._history;
  }

  get messages(): Message[] {
    // Apply micro-compaction before projecting: old tool results are
    // truncated to a short marker, freeing context tokens without an
    // LLM call. Detect() is a no-op when the micro-compaction flag is
    // off (env: SCREAM_CODE_EXPERIMENTAL_MICRO_COMPACTION=0).
    this.agent.microCompaction.detect();
    return project(this.agent.microCompaction.compact(this.history));
  }

  appendLoopEvent(event: LoopRecordedEvent): void {
    this.agent.records.logRecord({
      type: 'context.append_loop_event',
      event,
    });
    switch (event.type) {
      case 'step.begin': {
        const message: ContextMessage = {
          role: 'assistant',
          content: [],
          toolCalls: [],
        };
        this.pushHistory(message);
        this.openSteps.set(event.uuid, message);
        return;
      }
      case 'step.end': {
        const openStep = this.openSteps.get(event.uuid);
        if (event.usage !== undefined) {
          const openStepIndex = openStep === undefined ? -1 : this._history.indexOf(openStep);
          this._tokenCount =
            event.usage.inputCacheRead +
            event.usage.inputCacheCreation +
            event.usage.inputOther +
            event.usage.output;
          this.tokenCountCoveredMessageCount =
            openStepIndex === -1 ? this._history.length : openStepIndex + 1;
        }
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
      case 'content.part': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) return;
        openStep.content.push(event.part);
        return;
      }
      case 'tool.call': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) return;
        openStep.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
        });
        this.pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        const message = createToolMessage(event.toolCallId, toolResultOutputForModel(event.result));
        this.pushHistory({
          ...message,
          role: 'tool',
          isError: event.result.isError,
        });
        this.pendingToolResultIds.delete(event.toolCallId);
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
    }
  }

  appendMessage(message: ContextMessage): void {
    this.agent.records.logRecord({
      type: 'context.append_message',
      message,
    });
    if (this.hasOpenToolExchange()) {
      this.deferredMessages.push(message);
      return;
    }
    this.pushHistory(message);
  }

  private flushDeferredMessagesIfToolExchangeClosed(): void {
    if (this.pendingToolResultIds.size > 0 || this.deferredMessages.length === 0) {
      return;
    }
    this.pushHistory(...this.deferredMessages);
    this.deferredMessages = [];
  }

  private hasOpenToolExchange(): boolean {
    return this.pendingToolResultIds.size > 0;
  }

  private pushHistory(...messages: ContextMessage[]): void {
    this._history.push(...messages);
    for (const message of messages) {
      if (message.origin?.kind === 'background_task') {
        this.agent.background.markDeliveredNotification(message.origin);
      }
      this.agent.replayBuilder.push({
        type: 'message',
        message,
      });
    }
  }
}

function toolResultOutputForModel(result: ExecutableToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return truncateToolOutput(`${TOOL_ERROR_STATUS}\n${output}`);
    }
    if (isEmptyOutputText(output)) return TOOL_EMPTY_STATUS;
    return truncateToolOutput(output);
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...truncateContentParts(output)];
  }
  return truncateContentParts(output);
}

/** Truncate a plain-text tool output that exceeds MAX_TOOL_RESULT_TOKENS. */
function truncateToolOutput(text: string): string {
  if (estimateTokens(text) <= MAX_TOOL_RESULT_TOKENS) return text;
  // Walk backwards to find a safe cut point within budget, reserving room
  // for the truncation notice.
  const noticeTokens = estimateTokens(TOOL_TRUNCATION_NOTICE);
  const budget = MAX_TOOL_RESULT_TOKENS - noticeTokens;
  if (budget <= 0) return TOOL_TRUNCATION_NOTICE.trim();

  // Character-level truncation: preserve the first ~budget tokens' worth of text.
  let kept = '';
  let tokens = 0;
  for (const ch of text) {
    const chTokens = ch.codePointAt(0)! <= 127 ? 1 / 4 : 1;
    if (tokens + chTokens > budget) break;
    kept += ch;
    tokens += chTokens;
  }
  return kept + TOOL_TRUNCATION_NOTICE;
}

/** Truncate oversized text parts in a ContentPart array. */
function truncateContentParts(parts: readonly ContentPart[]): ContentPart[] {
  let totalTokens = 0;
  for (const p of parts) {
    if (p.type === 'text') totalTokens += estimateTokens(p.text);
  }
  if (totalTokens <= MAX_TOOL_RESULT_TOKENS) return [...parts];

  const noticeTokens = estimateTokens(TOOL_TRUNCATION_NOTICE);
  const budget = MAX_TOOL_RESULT_TOKENS - noticeTokens;
  if (budget <= 0) return [{ type: 'text', text: TOOL_TRUNCATION_NOTICE.trim() }];

  const result: ContentPart[] = [];
  let used = 0;
  for (const p of parts) {
    if (p.type !== 'text') {
      result.push(p);
      continue;
    }
    const partTokens = estimateTokens(p.text);
    if (used + partTokens <= budget) {
      result.push(p);
      used += partTokens;
    } else {
      // Partial truncation of this text part.
      const remaining = budget - used;
      let kept = '';
      let t = 0;
      for (const ch of p.text) {
        const chTokens = ch.codePointAt(0)! <= 127 ? 1 / 4 : 1;
        if (t + chTokens > remaining) break;
        kept += ch;
        t += chTokens;
      }
      if (kept.length > 0) result.push({ type: 'text', text: kept });
      break;
    }
  }
  result.push({ type: 'text', text: TOOL_TRUNCATION_NOTICE });
  return result;
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

/**
 * Determines whether a context message counts as a "user prompt" for undo
 * anchoring.  Regular user messages and user-triggered skill activations
 * both count; injections, system reminders, and model-triggered skills don't.
 */
function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  return false;
}
