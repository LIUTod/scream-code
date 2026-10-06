import { createToolMessage, type ContentPart, type Message } from '@scream-code/ltod';

import type { Agent } from '..';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../loop';
import { estimateTokens, estimateTokensForMessages } from '../../utils/tokens';
import type { CompactionResult } from '../compaction';
import { isRealUserPrompt } from './identity';
import { messageFingerprint, stablePrefixLength } from './prefix-fingerprint';
import { project } from './projector';
import {
  USER_PROMPT_ORIGIN,
  type AgentContextData,
  type ContextMessage,
  type PromptOrigin,
} from './types';

export * from './types';

// The "who authored this message" predicates. Defined in the leaf `./identity`
// module so `./projector` can use them without a circular import back here;
// re-exported so `../context` stays their public path.
export { isRealUserPrompt, isUserAuthoredMessage } from './identity';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

/** Maximum token count for tool results persisted in conversation history.
 *  Results exceeding this limit are truncated to avoid bloating every
 *  subsequent API request with stale data.  The model can re-read the
 *  full content via read_file when needed.
 *
 *  Lowered from 8000 to 5000 to reduce input-context pressure on long
 *  sessions. When input grows large, the available output space
 *  (context_window - input_tokens) shrinks, causing the model to hit
 *  max_tokens before emitting a tool call. Smaller tool-result footprints
 *  leave more room for output. The current turn always sees the full
 *  result via streaming; only the history copy is truncated. */
const MAX_TOOL_RESULT_TOKENS = 5000;

const TOOL_TRUNCATION_NOTICE =
  '\n[content truncated — use read_file to re-read if needed]';

export interface ContextMemorySnapshot {
  readonly history: readonly ContextMessage[];
  readonly tokenCount: number;
  readonly tokenCountCoveredMessageCount: number;
  readonly openSteps: ReadonlyMap<string, ContextMessage>;
  readonly pendingToolResultIds: ReadonlySet<string>;
  readonly deferredMessages: readonly ContextMessage[];
  /** Projection edits keyed by message id (`null` = removed). */
  readonly messageEdits?: ReadonlyMap<string, readonly ContentPart[] | null> | undefined;
}

/**
 * JSON-serializable form of {@link ContextMemorySnapshot} used for the
 * `context.snapshot` wire record. `openSteps` stores each in-flight step's
 * message **index** into `history` (not the message itself) so that restoring
 * can recover the live object-reference identity between the history array and
 * the open-steps map — `content.part`/`tool.call` mutations land on the same
 * object the history holds. `pendingToolResultIds` is a plain array instead of
 * a Set so the record survives JSON.stringify.
 */
export interface ContextMemoryJSONSnapshot {
  readonly history: readonly ContextMessage[];
  readonly tokenCount: number;
  readonly tokenCountCoveredMessageCount: number;
  readonly openSteps: readonly (readonly [string, number])[];
  readonly pendingToolResultIds: readonly string[];
  readonly deferredMessages: readonly ContextMessage[];
  /** Persisted projection edits, keyed by message id (`null` = removed).
   *  Optional: snapshots written before the feature restore with none. */
  readonly messageEdits?:
    | readonly (readonly [string, readonly ContentPart[] | null])[]
    | undefined;
}

export class ContextMemory {
  private _history: ContextMessage[] = [];
  private _tokenCount = 0;
  private tokenCountCoveredMessageCount = 0;
  private openSteps: Map<string, ContextMessage> = new Map();
  private pendingToolResultIds = new Set<string>();
  private deferredMessages: ContextMessage[] = [];

  /**
   * Persisted projection edits keyed by message id: `null` removes the
   * message from the projection, an array replaces its content. The raw
   * history is never modified — every LLM-bound read path funnels through
   * {@link applyMessageEdits}.
   */
  private _messageEdits = new Map<string, readonly ContentPart[] | null>();
  /** Counter behind {@link assignMessageId}. Never reset: ids must stay
   *  unique for the whole session lifetime, including across clear/undo. */
  private _nextMessageId = 0;

