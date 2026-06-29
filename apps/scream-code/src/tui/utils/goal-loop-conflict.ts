/**
 * Storm Breaker guard for the /goal ↔ /loop semantic conflict.
 *
 * - /loop = stateless retry: each iteration re-sends the same prompt and the
 *   agent has no memory of the previous round's output.
 * - /goal = stateful iteration: the agent iterates against an objective with
 *   working notes carried across rounds.
 *
 * Enabling both simultaneously is a user error — loop's per-round context
 * reset would destroy goal's working notes, or goal's state would be
 * silently overwritten by loop's prompt replay. The guard returns the kind
 * of conflict so the caller can render a Storm Breaker notice; the notice
 * copy lives in the caller, not here, so message wording stays with the
 * user-facing command code.
 *
 * Pure function — unit-tested in test/tui/commands/goal-loop-conflict.test.ts.
 */
export type GoalLoopConflictKind = 'goal_active' | 'loop_active';

export function detectGoalLoopConflict(
  state: { goalActive: boolean; loopModeEnabled: boolean },
  action: 'enable_loop' | 'enable_goal',
): GoalLoopConflictKind | null {
  if (action === 'enable_loop' && state.goalActive) return 'goal_active';
  if (action === 'enable_goal' && state.loopModeEnabled) return 'loop_active';
  return null;
}
