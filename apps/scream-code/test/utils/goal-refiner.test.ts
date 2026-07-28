import { describe, expect, it, vi } from 'vitest';

import { MAX_REFINED_GOAL_LENGTH, parseRefinedGoal, refineGoal } from '#/utils/goal-refiner';

describe('goal refiner', () => {
  it('normalizes common model wrappers while preserving the objective', () => {
    expect(parseRefinedGoal('```text\nObjective: "Refactor auth safely"\n```', 'raw')).toBe('Refactor auth safely');
  });

  it('falls back to the trimmed description for empty or overlong output', () => {
    expect(parseRefinedGoal('   ', '  keep the raw task  ')).toBe('keep the raw task');
    expect(parseRefinedGoal('x'.repeat(MAX_REFINED_GOAL_LENGTH + 1), 'fallback')).toBe('fallback');
  });

  it('uses the shared prompt and falls back when generation fails', async () => {
    const generateText = vi
      .fn<(systemPrompt: string, userPrompt: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce('Goal: Ship the Web API');

    await expect(refineGoal({ generateText }, '  raw objective  ')).resolves.toBe('raw objective');
    await expect(refineGoal({ generateText }, 'web api')).resolves.toBe('Ship the Web API');

    expect(generateText.mock.calls[1]?.[0]).toContain('one clear, actionable objective');
    expect(generateText.mock.calls[1]?.[1]).toBe('web api');
  });
});
