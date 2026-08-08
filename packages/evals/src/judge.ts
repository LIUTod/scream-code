/**
 * Rule-based judge helpers for eval assertions. Pure functions — no LLM
 * involved — so the same checks that gate the interactive agent also gate
 * eval runs deterministically.
 */

export interface JudgeRule {
  readonly name: string;
  readonly check: (input: string) => boolean;
}

export interface JudgeOutcome {
  readonly passed: readonly string[];
  readonly failed: readonly string[];
}

/** Runs every rule against the input; a rule passes when its check is true. */
export function judgeOutput(input: string, rules: readonly JudgeRule[]): JudgeOutcome {
  const passed: string[] = [];
  const failed: string[] = [];
  for (const rule of rules) {
    if (rule.check(input)) {
      passed.push(rule.name);
    } else {
      failed.push(rule.name);
    }
  }
  return { passed, failed };
}

/** Throws with a readable diff when any rule failed. */
export function assertEvalPassed(outcome: JudgeOutcome): void {
  if (outcome.failed.length === 0) return;
  throw new Error(
    `Eval failed ${outcome.failed.length} rule(s): ${outcome.failed.join(', ')}. ` +
      `Passed: ${outcome.passed.length > 0 ? outcome.passed.join(', ') : '(none)'}`,
  );
}

/** Rule helpers for common cases. */
export const contains = (needle: string): JudgeRule => ({
  name: `contains "${needle}"`,
  check: (input) => input.includes(needle),
});

export const matches = (pattern: RegExp): JudgeRule => ({
  name: `matches ${String(pattern)}`,
  check: (input) => pattern.test(input),
});
