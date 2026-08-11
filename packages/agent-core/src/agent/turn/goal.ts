/**
 * Goal-driving prompts and origins used by TurnFlow's goal mode.
 *
 * Extracted from agent/turn/index.ts so the goal semantics (continuation
 * prompts, budget steers, origins) live next to the goal machinery without
 * bloating the turn orchestration class.
 */

import type { PromptOrigin } from '../context';

export const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far. Goal mode is iterative: do one coherent slice of work, then',
  'reassess. Call UpdateGoal with `complete` only when all required work is done, any stated',
  'validation has passed, and there is no useful next action. Do not mark complete after only',
  'producing a plan, summary, first pass, or partial result. If an external condition or required',
  'user input prevents progress, call UpdateGoal with `blocked` and include a `reason`. The goal',
  'will only be marked blocked after you report the same blocker for at least 3 consecutive',
  'turns, so first try alternative approaches. Otherwise keep going — use the existing',
  'conversation context and your tools, and do not ask the user for input unless a real blocker',
  'prevents progress.',
].join(' ');

export const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};

export const GOAL_BUDGET_STEER_PROMPT =
  'Budget nearly exhausted. Wrap up immediately: verify your work, run tests, ' +
  'and call UpdateGoal with status "complete" or "blocked". Do not start any new work.';

export const GOAL_BUDGET_STEER_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_budget_steer',
};

