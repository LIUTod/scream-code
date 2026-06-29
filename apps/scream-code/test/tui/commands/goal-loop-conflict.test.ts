import { describe, expect, it } from 'vitest';

import { detectGoalLoopConflict } from '#/tui/utils/goal-loop-conflict';

interface State {
  goalActive: boolean;
  loopModeEnabled: boolean;
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    goalActive: false,
    loopModeEnabled: false,
    ...overrides,
  };
}

describe('detectGoalLoopConflict (Storm Breaker /goal + /loop guard)', () => {
  it('returns null when enabling loop with no active goal', () => {
    expect(detectGoalLoopConflict(makeState(), 'enable_loop')).toBeNull();
  });

  it('returns null when enabling goal with loop disabled', () => {
    expect(detectGoalLoopConflict(makeState(), 'enable_goal')).toBeNull();
  });

  it('returns goal_active when enabling loop while a goal is active', () => {
    const result = detectGoalLoopConflict(
      makeState({ goalActive: true }),
      'enable_loop',
    );
    expect(result).toBe('goal_active');
  });

  it('returns loop_active when enabling goal while loop is enabled', () => {
    const result = detectGoalLoopConflict(
      makeState({ loopModeEnabled: true }),
      'enable_goal',
    );
    expect(result).toBe('loop_active');
  });

  it('returns null when enabling loop while loop is already enabled (no goal)', () => {
    // loop already on, goal off — enabling loop again is a no-op toggle, not a conflict.
    expect(
      detectGoalLoopConflict(makeState({ loopModeEnabled: true }), 'enable_loop'),
    ).toBeNull();
  });

  it('returns null when enabling goal while a goal is already active (no loop)', () => {
    // goal already on, loop off — enabling goal again is a replace, not a conflict.
    expect(
      detectGoalLoopConflict(makeState({ goalActive: true }), 'enable_goal'),
    ).toBeNull();
  });

  it('returns goal_active when both are active and user tries to enable loop', () => {
    // Both on (somehow) — enabling loop still conflicts with the active goal.
    const result = detectGoalLoopConflict(
      makeState({ goalActive: true, loopModeEnabled: true }),
      'enable_loop',
    );
    expect(result).toBe('goal_active');
  });

  it('returns loop_active when both are active and user tries to enable goal', () => {
    const result = detectGoalLoopConflict(
      makeState({ goalActive: true, loopModeEnabled: true }),
      'enable_goal',
    );
    expect(result).toBe('loop_active');
  });
});
