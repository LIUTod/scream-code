import type { ContentPart, TokenUsage } from '@scream-code/ltod';

import type { LoopRecordedEvent } from '../../loop';
import type { ToolStoreUpdate } from '../../tools/store';
import type { CompactedHistory, CompactionBeginData, CompactionResult } from '../compaction';
import type { AgentConfigUpdateData } from '../config';
import type { ContextMemoryJSONSnapshot, ContextMessage, PromptOrigin } from '../context';
import type { GoalActor, GoalBudgetLimits, GoalStatus } from '../goal';
import type { PermissionApprovalResultRecord, PermissionMode } from '../permission';
import type { UserToolRegistration } from '../tool';
import type { UsageRecordScope } from '../usage';

export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };

  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };

  'config.update': AgentConfigUpdateData;

  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;
  /**
   * A memorized approve-for-session pattern the user revoked. Stateful on
   * replay (it removes the pattern) so a resumed session does not resurrect a
   * grant that was taken back. New in wire v1.8.
   */
  'permission.record_grant_revocation': {
    pattern: string;
  };
  /**
   * A permission decision that stopped a call before it ran, written for the
   * wire so denials and aborted approvals stay auditable after the session
   * ends. New in wire v1.7; pre-1.7 wires simply carry no such record.
   * Wire-only: replay must not re-run anything from it (see the explicit
   * no-op case in `restoreAgentRecord`).
   */
  'permission.record_decision': {
    turnId: number;
    toolCallId: string;
    toolName: string;
    /** Policy that produced the decision; absent when no policy was involved
     *  (the approval was cancelled or timed out). */
    policyName?: string;
    decision: 'deny' | 'cancelled' | 'timeout';
    /** Human-readable reason, already formatted for the reader. */
    reason?: string;
  };

  'full_compaction.begin': CompactionBeginData;

  'plan_mode.enter': {
    id: string;
    strategy?: 'normal' | 'fusion';
  };
  'plan_mode.cancel': {
    id?: string;
  };
  'plan_mode.exit': {
    id?: string;
  };

  // `execute` is stripped before the record is written: a function cannot be
  // serialized, and a replayed tool must not look like it has an in-process
  // implementation nobody registered.
  'tools.register_user_tool': Omit<UserToolRegistration, 'execute'>;
  'tools.unregister_user_tool': {
    name: string;
  };
  'tools.set_active_tools': {
    names: readonly string[];
  };

  'background.stop': {
    taskId: string;
  };

  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };

  /** Per-request snapshot so a request can be reconstructed from the log. */
  'request.header': {
    provider: string;
    model: string;
    modelAlias: string;
    /**
     * Rendered system prompt for this request. Omitted (with
     * `systemPromptReused: true`) when it is byte-identical to the previous
     * header in the same wire, so a long-lived session does not store the
     * same 50KB prompt once per request. Readers that need the prompt for any
     * given request carry the last seen value forward.
     */
    systemPrompt?: string;
    systemPromptReused?: boolean;
    activeTools: readonly string[];
    messagesCount: number;
    estimatedInputTokens: number;
  };

  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  /**
   * Micro-compaction cutoff advance. Not restored on replay (the cutoff is a
   * live-derived value recomputed by `detect()`), but registered here so the
   * record is type-checked on write instead of needing an `as never` cast.
   */
  'micro_compaction.apply': { cutoff: number };

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.clear': {};
  'context.undo': { count: number };
  'context.apply_compaction': CompactionResult;
  /**
   * Persisted projection edit (see `ContextMemory.applyMessageEdit`): removes
   * (`replacement: null`) or replaces the history message with the given
   * stable `id` in the *projection* (provider request) while leaving the raw
   * history untouched. Written with strict validation; replay tolerates a
   * dangling target (no-op) so newer wires stay forward-compatible.
   */
  'context.edit_message': {
    targetId: string;
    replacement: readonly ContentPart[] | null;
  };
  /**
   * Prefix-stability observation: the fingerprint-verified request prefix
   * changed between two LLM-bound builds, and `breakIndex` is the first
   * message index whose provider-visible bytes differ (the tail from there
   * must be re-cached). The prefix that is compared is
   * `[tool declarations][messages]` — the tool table precedes every message
   * in a provider request, so a rebuilt table (MCP reconnect, `/script` or
   * python toggle, profile switch) breaks the cache at index 0 even when the
   * message bytes are identical; a table-only change is recognizable as
   * `breakIndex: 0` with `appendedSinceLast: 0` (the record carries no reason
   * field, so a table move that coincides with an append is indistinguishable
   * from a message break here — the debug log of `observePrefixStability`
   * names the cause). Pure diagnostics — written only on a break (the
   * intact-prefix path stays debug-only), never restored on replay and never
   * surfaced in the replay window; `logRecord` stamps `time`. Writers are the
   * cache-breaking events (full compaction, projection edits, micro-compaction
   * truncation, tool-table rebuild), not steady-state appends.
   */
  'context.prefix_break': {
    breakIndex: number;
    prevMessageCount: number;
    currentMessageCount: number;
    appendedSinceLast: number;
  };
  /**
   * Point-in-time snapshot of the folded context memory, written right after a
   * successful full compaction. On resume the replayer restores this snapshot
   * and skips every context-content record that predates it, instead of
   * replaying hundreds of thousands of folded append events. `compactedHistory`
   * carries the full-compaction debug trail, which would otherwise be rebuilt
   * from the pre-fold history that the snapshot skips.
   */
  'context.snapshot': {
    snapshot: ContextMemoryJSONSnapshot;
    compactedHistory: readonly CompactedHistory[];
  };
  /**
   * Throttled full snapshot of the assistant's in-flight stream (text and
   * thinking so far) for the current turn. Written DURING streaming so a
   * crashed or killed process still shows what was generated before it died:
   * the real `context.append_message` parts only land after the provider
   * stream drains (see agent/turn/ltod-llm.ts), so without this record an
   * interrupted stream leaves nothing on the wire. An empty `text`+`think`
   * record clears the draft once real parts start landing. Never part of the
   * model context: restore only surfaces it to the replay window as an
   * honestly-marked partial assistant message.
   */
  'context.stream_draft': {
    turnId: string;
    text: string;
    think: string;
  };

  'wolfpack.enter': {};
  'wolfpack.exit': {};

  /**
   * RLM mode entered. New in wire v1.6: the payload carries the recursion
   * bookkeeping so a replay can restore it. `maxDepth` is recorded on every
   * enter (null = unlimited); `depth` only on a subagent's inherited enter
   * (a subagent runs one level deeper than its parent). Pre-1.6 wires carry
   * an empty payload — replay then keeps the defaults (depth 0, unlimited).
   */
  'rlm.enter': {
    depth?: number;
    maxDepth?: number | null;
  };
  'rlm.exit': {};
  /**
   * RLM recursion-cap change (any state, including while RLM is disabled), so
   * the cap survives resume even when it is set before/without entering RLM
   * mode. `maxDepth` is null when unlimited (the core keeps `Infinity`).
   */
  'rlm.settings': {
    maxDepth: number | null;
  };

  'goal.create': {
    goalId: string;
    objective: string;
    completionCriterion?: string;
  };
  'goal.update': {
    status?: GoalStatus;
    tokensUsed?: number;
    inputTokens?: number;
    outputTokens?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    budgetLimits?: GoalBudgetLimits;
    reason?: string;
    actor?: GoalActor;
    objective?: string;
  };
  'goal.clear': {};

  'tools.update_store': ToolStoreUpdate;
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

/**
 * Storage abstraction for the append-only session wire log. Swapping the
 * backing store (filesystem today, in-memory for tests, SQLite/remote later)
 * means implementing this interface — agent code never touches the store
 * implementation directly.
 *
 * `read()` yields the records to replay, in file order. On a wire whose protocol
 * version matches the current one it must also drop the folded context records
 * that predate the last `context.snapshot` (the snapshot already carries their
 * state); `AgentRecords.replay` applies everything it is handed, and only
 * buffers the stream itself for wires that need a migration rewrite or that are
 * newer than this build. Streamed implementations must not materialize the whole
 * wire: a long-lived session's log can reach several gigabytes.
 */
export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** True when the last full read() skipped enough folded history that a physical compaction is worthwhile. */
  shouldCompactOnResume?(): boolean;
  /** Physically drop folded history from the wire (best effort). */
  compact?(): Promise<void>;
}
