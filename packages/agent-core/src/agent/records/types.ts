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

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.clear': {};
  'context.undo': { count: number };
  'context.apply_compaction': CompactionResult;
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

  'rlm.enter': {};
  'rlm.exit': {};

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