  /**
   * Per-message fingerprints captured from the last message list handed to
   * the LLM via {@link messagesForLLM}. Used to measure prefix stability
   * across calls: a provider prompt cache only hits when the leading
   * messages are byte-identical to the previous request, so the length of
   * the matching prefix here approximates the cacheable prefix length.
   *
   * Reset on {@link clear}; a compaction naturally produces a 0-length
   * stable prefix (the summary replaces the head), which is the correct
   * cache-break signal rather than a reset.
   */
  private lastSentFingerprints: string[] = [];

  constructor(protected readonly agent: Agent) {}

  snapshot(): ContextMemorySnapshot {
    return {
      history: [...this._history],
      tokenCount: this._tokenCount,
      tokenCountCoveredMessageCount: this.tokenCountCoveredMessageCount,
      openSteps: new Map(this.openSteps),
      pendingToolResultIds: new Set(this.pendingToolResultIds),
      deferredMessages: [...this.deferredMessages],
      messageEdits: new Map(this._messageEdits),
    };
  }

  restore(snapshot: ContextMemorySnapshot): void {
    this._history = [...snapshot.history];
    this._tokenCount = snapshot.tokenCount;
    this.tokenCountCoveredMessageCount = snapshot.tokenCountCoveredMessageCount;
    this.openSteps = new Map(snapshot.openSteps);
    this.pendingToolResultIds = new Set(snapshot.pendingToolResultIds);
    this.deferredMessages = [...snapshot.deferredMessages];
    this._messageEdits = new Map(snapshot.messageEdits ?? []);
    for (const message of this._history) this.assignMessageId(message);
    for (const message of this.deferredMessages) this.assignMessageId(message);
  }

  /**
   * JSON-safe snapshot for wire persistence. `openSteps` values are recorded as
   * their index into `history` so restoring can rebuild the live reference
   * identity between history messages and open steps (see
   * {@link ContextMemoryJSONSnapshot}).
   */
  toJSONSnapshot(): ContextMemoryJSONSnapshot {
    return {
      history: [...this._history],
      tokenCount: this._tokenCount,
      tokenCountCoveredMessageCount: this.tokenCountCoveredMessageCount,
      openSteps: [...this.openSteps.entries()].map(
        ([uuid, message]) => [uuid, this._history.indexOf(message)] as const,
      ),
      pendingToolResultIds: [...this.pendingToolResultIds],
      deferredMessages: [...this.deferredMessages],
      // Attach only when present so wires without edits stay byte-identical
      // to what earlier builds wrote.
      ...(this._messageEdits.size > 0
        ? { messageEdits: [...this._messageEdits.entries()] }
        : {}),
    };
  }

