import type { Agent } from '#/agent';
import { z } from 'zod';

import {
  GOAL_BLOCKED_REMINDER_NAME,
  GOAL_COMPLETION_REMINDER_NAME,
} from '../../../agent/goal';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
  buildGradingFeedbackPrompt,
} from './outcome-prompts';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export type GoalGraderFn = (
  objective: string,
  criterion: string | undefined,
  output: string,
) => Promise<unknown>;

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'paused', 'blocked'])
      .describe('The lifecycle status to set for the current goal.'),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

const MAX_GRADER_OUTPUT_CHARS = 4000;

function extractRecentOutput(history: readonly { role: string; content: { type: string; text?: string }[] }[]): string {
  const parts: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === undefined || msg.role !== 'assistant') continue;
    const text = msg.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (text) parts.unshift(text);
    const total = parts.join('\n\n');
    if (total.length >= MAX_GRADER_OUTPUT_CHARS) break;
  }
  const joined = parts.join('\n\n');
  return joined.length > MAX_GRADER_OUTPUT_CHARS ? `${joined.slice(0, MAX_GRADER_OUTPUT_CHARS)}…` : joined;
}

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description = "Update the current goal's lifecycle status. Use `complete` when the goal is achieved, `blocked` when you cannot proceed, `paused` to park it, or `active` to resume.";
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly grader: GoalGraderFn,
  ) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    const goal = this.agent.goal;

    return {
      description: `Setting goal status: ${args.status}`,
      approvalRule: this.name,
      execute: async () => {
        if (args.status === 'active') {
          await goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (args.status === 'complete') {
          return this.handleComplete(goal);
        }
        if (args.status === 'blocked') {
          const blocked = await goal.markBlocked({}, 'model');
          if (blocked !== null) {
            this.agent.context.appendSystemReminder(buildGoalBlockedReasonPrompt(blocked), {
              kind: 'system_trigger',
              name: GOAL_BLOCKED_REMINDER_NAME,
            });
          }
          return { output: 'Goal marked blocked.', stopTurn: true };
        }
        await goal.pauseGoal({}, 'model');
        return { output: 'Goal paused.', stopTurn: true };
      },
    };
  }

  private async handleComplete(goal: Agent['goal']): Promise<ExecutableToolResult> {
    const goalState = goal.getGoal().goal;
    if (!goalState) return { output: 'No active goal.' };

    const output = extractRecentOutput(this.agent.context.history);

    // Pause goal to prevent continuation loop from interfering during grading.
    try {
      await goal.pauseGoal({ reason: 'verifying' }, 'system');
    } catch (error) {
      return toolError(`Failed to pause goal for verification: ${errorMessage(error)}`, goal);
    }

    let rawGrade: unknown;
    try {
      rawGrade = await this.grader(goalState.objective, goalState.completionCriterion, output);
    } catch (error) {
      const resumeError = await resumeAfterGrading(goal);
      if (resumeError !== undefined) return resumeError;
      const reason = `Goal verification could not be completed: ${errorMessage(error)}`;
      this.appendGradingFeedback(reason);
      return {
        isError: true,
        output: `${reason}. Continue working.`,
      };
    }

    const resumeError = await resumeAfterGrading(goal);
    if (resumeError !== undefined) return resumeError;

    const grade = parseGrade(rawGrade);
    if (grade === undefined) {
      const reason = 'Goal verification could not be completed: grader returned an invalid result';
      this.appendGradingFeedback(reason);
      return {
        isError: true,
        output: `${reason}. Continue working.`,
      };
    }

    if (grade.pass) {
      try {
        const completed = await goal.markComplete({}, 'model');
        if (completed === null) {
          return toolError('Failed to mark verified goal complete', goal);
        }
        this.agent.context.appendSystemReminder(buildGoalCompletionSummaryPrompt(completed), {
          kind: 'system_trigger',
          name: GOAL_COMPLETION_REMINDER_NAME,
        });
      } catch (error) {
        return toolError(`Failed to mark verified goal complete: ${errorMessage(error)}`, goal);
      }
      return { output: `Goal verified and marked complete.\n${grade.reason}`, stopTurn: true };
    }

    this.appendGradingFeedback(grade.reason);
    return { output: `Verification failed: ${grade.reason}. Continue working.` };
  }

  private appendGradingFeedback(reason: string): void {
    this.agent.context.appendSystemReminder(buildGradingFeedbackPrompt(reason), {
      kind: 'system_trigger',
      name: 'goal_grading_feedback',
    });
  }
}

function parseGrade(value: unknown): { readonly pass: boolean; readonly reason: string } | undefined {
  if (typeof value !== 'object' || value === null) return;
  const { pass, reason } = value as { readonly pass?: unknown; readonly reason?: unknown };
  if (typeof pass !== 'boolean' || typeof reason !== 'string' || reason.trim().length === 0) return;
  return { pass, reason };
}

async function resumeAfterGrading(goal: Agent['goal']): Promise<ExecutableToolResult | undefined> {
  try {
    await goal.resumeGoal({}, 'system');
    return;
  } catch (error) {
    return toolError(`Failed to restore active goal after verification: ${errorMessage(error)}`, goal);
  }
}

function toolError(message: string, goal: Agent['goal']): ExecutableToolResult {
  const status = goal.getGoal().goal?.status ?? 'missing';
  return {
    isError: true,
    output: `${message}. Current goal status: ${status}.`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
