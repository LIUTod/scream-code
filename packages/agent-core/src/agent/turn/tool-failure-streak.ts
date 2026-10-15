/**
 * Classification of a finished model-issued tool call for the consecutive-
 * failure circuit breaker (`agent/turn/index.ts`).
 *
 * `neutral` exists for aborted calls: the user (Ctrl-C, cancelled approval) or
 * a parent agent (interject) stopped the call, which says nothing about the
 * model's approach. Counting them as failures used to let a single batch of
 * user aborts (or ten cumulative aborts in one turn) trip the stop threshold
 * and end the turn with a "N consecutive tool calls have failed" report —
 * misattributing the user's own interrupt to the model. `blocked` results
 * (permission / guard denials) do count: repeatedly tripping a guard is
 * exactly the "change approach" case the breaker exists for.
 */

import type { ExecutableToolResult } from '../../loop/types';

export type ToolResultOutcome = 'failure' | 'neutral' | 'success';

export function classifyToolResult(result: ExecutableToolResult): ToolResultOutcome {
  if (result.isError === true) {
    return result.code === 'aborted' ? 'neutral' : 'failure';
  }
  return 'success';
}
