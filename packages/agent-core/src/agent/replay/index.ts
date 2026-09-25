import type { Agent } from '..';
import type { AgentReplayRecord } from '../..';
import { isRealUserPrompt } from '../context/identity';

/**
 * Maximum number of user turns retained in the replay log. The sole consumer
 * of the built records is the resume RPC result (core-impl
 * resumeSessionResult), and the TUI renders at most this many turns back
 * (message-replay.ts REPLAY_TURN_LIMIT). Records older than the window are
 * serialized across the in-process RPC boundary (a full JSON round-trip) but
 * never displayed, so capping here bounds both resume memory and the RPC
 * payload for long sessions. Keep in sync with the TUI's REPLAY_TURN_LIMIT.
 */
export const REPLAY_TURN_LIMIT = 10;

export class ReplayBuilder {
  protected readonly records: AgentReplayRecord[] = [];
  /** Indices (into `records`) of user-turn-start records, oldest first. */
  private userTurnStarts: number[] = [];
  /** Index (into `records`) of the partial-draft record per turn, if present. */
  private partialDraftIndices = new Map<string, number>();

  constructor(public readonly agent: Agent) {}

  push(record: AgentReplayRecord): void {
    if (!this.agent.records.restoring) return;
    this.records.push(record);
    // A record starts a user turn when its message is a real user prompt — the
    // same bar `context/identity.ts` defines for every other caller, and the
    // same predicate the TUI trims its replay window with. One rule, one place.
    if (record.type !== 'message' || !isRealUserPrompt(record.message)) return;
    this.userTurnStarts.push(this.records.length - 1);
    if (this.userTurnStarts.length <= REPLAY_TURN_LIMIT) return;
    // Drop everything before the oldest retained turn start, keeping exactly
    // the last REPLAY_TURN_LIMIT user turns.
    const dropBefore = this.userTurnStarts[this.userTurnStarts.length - REPLAY_TURN_LIMIT]!;
    this.records.splice(0, dropBefore);
    this.userTurnStarts = this.userTurnStarts
      .slice(-REPLAY_TURN_LIMIT)
      .map((i) => i - dropBefore);
    // The partial-draft markers live in the same array; shift them by the
    // same amount so subsequent replaces keep pointing at their record.
    for (const [turnId, index] of this.partialDraftIndices) {
      const shifted = index - dropBefore;
      if (shifted < 0) this.partialDraftIndices.delete(turnId);
      else this.partialDraftIndices.set(turnId, shifted);
    }
  }

  /**
   * Track the latest surviving stream draft for a turn during restore: the
   * first draft pushes a `stream_draft_partial` record, later drafts replace
   * it in place (no index shifts), and a clearing draft (empty text+think)
   * removes it. Only used while `agent.records.restoring` is true.
   */
  replacePartialDraft(turnId: string, draft: { text: string; think: string }): void {
    if (!this.agent.records.restoring) return;
    const existing = this.partialDraftIndices.get(turnId);
    const isEmpty = draft.text.length === 0 && draft.think.length === 0;
    if (isEmpty) {
      if (existing !== undefined) {
        this.records.splice(existing, 1);
        this.partialDraftIndices.delete(turnId);
        for (const [id, index] of this.partialDraftIndices) {
          if (index > existing) this.partialDraftIndices.set(id, index - 1);
        }
        this.userTurnStarts = this.userTurnStarts.map((i) => (i > existing ? i - 1 : i));
      }
      return;
    }
    const record: AgentReplayRecord = { type: 'stream_draft_partial', turnId, text: draft.text, think: draft.think };
    if (existing !== undefined && this.records[existing]?.type === 'stream_draft_partial') {
      this.records[existing] = record;
      return;
    }
    if (existing !== undefined) {
      // The marker's slot was trimmed out of the window; re-push at the end.
      this.partialDraftIndices.delete(turnId);
    }
    this.records.push(record);
    this.partialDraftIndices.set(turnId, this.records.length - 1);
  }

  buildResult(): readonly AgentReplayRecord[] {
    return this.records;
  }
}
