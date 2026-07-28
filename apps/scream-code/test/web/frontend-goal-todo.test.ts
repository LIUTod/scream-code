import { describe, expect, it } from 'vitest';

import type {
  GoalSnapshot,
  JournalEvent,
  SessionSnapshot,
  TodoItem,
} from '../../src/web/frontend/src/types';
import {
  acceptJournalEvent,
  applyGoalTodoEvent,
  buildCreateGoalBody,
  buildUpdateGoalBody,
  canApplySnapshot,
  groupTodosByPhase,
  isCurrentSessionRequest,
} from '../../src/web/frontend/src/utils/goalTodoState';

function goal(objective: string): GoalSnapshot {
  return {
    goalId: `goal-${objective}`,
    objective,
    status: 'active',
    turnsUsed: 2,
    tokensUsed: 1200,
    wallClockMs: 60_000,
    budget: {
      tokenBudget: 5000,
      turnBudget: 10,
      wallClockBudgetMs: 1_800_000,
      remainingTokens: 3800,
      remainingTurns: 8,
      remainingWallClockMs: 1_740_000,
      overBudget: false,
    },
    notes: [{ content: '已完成协议核对', time: 100 }],
  };
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-a',
    workDir: '/tmp/project',
    seq: 8,
    epoch: 2,
    messages: [],
    pendingApprovals: [],
    status: { busy: false },
    busy: false,
    createdAt: 1,
    title: '测试会话',
    model: 'test-model',
    permission: 'manual',
    goal: goal('snapshot goal'),
    todos: [{ title: 'snapshot todo', status: 'pending' }],
    ...overrides,
  };
}

function journalEvent(seq: number, epoch: number): JournalEvent {
  return {
    type: 'event',
    seq,
    epoch,
    payload: { type: 'goal.updated', snapshot: goal('event goal') },
  };
}

describe('Web Goal/Todo state', () => {
  it('replaces Goal and Todo only from their complete core event snapshots', () => {
    const initial = {
      goal: goal('old goal'),
      todos: [{ title: 'old todo', status: 'pending' }] satisfies TodoItem[],
    };

    const afterGoal = applyGoalTodoEvent(initial, {
      type: 'goal.updated',
      snapshot: goal('new goal'),
    });
    expect(afterGoal.goal?.objective).toBe('new goal');
    expect(afterGoal.todos).toEqual(initial.todos);

    const nextTodos: TodoItem[] = [
      { title: '实现状态接入', status: 'done', phase: '前端' },
      { title: '运行聚焦测试', status: 'in_progress', phase: '验证' },
    ];
    const afterTodos = applyGoalTodoEvent(afterGoal, { type: 'todo.updated', todos: nextTodos });
    expect(afterTodos.goal).toBe(afterGoal.goal);
    expect(afterTodos.todos).toBe(nextTodos);

    expect(applyGoalTodoEvent(afterTodos, { type: 'tool.result', output: 'not a todo source' })).toBe(afterTodos);
  });

  it('groups Todo by first phase appearance while preserving item order', () => {
    const todos: TodoItem[] = [
      { title: 'A1', status: 'done', phase: '阶段 A' },
      { title: '无阶段 1', status: 'pending' },
      { title: 'B1', status: 'in_progress', phase: '阶段 B' },
      { title: 'A2', status: 'pending', phase: '阶段 A' },
      { title: '无阶段 2', status: 'done' },
      { title: 'B2', status: 'pending', phase: '阶段 B' },
    ];

    expect(groupTodosByPhase(todos)).toEqual([
      { phase: '阶段 A', items: [todos[0], todos[3]] },
      { phase: null, items: [todos[1], todos[4]] },
      { phase: '阶段 B', items: [todos[2], todos[5]] },
    ]);
  });
});

describe('Web session race guards', () => {
  const baseInput = {
    snapshot: snapshot(),
    targetSessionId: 'session-a',
    currentSessionId: 'session-a' as string | null,
    targetSessionGeneration: 4,
    currentSessionGeneration: 4,
    targetConnectionGeneration: 7,
    currentConnectionGeneration: 7,
    targetPromptGeneration: 3,
    currentPromptGeneration: 3,
    targetLiveGeneration: 12,
    currentLiveGeneration: 12,
    currentEpoch: 2,
    currentSeq: 8,
  };

  it('accepts only the current session/connection generation and a non-stale snapshot', () => {
    expect(canApplySnapshot(baseInput)).toBe(true);
    expect(canApplySnapshot({ ...baseInput, currentSessionId: 'session-b' })).toBe(false);
    expect(canApplySnapshot({ ...baseInput, currentSessionGeneration: 5 })).toBe(false);
    expect(canApplySnapshot({ ...baseInput, currentConnectionGeneration: 8 })).toBe(false);
    expect(canApplySnapshot({ ...baseInput, currentPromptGeneration: 4 })).toBe(false);
    expect(canApplySnapshot({ ...baseInput, currentLiveGeneration: 13 })).toBe(false);
    expect(canApplySnapshot({ ...baseInput, snapshot: snapshot({ epoch: 1 }) })).toBe(false);
    expect(canApplySnapshot({ ...baseInput, snapshot: snapshot({ seq: 7 }) })).toBe(false);
  });

  it('rejects old HTTP responses after a session switch or deletion generation bump', () => {
    expect(isCurrentSessionRequest('session-a', 9, 'session-a', 9)).toBe(true);
    expect(isCurrentSessionRequest('session-b', 10, 'session-a', 9)).toBe(false);
    expect(isCurrentSessionRequest(null, 10, 'session-a', 9)).toBe(false);
  });

  it('deduplicates replayed seq and requests resync across epochs', () => {
    expect(acceptJournalEvent(2, 8, journalEvent(9, 2))).toBe('apply');
    expect(acceptJournalEvent(2, 8, journalEvent(8, 2))).toBe('duplicate');
    expect(acceptJournalEvent(2, 8, journalEvent(9, 3))).toBe('resync');
    expect(acceptJournalEvent(0, 0, journalEvent(1, 3))).toBe('apply');
  });
});

describe('Web Goal REST bodies', () => {
  it('matches POST /goal create fields and budget units', () => {
    const body = buildCreateGoalBody({
      objective: '完成 Web Goal',
      completionCriterion: '测试与构建通过',
      replace: false,
      budgets: [
        { value: 12, unit: 'turns' },
        { value: 30_000, unit: 'tokens' },
        { value: 45, unit: 'minutes' },
      ],
    });

    expect(body).toEqual({
      objective: '完成 Web Goal',
      completionCriterion: '测试与构建通过',
      replace: false,
      budgets: [
        { value: 12, unit: 'turns' },
        { value: 30_000, unit: 'tokens' },
        { value: 45, unit: 'minutes' },
      ],
    });
  });

  it('matches PATCH /goal and omits undefined fields when serialized', () => {
    const body = buildUpdateGoalBody({
      objective: undefined,
      budgets: [{ value: 60, unit: 'minutes' }],
    });

    expect(JSON.parse(JSON.stringify(body))).toEqual({
      budgets: [{ value: 60, unit: 'minutes' }],
    });
  });
});