  /**
   * Restore from a JSON-safe snapshot produced by {@link toJSONSnapshot}.
   * Open steps are re-attached to the exact history message objects they
   * pointed at, preserving reference identity: later `content.part`/`tool.call`
   * events and `applyCompaction` pruning operate on the same objects the
   * history array holds, exactly as they did in the live session.
   */
  restoreJSONSnapshot(snapshot: ContextMemoryJSONSnapshot): void {
    this._history = [...snapshot.history];
    this._tokenCount = snapshot.tokenCount;
    this.tokenCountCoveredMessageCount = snapshot.tokenCountCoveredMessageCount;
    const openSteps = new Map<string, ContextMessage>();
    for (const [uuid, historyIndex] of snapshot.openSteps) {
      const message = this._history[historyIndex];
      if (message !== undefined) openSteps.set(uuid, message);
    }
    this.openSteps = openSteps;
    this.pendingToolResultIds = new Set(snapshot.pendingToolResultIds);
    this.deferredMessages = [...snapshot.deferredMessages];
    this._messageEdits = new Map(snapshot.messageEdits ?? []);
    // Legacy wires predate message ids: synthesize them deterministically in
    // history order so persisted edits (and future ones) keep resolving.
    for (const message of this._history) this.assignMessageId(message);
    for (const message of this.deferredMessages) this.assignMessageId(message);
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
    this._messageEdits.clear();
    this.lastSentFingerprints = [];
    this.agent.injection.onContextClear();
    // History was emptied; the micro-compaction cutoff line refers to the
    // pre-clear layout and would elide tool results in the new session's
    // prefix once the token ratio recovers. Reset so detect() recomputes.
    this.agent.microCompaction.reset();
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
        // Notify injectors: the removed message may be the very injection
        // an injector recorded (injectedAt), so positions must be adjusted —
        // otherwise reminders (user prefs, goal, plugin session) silently stop
        // re-injecting until the next compaction or /clear.
        this.agent.injection.onContextMessageRemoved(i);
      }
    }

    if (!this.agent.records.restoring && (stoppedAtBoundary || removedUserCount < count)) {
      // Throw nothing — this is a best-effort operation.
    }

    // Undo rewound the history; the micro-compaction cutoff line refers to
    // the pre-undo layout and would silently elide tool results in the
    // remaining (now shifted) prefix. Reset it so the next detect() recomputes
    // from the new history. Mirrors clear()/applyCompaction().
    this.agent.microCompaction.reset();
  }

  /**
   * Apply a full compaction summary.
   *
   * Prefix-stability note: this is a **replaceHead** operation, not a
   * replaceTail. The first `compactedCount` messages are collapsed into a
   * single summary message; the trailing recent messages are preserved
   * verbatim. This necessarily breaks the provider prompt cache for the
   * whole prefix (the summary is new content), which is inherent to
   * summarization and cannot be avoided. After compaction the new prefix
   * `[summary, ...tail]` is stable again until the next compaction or
   * micro-compaction cutoff advance, so subsequent append-only steps resume
   * hitting the cache.
   */
  applyCompaction(summary: CompactionResult): void {
    this.agent.records.logRecord({
      type: 'context.apply_compaction',
      ...summary,
    });
    const summaryMessage: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: summary.summary }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
    this.assignMessageId(summaryMessage);
    // Re-anchor the cut by identity when the record carries it (new records);
    // old records keep the raw-index semantics via `compactedCount`.
    let cut = summary.compactedCount;
    if (summary.firstKeptMessageId !== undefined) {
      const byId = this._history.findIndex((m) => m.id === summary.firstKeptMessageId);
      if (byId >= 0) cut = byId;
    }
    this._history = [summaryMessage, ...this._history.slice(cut)];
    // Prune open-step mappings by reference instead of clearing them all:
    // a step that is still in flight lives at the history tail and survives
    // the compaction slice, so its tool.call/content.part events must keep
    // landing. Dropping the mapping while tool.result events still append
    // would orphan tool exchanges (tool_result without tool_use → API 400).
    const survivingMessages = new Set<ContextMessage>(this._history);
    for (const [uuid, message] of this.openSteps) {
      if (!survivingMessages.has(message)) {
        this.openSteps.delete(uuid);
      }
    }
    this.flushDeferredMessagesIfToolExchangeClosed();
    this._tokenCount = summary.tokensAfter;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.injection.onContextCompacted(cut);
    this.agent.emitStatusUpdated();
    this.agent.microCompaction.reset();

    // Persist a point-in-time snapshot of the freshly folded context so the next
    // resume can restore it directly and skip replaying the (potentially hundreds
    // of thousands of) append/compaction records that were folded away. Only the
    // live path writes it — during replay the snapshot record is what we restore
    // from, so re-logging it here would be redundant.
    if (!this.agent.records.restoring) {
      this.agent.records.logRecord({
        type: 'context.snapshot',
        snapshot: this.toJSONSnapshot(),
        compactedHistory: [...this.agent.fullCompaction.compactedHistory],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Projection edits
  // -------------------------------------------------------------------------

  /**
   * Apply persisted projection edits to a message list: messages edited to
   * `null` are dropped; messages with a replacement get a *copy* carrying the
   * new content (a fresh object keeps the token-estimate WeakMap from
   * returning the stale count). Messages without an edit — and every message
   * when no edits exist — pass through unchanged.
   *
   * Only what the model sees is affected: the raw history (UI, export, trace,
   * resume) keeps the original content.
   */
  applyMessageEdits(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (this._messageEdits.size === 0) return messages;
    const result: ContextMessage[] = [];
    for (const message of messages) {
      const id = message.id;
      const edit = id === undefined ? undefined : this._messageEdits.get(id);
      if (edit === undefined) {
        result.push(message);
      } else if (edit !== null) {
        result.push({ ...message, content: [...edit] });
      }
    }
    return result;
  }

  /** Whether a persisted edit removes this message from the projection. */
  isMessageRemovedByEdit(message: Message): boolean {
    const id = (message as { id?: string }).id;
    return id !== undefined && this._messageEdits.get(id) === null;
  }

  /**
   * Persist a projection edit for the message with `targetId`:
   * `replacement: null` removes the message from every future provider
   * request; an array replaces its content. The edit is recorded, so it
   * replays on resume and survives restarts; the raw history message is never
   * rewritten.
   *
   * Live writes validate strictly (the target must exist and be editable).
   * During replay the same method runs for records read from the wire and
   * silently skips targets that no longer exist (e.g. the message was
   * compacted away before the edit replayed) — a newer wire must never fail
   * to load.
   */
  applyMessageEdit(targetId: string, replacement: readonly ContentPart[] | null): void {
    const index = this._history.findIndex((message) => message.id === targetId);
    const message =
      index === -1
        ? this.deferredMessages.find((candidate) => candidate.id === targetId)
        : this._history[index]!;
    if (message === undefined) {
      if (this.agent.records.restoring) return;
      throw new Error(`context.edit_message: no message with id '${targetId}'`);
    }
    if (message.role === 'system' || message.origin?.kind === 'compaction_summary') {
      if (this.agent.records.restoring) return;
      throw new Error(`context.edit_message: message '${targetId}' is not editable`);
    }
    const previousEdit = this._messageEdits.get(targetId);
    const normalized =
      replacement === null ? null : replacement.map((part) => ({ ...part }));
    this._messageEdits.set(targetId, normalized);
    this.agent.records.logRecord({
      type: 'context.edit_message',
      targetId,
      replacement: normalized,
    });
    // Keep the API-anchored gauge honest when the edit lands inside the
    // measured prefix: adjust by the estimated delta. The baseline is the
    // *current* projection of the target — a second edit replaces the first
    // one's effect instead of stacking on top of it. Deferred targets are not
    // in the measured prefix (and not in the projection yet), so only history
    // targets adjust the gauge; content after the covered count is
    // re-projected through `applyMessageEdits` on every read.
    if (index !== -1 && index < this.tokenCountCoveredMessageCount) {
      const before =
        previousEdit === undefined
          ? estimateTokensForMessages([message])
          : previousEdit === null
            ? 0
            : estimateTokensForMessages([{ ...message, content: [...previousEdit] }]);
      const after =
        normalized === null
          ? 0
          : estimateTokensForMessages([{ ...message, content: normalized }]);
      this._tokenCount = Math.max(0, this._tokenCount + after - before);
    }
    this.agent.emitStatusUpdated();
  }

  /**
   * Assign a stable id the first time a message enters the history (or when
   * it is restored from the wire). Mutates the message in place — object
   * identity is load-bearing: open steps, deferred messages and the history
   * array all reference the same object. Messages that already carry an id
   * only advance the counter past it.
   */
  private assignMessageId(message: ContextMessage): void {
    const existing = message.id;
    if (existing !== undefined) {
      const match = /^m(\d+)$/.exec(existing);
      if (match !== null) {
        const n = Number(match[1]);
        if (n >= this._nextMessageId) this._nextMessageId = n + 1;
      }
      return;
    }
    (message as { id?: string }).id = `m${this._nextMessageId}`;
    this._nextMessageId += 1;
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
    return (
      this._tokenCount +
      estimateTokensForMessages(project(this.applyMessageEdits(pendingMessages)))
    );
  }

  get history(): readonly ContextMessage[] {
    return this._history;
  }

  get messages(): Message[] {
    // Apply micro-compaction before projecting: old tool results are
    // truncated to a short marker, freeing context tokens without an
    // LLM call. Detect() is a no-op when the micro-compaction flag is
    // off (env: SCREAM_CODE_EXPERIMENTAL_MICRO_COMPACTION=0).
    //
    // Prefix-stability note: detect() only ever advances the cutoff
    // forward (never retreats), and compact() replaces old tool results
    // with a stable marker that does not change once written. So a given
    // message's bytes change at most once (full -> marker) and then stay
    // fixed. The transition is a one-time cache break; steady-state
    // append-only turns still hit the cache. LLM-bound callers should
    // prefer {@link messagesForLLM} which adds prefix-stability
    // observability on top of this getter.
    this.agent.microCompaction.detect();
    return project(this.applyMessageEdits(this.agent.microCompaction.compact(this.history)));
  }

  /**
   * Build the message list for an LLM call, with prefix-stability
   * observation.
   *
   * This is the LLM-bound counterpart of the {@link messages} getter: it
   * runs the same detect + compact + project pipeline, then fingerprints
   * the result and logs how much of the prefix survived since the last
   * call. A stable prefix length equal to the previous message count means
   * the provider prompt cache should hit; a smaller value means an early
   * message mutated (compaction summary, micro-compaction truncation, or a
   * projection repair) and the cache broke from that index.
   *
   * Unlike the read-only `messages` getter, this path closes any trailing
   * in-flight tool call by synthesizing an error result (synthesizeMissing):
   * these messages go straight to the provider, which rejects an assistant
   * tool_calls message with no matching tool result (e.g. after a network
   * drop mid-batch).
   */
  messagesForLLM(): Message[] {
    // detect() is also run by fullCompaction.beforeStep at the step
    // boundary; mirroring it here keeps this path behavior-identical to
    // the `messages` getter when called directly (e.g. tests).
    this.agent.microCompaction.detect();
    const messages = project(
      this.applyMessageEdits(this.agent.microCompaction.compact(this.history)),
      {
        synthesizeMissing: true,
      },
    );
    this.observePrefixStability(messages);
    return messages;
  }

  /**
   * Compare the projected messages against the last LLM-bound batch and
   * log the stable-prefix length. Pure observation: no state that affects
   * message content is mutated, only the fingerprint baseline used by the
   * next call's comparison.
   */
  private observePrefixStability(messages: readonly Message[]): void {
    const prev = this.lastSentFingerprints;
    const stable = stablePrefixLength(prev, messages);
    // Capture this call's fingerprints for the next comparison. Computed
    // unconditionally so the baseline always reflects the latest sent
    // bytes, even when nothing is logged.
    this.lastSentFingerprints = messages.map(messageFingerprint);

    // First call in a session has no baseline; nothing to compare.
    if (prev.length === 0) return;

    const appended = messages.length - prev.length;
    const prefixIntact = stable >= prev.length;
    // Cache-friendly happy path: the whole previous prefix survived and the new
    // call only appended to the tail. Log the estimated cached-prefix token count
    // so the prompt-cache hit rate can be quantified, not just the break events.
    if (prefixIntact) {
      if (appended > 0) {
        this.agent.log.debug('prefix-stability: provider prompt cache prefix hit', {
          stablePrefixLength: stable,
          cachedPrefixTokens: estimateTokensForMessages(messages.slice(0, stable)),
          prevMessageCount: prev.length,
          currentMessageCount: messages.length,
          appendedSinceLast: appended,
        });
      }
      return;
    }

    this.agent.log.debug('prefix-stability: provider prompt cache prefix broke', {
      stablePrefixLength: stable,
      prevMessageCount: prev.length,
      currentMessageCount: messages.length,
      appendedSinceLast: appended,
      breakIndex: stable,
    });
    // Persist the break as a wire record so it outlives the debug log (and the
    // log's rotation): cache-break history stays auditable straight off the
    // wire. Only this path writes: the hit path above stays debug-only, keeping
    // steady-state appends off the wire. `logRecord` stamps `time`; the type is
    // pure observation — nothing consumes it on the way back (restore ignores
    // it, and the trace builder skips record types it does not render), so it
    // is never reconstructed into UI or model state.
    this.agent.records.logRecord({
      type: 'context.prefix_break',
      breakIndex: stable,
      prevMessageCount: prev.length,
      currentMessageCount: messages.length,
      appendedSinceLast: appended,
    });
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
          useless: event.result.isError !== true && event.result.useless === true ? true : undefined,
        });
        this.pendingToolResultIds.delete(event.toolCallId);
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
    }
  }

  appendMessage(message: ContextMessage): void {
    // Assign the id before logging so the persisted record carries it; replay
    // then reuses the same id instead of deriving a fresh one.
    this.assignMessageId(message);
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

  /**
   * Defensive teardown for a live turn that ended — normally, cancelled, or
   * failed — while recorded tool calls were still awaiting results (e.g. the
   * batch's result dispatch died after a `tool.call` was already recorded,
   * like a network drop mid-execution). Synthesizes an error result for each
   * dangling call so the exchange closes: left open, the assistant tool_calls
   * message would have no matching tool message and the next request would be
   * rejected by the provider ("must be followed by tool messages responding
   * to each tool_call_id"). No-op when the exchange is already closed.
   */
  closeAbandonedToolExchange(output: string): number {
    if (this.pendingToolResultIds.size === 0) return 0;
    const interruptedToolCallIds = [...this.pendingToolResultIds];
    for (const toolCallId of interruptedToolCallIds) {
      this.appendLoopEvent({
        type: 'tool.result',
        parentUuid: toolCallId,
        toolCallId,
        result: {
          output,
          isError: true,
        },
      });
    }
    this.flushDeferredMessagesIfToolExchangeClosed();
    return interruptedToolCallIds.length;
  }

  private pushHistory(...messages: ContextMessage[]): void {
    for (const message of messages) {
      this.assignMessageId(message);
    }
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

  /**
   * Drop in-flight assistant messages that cannot be serialized into a valid
   * provider request. An interrupted or empty step leaves an open assistant
   * message whose content is either empty or only "think" parts; after
   * projection it serializes to a message with no content and no tool_calls,
   * which strict OpenAI-compatible gateways reject with a 400 on every later
   * request. Messages carrying any sendable part (text / image / audio / video)
   * or tool calls are kept.
   */
  dropVacuousOpenMessages(): void {
    for (const [uuid, message] of this.openSteps) {
      const hasSendableContent = message.content.some((part) => part.type !== 'think');
      if (hasSendableContent || message.toolCalls.length > 0) continue;
      const index = this._history.indexOf(message);
      if (index !== -1) {
        this._history.splice(index, 1);
        this.agent.injection.onContextMessageRemoved(index);
        // Keep the token gauge consistent with the history: the removed message
        // contributed nothing sendable, but its think parts still counted.
        if (index < this.tokenCountCoveredMessageCount) {
          this.tokenCountCoveredMessageCount--;
          this._tokenCount = Math.max(0, this._tokenCount - estimateTokensForMessages([message]));
        }
      }
      this.openSteps.delete(uuid);
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

/** Truncate a plain-text tool output that exceeds MAX_TOOL_RESULT_TOKENS.
 *  Tail-biased: keeps 25% head + 75% tail so error messages and test
 *  failures (usually at the end) survive truncation. */
function truncateToolOutput(text: string): string {
  if (estimateTokens(text) <= MAX_TOOL_RESULT_TOKENS) return text;
  const noticeTokens = estimateTokens(TOOL_TRUNCATION_NOTICE);
  const budget = MAX_TOOL_RESULT_TOKENS - noticeTokens;
  if (budget <= 0) return TOOL_TRUNCATION_NOTICE.trim();

  const headBudget = Math.floor(budget * 0.25);
  const tailBudget = budget - headBudget;

  // Collect head (forward iteration).
  let head = '';
  let headTokens = 0;
  for (const ch of text) {
    const chTokens = ch.codePointAt(0)! <= 127 ? 1 / 4 : 1;
    if (headTokens + chTokens > headBudget) break;
    head += ch;
    headTokens += chTokens;
  }

  // Collect tail (backward iteration, collect then reverse to avoid O(n²) prepend).
  const reversed = [...text].toReversed();
  const tailChars: string[] = [];
  let tailTokens = 0;
  for (const ch of reversed) {
    const chTokens = ch.codePointAt(0)! <= 127 ? 1 / 4 : 1;
    if (tailTokens + chTokens > tailBudget) break;
    tailChars.push(ch);
    tailTokens += chTokens;
  }
  const tail = tailChars.toReversed().join('');

  const omitted = Math.max(0, Math.round(estimateTokens(text) - headTokens - tailTokens));
  const notice = `\n[content truncated - ~${omitted} tokens omitted]\n`;
  return head + notice + tail;
}

/** Truncate oversized text parts in a ContentPart array.
 *  Tail-biased: keeps 25% head + 75% tail. */
function truncateContentParts(parts: readonly ContentPart[]): ContentPart[] {
  let totalTokens = 0;
  for (const p of parts) {
    if (p.type === 'text') totalTokens += estimateTokens(p.text);
  }
  if (totalTokens <= MAX_TOOL_RESULT_TOKENS) return [...parts];

  const noticeTokens = estimateTokens(TOOL_TRUNCATION_NOTICE);
  const budget = MAX_TOOL_RESULT_TOKENS - noticeTokens;
  if (budget <= 0) return [{ type: 'text', text: TOOL_TRUNCATION_NOTICE.trim() }];

  const headBudget = Math.floor(budget * 0.25);
  const tailBudget = budget - headBudget;

  // Forward pass: collect head parts.
  const headParts: ContentPart[] = [];
  let headUsed = 0;
  let headEnd = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.type !== 'text') {
      headParts.push(p);
      headEnd = i + 1;
      continue;
    }
    const partTokens = estimateTokens(p.text);
    if (headUsed + partTokens <= headBudget) {
      headParts.push(p);
      headUsed += partTokens;
      headEnd = i + 1;
    } else {
      const remaining = headBudget - headUsed;
      if (remaining > 0) {
        let kept = '';
        let t = 0;
        for (const ch of p.text) {
          const chTokens = ch.codePointAt(0)! <= 127 ? 1 / 4 : 1;
          if (t + chTokens > remaining) break;
          kept += ch;
          t += chTokens;
        }
        if (kept.length > 0) headParts.push({ type: 'text', text: kept });
      }
      break;
    }
  }

  // Backward pass: collect tail parts (from end, skipping head range).
  const tailParts: ContentPart[] = [];
  let tailUsed = 0;
  for (let i = parts.length - 1; i >= headEnd; i--) {
    const p = parts[i]!;
    if (p.type !== 'text') {
      tailParts.unshift(p);
      continue;
    }
    const partTokens = estimateTokens(p.text);
    if (tailUsed + partTokens <= tailBudget) {
      tailParts.unshift(p);
      tailUsed += partTokens;
    } else {
      const remaining = tailBudget - tailUsed;
      if (remaining > 0) {
        const chars = [...p.text];
        let kept = '';
        let t = 0;
        for (let j = chars.length - 1; j >= 0; j--) {
          const chTokens = chars[j]!.codePointAt(0)! <= 127 ? 1 / 4 : 1;
          if (t + chTokens > remaining) break;
          kept = chars[j]! + kept;
          t += chTokens;
        }
        if (kept.length > 0) tailParts.unshift({ type: 'text', text: kept });
      }
      break;
    }
  }

  const omitted = Math.max(0, Math.round(totalTokens - headUsed - tailUsed));
  return [...headParts, { type: 'text', text: `[content truncated - ~${omitted} tokens omitted]` }, ...tailParts];
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}
