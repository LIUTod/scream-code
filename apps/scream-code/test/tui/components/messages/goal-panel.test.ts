import { describe, expect, it } from 'vitest';

import type { GoalSnapshotData } from '@scream-cli/agent-core';

import { GoalStatusMessageComponent } from '#/tui/components/messages/goal-panel';
import { darkColors } from '#/tui/theme/colors';

function makeGoal(): GoalSnapshotData {
  return {
    goalId: 'goal-1',
    objective: 'Optimize render cache for message components',
    completionCriterion: 'All components cache and invalidate correctly',
    status: 'active',
    turnsUsed: 3,
    tokensUsed: 1250,
    wallClockMs: 45_000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      overBudget: false,
    },
    notes: [],
  };
}

describe('GoalStatusMessageComponent', () => {
  it('caches render output for the same width when a goal is active', () => {
    const component = new GoalStatusMessageComponent(makeGoal(), darkColors);

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('caches render output for the same width when no goal is active', () => {
    const component = new GoalStatusMessageComponent(null, darkColors);

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('recomputes after invalidate() is called', () => {
    const component = new GoalStatusMessageComponent(makeGoal(), darkColors);

    const first = component.render(80);
    component.invalidate();
    const second = component.render(80);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('recomputes when width changes', () => {
    const component = new GoalStatusMessageComponent(makeGoal(), darkColors);

    const narrow = component.render(40);
    const wide = component.render(80);

    expect(wide).not.toBe(narrow);
  });
});
