import type { Agent } from '..';
import type { AgentReplayRecord } from '../..';

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

/** Mirrors the TUI's isReplayUserTurnRecord predicate (message-replay.ts):
 * a replay record starts a user turn when it is a user-role message from the
 * user (or a user-slash skill activation). */
function isUserTurnStartRecord(record: AgentReplayRecord): boolean {
  if (record.type !== 'message') return false;
  const { message } = record;
  if (message.role !== 'user') return false;
  switch (message.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
      return message.origin.trigger === 'user-slash';
    default:
      return false;
  }
}

export class ReplayBuilder {
  protected readonly records: AgentReplayRecord[] = [];
  /** Indices (into `records`) of user-turn-start records, oldest first. */
  private userTurnStarts: number[] = [];

  constructor(public readonly agent: Agent) {}

  push(record: AgentReplayRecord): void {
    if (!this.agent.records.restoring) return;
    this.records.push(record);
    if (!isUserTurnStartRecord(record)) return;
    this.userTurnStarts.push(this.records.length - 1);
    if (this.userTurnStarts.length <= REPLAY_TURN_LIMIT) return;
    // Drop everything before the oldest retained turn start, keeping exactly
    // the last REPLAY_TURN_LIMIT user turns.
    const dropBefore = this.userTurnStarts[this.userTurnStarts.length - REPLAY_TURN_LIMIT]!;
    this.records.splice(0, dropBefore);
    this.userTurnStarts = this.userTurnStarts
      .slice(-REPLAY_TURN_LIMIT)
      .map((i) => i - dropBefore);
  }

  buildResult(): readonly AgentReplayRecord[] {
    return this.records;
  }
}
