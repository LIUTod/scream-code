import type {
  CreateGoalRequest,
  GoalSnapshot,
  JournalEvent,
  SessionSnapshot,
  TodoItem,
  UpdateGoalRequest,
} from '../types';

export interface GoalTodoState {
  goal: GoalSnapshot | null;
  todos: TodoItem[];
}

export interface GoalUpdatedPayload {
  type: 'goal.updated';
  snapshot: GoalSnapshot | null;
}

export interface TodoUpdatedPayload {
  type: 'todo.updated';
  todos: TodoItem[];
}

export interface TodoGroup {
  phase: string | null;
  items: TodoItem[];
}

export function isCurrentSessionRequest(
  currentSessionId: string | null,
  currentGeneration: number,
  targetSessionId: string,
  targetGeneration: number,
): boolean {
  return currentSessionId === targetSessionId && currentGeneration === targetGeneration;
}

export function canApplySnapshot(input: {
  snapshot: SessionSnapshot;
  targetSessionId: string;
  currentSessionId: string | null;
  targetSessionGeneration: number;
  currentSessionGeneration: number;
  targetConnectionGeneration: number;
  currentConnectionGeneration: number;
  targetPromptGeneration: number;
  currentPromptGeneration: number;
  targetLiveGeneration: number;
  currentLiveGeneration: number;
  currentEpoch: number;
  currentSeq: number;
}): boolean {
  return input.currentSessionId === input.targetSessionId
    && input.snapshot.sessionId === input.targetSessionId
    && input.currentSessionGeneration === input.targetSessionGeneration
    && input.currentConnectionGeneration === input.targetConnectionGeneration
    && input.currentPromptGeneration === input.targetPromptGeneration
    && input.currentLiveGeneration === input.targetLiveGeneration
    && (input.currentEpoch === 0 || input.snapshot.epoch === input.currentEpoch)
    && (input.snapshot.epoch !== input.currentEpoch || input.snapshot.seq >= input.currentSeq);
}

export function buildCreateGoalBody(request: CreateGoalRequest): Record<string, unknown> {
  return {
    objective: request.objective,
    completionCriterion: request.completionCriterion,
    replace: request.replace,
    budgets: request.budgets,
  };
}

export function buildUpdateGoalBody(request: UpdateGoalRequest): Record<string, unknown> {
  return {
    objective: request.objective,
    budgets: request.budgets,
  };
}

/**
 * Journal frame gate. A seq *gap within the same epoch* is intentionally
 * NOT treated as 'resync': after any disconnect the client re-baselines via
 * `client_hello {lastSeq, epoch}` + a full snapshot fetch, and replayed
 * frames legitimately jump seq. Only an epoch change means the stream was
 * rebuilt server-side and local state must be re-synced.
 */
export function acceptJournalEvent(currentEpoch: number, currentSeq: number, event: JournalEvent): 'apply' | 'duplicate' | 'resync' {
  if (currentEpoch !== 0 && event.epoch !== currentEpoch) return 'resync';
  return event.seq <= currentSeq ? 'duplicate' : 'apply';
}

export function applyGoalTodoEvent(
  state: GoalTodoState,
  payload: { type: string; [key: string]: unknown },
): GoalTodoState {
  if (payload.type === 'goal.updated') {
    return { ...state, goal: (payload as unknown as GoalUpdatedPayload).snapshot };
  }
  if (payload.type === 'todo.updated') {
    return { ...state, todos: (payload as unknown as TodoUpdatedPayload).todos };
  }
  return state;
}

/** Groups by phase in first-appearance order and preserves item order in each group. */
export function groupTodosByPhase(todos: readonly TodoItem[]): TodoGroup[] {
  const groups: TodoGroup[] = [];
  const indexes = new Map<string | null, number>();
  for (const todo of todos) {
    const phase = todo.phase ?? null;
    let index = indexes.get(phase);
    if (index === undefined) {
      index = groups.length;
      indexes.set(phase, index);
      groups.push({ phase, items: [] });
    }
    groups[index]!.items.push(todo);
  }
  return groups;
}
