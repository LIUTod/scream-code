import type { Session } from '@scream-code/scream-code-sdk';

import GOAL_REFINER_SYSTEM_PROMPT from './goal-refiner.md';

export const MAX_REFINED_GOAL_LENGTH = 200;

/**
 * Normalize an LLM-refined objective. Invalid output falls back to the user's
 * original description so refinement never loses the requested task.
 */
export function parseRefinedGoal(rawOutput: string, fallback: string): string {
  const normalized = rawOutput
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
    .replace(/^(?:objective|goal)\s*:\s*/i, '')
    .replace(/^["'“‘](.*)["'”’]$/s, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (normalized.length === 0 || normalized.length > MAX_REFINED_GOAL_LENGTH) {
    return fallback.trim();
  }
  return normalized;
}

/** Refine a goal through the session LLM, with a deterministic raw-input fallback. */
export async function refineGoal(session: Pick<Session, 'generateText'>, description: string): Promise<string> {
  const fallback = description.trim();
  if (fallback.length === 0) return '';

  try {
    const output = await session.generateText(GOAL_REFINER_SYSTEM_PROMPT, fallback);
    return parseRefinedGoal(output, fallback);
  } catch {
    return fallback;
  }
}
