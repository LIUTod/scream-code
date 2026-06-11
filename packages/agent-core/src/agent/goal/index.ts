import { randomUUID } from 'node:crypto';

import { ErrorCodes, ScreamError } from '#/errors';
import type { Agent } from '..';
import type { AgentRecordOf } from '../records/types';

/**
 * Durable goal-mode state owned by {@link GoalMode}.
 *
 * Each agent keeps exactly one current goal, rebuilt from that agent's ordered
 * record log.
 */

/** Maximum objective length in characters. */
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

/** Maximum number of working notes kept per goal. */
const MAX_GOAL_NOTES = 10;
/** Maximum characters per note. */
const MAX_NOTE_LENGTH = 200;

export interface GoalNote {
  readonly content: string;
  readonly time: number;
}

const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
  notes: GoalNote[];
}

export interface GoalBudgetReport {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
  readonly notes: readonly GoalNote[];
}

export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

export type GoalChangeKind = 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
}

interface GoalReasonInput {
  readonly reason?: string;
}

export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';

export class GoalMode {
  private state: GoalState | undefined;

  constructor(private readonly agent: Agent) {}

  normalizeAfterReplay(): void {
    const state = this.state;
    if (state === undefined) return;

    state.wallClockResumedAt = undefined;

    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false, track: false });
      return;
    }

    if (state.status === 'active') {
      const reason = 'Paused after agent resume';
      this.applyStatus(state, 'paused');
      state.terminalReason = reason;
      this.persistState(state, { silent: true });
      this.appendStatusUpdate(state, 'runtime', reason);
      return;
    }
  }

  restoreCreate(record: AgentRecordOf<'goal.create'>): void {
    const state: GoalState = {
      goalId: record.goalId,
      objective: record.objective,
      completionCriterion: record.completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
      notes: [],
    };
    this.state = state;
  }

  restoreUpdate(record: AgentRecordOf<'goal.update'>): void {
    const state = this.state;
    if (state === undefined) return;

    const status = record.status;
    if (status !== undefined) {
      state.status = status;
      state.wallClockResumedAt = undefined;
      state.terminalReason = status === 'active' ? undefined : record.reason;
    }
    if (record.turnsUsed !== undefined) state.turnsUsed = record.turnsUsed;
    if (record.tokensUsed !== undefined) state.tokensUsed = record.tokensUsed;
    if (record.wallClockMs !== undefined) {
      state.wallClockMs = record.wallClockMs;
      state.wallClockResumedAt = undefined;
    }
    if (record.budgetLimits !== undefined) state.budgetLimits = record.budgetLimits;
  }

  restoreClear(_record: AgentRecordOf<'goal.clear'>): void {
    this.state = undefined;
  }

  // --- Reads ---

  getGoal(): GoalToolResult {
    const state = this.state;
    return { goal: state === undefined ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  // --- Creation ---

  async createGoal(input: CreateGoalInput, _actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new ScreamError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new ScreamError(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
      );
    }

    const existing = this.state;
    if (existing !== undefined) {
      if (input.replace !== true) {
        throw new ScreamError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
      this.clearInternal('system');
    }

    const completionCriterion = normalizeCompletionCriterion(input.completionCriterion);
    const state: GoalState = {
      goalId: randomUUID(),
      objective,
      completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits: {},
      notes: [],
    };

    this.persistState(state);
    this.agent.records.logRecord({
      type: 'goal.create',
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
    });
    return this.toSnapshot(state);
  }

  // --- User-owned lifecycle ---

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new ScreamError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async resumeGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new ScreamError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    state.terminalReason = undefined;
    this.applyStatus(state, 'active');
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'active', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async setBudgetLimits(
    input: { budgetLimits: GoalBudgetLimits },
    _actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    state.budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.persistState(state);
    this.appendGoalUpdate({ budgetLimits: state.budgetLimits });
    return this.toSnapshot(state);
  }

  async cancelGoal(actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    this.clearInternal(actor);
    if (actor === 'user') {
      this.agent.context.appendSystemReminder(GOAL_CANCELLED_REMINDER, {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      });
    }
    return snapshot;
  }

  // --- Terminal outcomes ---

  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'blocked');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'complete');
    state.terminalReason = input.reason;
    const snapshot = this.toSnapshot(state);
    this.appendStatusUpdate(state, actor, input.reason);
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason: input.reason,
      stats: this.statsOf(state),
      actor,
    });
    this.clearInternal(actor);
    return snapshot;
  }

  // --- User-interrupt transition ---

  async pauseOnInterrupt(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(input, 'user');
  }

  // --- Accounting & reporting ---

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const delta = Math.max(0, tokenDelta);
    state.tokensUsed += delta;
    this.persistState(state, { silent: true });
    this.appendGoalUpdate({ tokensUsed: state.tokensUsed });
    return this.toSnapshot(state);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    this.persistState(state);
    this.appendGoalUpdate({ turnsUsed: state.turnsUsed });
    return this.toSnapshot(state);
  }

  async addNote(content: string): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const trimmed = content.trim().slice(0, MAX_NOTE_LENGTH);
    if (trimmed.length === 0) return this.toSnapshot(state);
    state.notes.push({ content: trimmed, time: Date.now() });
    if (state.notes.length > MAX_GOAL_NOTES) {
      state.notes = state.notes.slice(-MAX_GOAL_NOTES);
    }
    this.persistState(state, { silent: true });
    return this.toSnapshot(state);
  }

  // --- Internals ---

  private clearInternal(
    actor: GoalActor,
    opts: { emit?: boolean; track?: boolean } = {},
  ): void {
    const state = this.state;
    if (state === undefined) return;
    this.persistState(undefined, { silent: opts.emit === false });
    this.agent.records.logRecord({ type: 'goal.clear' });
  }

  private appendStatusUpdate(state: GoalState, actor: GoalActor, reason?: string): void {
    this.appendGoalUpdate({
      status: state.status,
      reason,
      wallClockMs: liveWallClockMs(state, Date.now()),
      actor,
    });
  }

  private appendGoalUpdate(
    update: Omit<AgentRecordOf<'goal.update'>, 'type' | 'time'>,
  ): void {
    this.agent.records.logRecord({
      type: 'goal.update',
      ...update,
    });
  }

  private applyStatus(state: GoalState, status: GoalStatus): void {
    const now = Date.now();
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      state.wallClockMs += Math.max(0, now - state.wallClockResumedAt);
      state.wallClockResumedAt = undefined;
    }
    if (status === 'active') {
      state.wallClockResumedAt = now;
    }
    state.status = status;
  }

  private requireState(): GoalState {
    const state = this.state;
    if (state === undefined) {
      throw new ScreamError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }

  private persistState(
    state: GoalState | undefined,
    opts: { silent?: boolean; change?: GoalChange } = {},
  ): void {
    this.state = state;
    if (opts.silent !== true) {
      this.emitGoalUpdated(state === undefined ? null : this.toSnapshot(state), opts.change);
    }
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.agent.emitEvent({ type: 'goal.updated', snapshot, change });
  }

  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
      budget: computeBudgetReport(state, Date.now()),
      terminalReason: state.terminalReason,
      notes: state.notes,
    };
  }
}

function liveWallClockMs(state: GoalState, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, now - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

function computeBudgetReport(state: GoalState, now: number = Date.now()): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}
