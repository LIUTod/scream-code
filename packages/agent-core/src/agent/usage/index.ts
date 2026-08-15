import type { UsageStatus } from '#/rpc';
import { addUsage, type TokenUsage } from '@scream-code/ltod';

import type { Agent } from '..';

export type UsageRecordScope = 'session' | 'turn';

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export class UsageRecorder {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;
  /**
   * Session-wide, turn-scoped usage only (`scope === 'turn'`). Restored from
   * the wire log on resume (records restore replays `usage.record` with its
   * original scope), so the TUI's per-session HitR survives process restarts
   * instead of resetting to zero. Compaction summaries (scope 'session')
   * never enter this total, matching the live turn.step.completed accumulation.
   */
  private turnTotal: TokenUsage | undefined;

  constructor(protected readonly agent?: Agent) {}

  beginTurn(): void {
    this.currentTurn = undefined;
  }

  endTurn(): void {
    this.currentTurn = undefined;
  }

  record(
    model: string,
    usage: TokenUsage,
    scope: UsageRecordScope = 'session',
    opts?: { skipCurrentTurn?: boolean },
  ): void {
    this.agent?.records.logRecord({
      type: 'usage.record',
      model,
      usage,
      usageScope: scope,
    });
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (scope === 'turn') {
      // Wire restore replays turn records to rebuild turnTotal, but must not
      // touch currentTurn — a resumed agent has no live turn (it stays
      // undefined until the next beginTurn).
      if (opts?.skipCurrentTurn !== true) {
        this.currentTurn =
          this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
      }
      this.turnTotal =
        this.turnTotal === undefined ? copyUsage(usage) : addUsage(this.turnTotal, usage);
    }
    this.agent?.emitStatusUpdated();
  }

  data(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = this.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
      ...(this.turnTotal !== undefined ? { turnTotal: copyUsage(this.turnTotal) } : {}),
    };
  }

  status(): UsageStatus | undefined {
    const status = this.data();
    if (
      status.byModel === undefined &&
      status.total === undefined &&
      status.currentTurn === undefined &&
      status.turnTotal === undefined
    ) {
      return undefined;
    }
    return status;
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}
