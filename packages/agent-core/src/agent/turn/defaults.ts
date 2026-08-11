/**
 * Centralized tunables for turn orchestration (`agent/turn`).
 *
 * Every threshold that shapes turn behavior lives here with a one-line
 * rationale, so tuning a turn is a single-file edit instead of a hunt across
 * `turn/index.ts` and friends. Values are referenced from the orchestration
 * code; keep this file the source of truth.
 *
 * Related thresholds outside this module (kept where they live because they
 * belong to other layers):
 * - compaction: `agent/compaction/micro.ts` (0.3, 1.15), `agent/compaction/strategy.ts` (0.85/0.9, 2.5)
 * - retry: `loop/retry.ts` (10 attempts, 0.5s→32s ±25%)
 * - steer polling: `loop/tool-call.ts` (150ms)
 * - step limits: `loop/run-turn.ts` (maxSteps, 8 consecutive rejected steps)
 * - tool output truncation: `agent/context/index.ts` (5000 tokens), `tools/support/result-builder.ts` (50KB)
 */

export const TURN_DEFAULTS = {
  /**
   * Convergence gate: max times the turn injects a `<system-reminder>` to
   * force continuation (empty step, missing TodoList for an active goal,
   * non-exploratory tool failure, failed verification). Bounded so a model
   * that can't converge ends the turn instead of looping forever.
   */
  maxConvergenceInjections: 5,

  /**
   * Final response length below which a reply counts as "trivial"
   * (e.g. just "done"). Triggers the summary guard that asks for a
   * structured deliverability summary before yielding.
   */
  minFinalResponseLength: 60,

  /**
   * Goal mode: max continuation turns when the goal has no explicit turn
   * budget. Prevents a goal from spinning forever and burning tokens.
   */
  maxGoalTurns: 50,
} as const;
