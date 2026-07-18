import { describe, expect, it } from 'vitest';

import { detectGoalConflict } from '#/tui/utils/goal-loop-conflict';

interface State {
  goalActive: boolean;
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    goalActive: false,
    ...overrides,
  };
}

describe('detectGoalConflict (/goal activation guard)', () => {
  it('returns null when no active goal', () => {
    expect(detectGoalConflict(makeState(), 'enable_goal')).toBeNull();
  });

  it('returns goal_active when a goal is already active', () => {
    const result = detectGoalConflict(
      makeState({ goalActive: true }),
      'enable_goal',
    );
    expect(result).toBe('goal_active');
  });
});
