/**
 * Guard for /goal activation conflicts.
 *
 * Pure function — unit-tested in test/tui/commands/goal-loop-conflict.test.ts.
 */
export type GoalConflictKind = 'goal_active';

export function detectGoalConflict(
  state: { goalActive: boolean },
  _action: 'enable_goal',
): GoalConflictKind | null {
  if (state.goalActive) return 'goal_active';
  return null;
}
