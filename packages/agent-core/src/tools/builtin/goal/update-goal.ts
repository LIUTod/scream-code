import type { Agent } from '#/agent';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

import type { GoalNote } from '../../../agent/goal';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
  buildGradingFeedbackPrompt,
} from './outcome-prompts';
import { GraderEmissionGuard } from './emission-guard';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

/**
 * Reminder names the goal tools attach to follow-up user messages.
 * Defined locally (not in the goal engine) so `tools/` never value-imports
 * the orchestration layer — see agent-core dependency direction rules.
 */
export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';

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
    reason: z
      .string()
      .optional()
      .describe('Optional reason for the status change, especially for blocked.'),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

const MAX_GRADER_OUTPUT_CHARS = 4000;
/** Maximum characters of `git diff --stat HEAD` to append to the grader input. */
const MAX_DIFF_STAT_CHARS = 2000;

/**
 * Module-level emission guard. Deduplicates grader FAIL feedback per goal so
 * the referee cannot trap the agent in a loop by repeating the same reason.
 */
const graderEmissionGuard = new GraderEmissionGuard();

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

/**
 * Append cross-turn working notes to the output seen by the grader. Notes are
 * written by the agent across continuation turns, so they provide focused
 * context (key findings, constraints, partial results) without exposing the
 * full text of previously rejected outputs.
 */
function appendGoalNotes(output: string, notes: readonly GoalNote[]): string {
  if (notes.length === 0) return output;
  const noteLines = notes.map((note) => `• ${note.content}`).join('\n');
  return `${output}\n\n## Cross-turn working notes\n${noteLines}`;
}

const execFileAsync = promisify(execFile);

/**
 * Fetch a concise git diff stat against HEAD for the current working directory.
 * Using HEAD includes both staged and unstaged changes, so the reviewer sees
 * every file touched during the turn even if the agent ran `git add`. Returns
 * `null` when there are no changes. Throws when git is unavailable or the
 * directory is not a git repository.
 */
/** Exported for testing only. */
export async function fetchGitDiffStat(cwd: string): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], { cwd });
  const stat = stdout.trim();
  return stat.length > 0 ? stat : null;
}

/**
 * Append a git diff stat to the grader input so the reviewer can correlate the
 * agent's claims with the actual files changed during the turn. Very large
 * stats are truncated to avoid overflowing the reviewer's context window. When
 * git is unavailable, a note is appended so the reviewer knows why no diff is
 * present.
 */
async function appendGitDiffStat(output: string, cwd: string): Promise<string> {
  let stat: string | null;
  try {
    stat = await fetchGitDiffStat(cwd);
  } catch {
    return `${output}\n\n## Changes this turn\n(Git diff unavailable — workspace may not be a git repository or git is not installed.)`;
  }
  if (stat === null) return output;
  const trimmed =
    stat.length > MAX_DIFF_STAT_CHARS
      ? `${stat.slice(0, MAX_DIFF_STAT_CHARS)}…\n(diff stat truncated)`
      : stat;
  return `${output}\n\n## Changes this turn\n${trimmed}`;
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
          const blocked = await goal.markBlocked(
            args.reason !== undefined ? { reason: args.reason } : {},
            'model',
          );
          if (blocked !== null) {
            this.agent.context.appendSystemReminder(buildGoalBlockedReasonPrompt(blocked), {
              kind: 'system_trigger',
              name: GOAL_BLOCKED_REMINDER_NAME,
            });
            return { output: 'Goal marked blocked.', stopTurn: true };
          }
          // Not enough consecutive blocked attempts; goal stays active.
          return {
            output: 'Goal remains active. Report the same blocker in subsequent turns to confirm it cannot be resolved. Continue working on the goal in the meantime.',
          };
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
    const outputWithNotes = appendGoalNotes(output, goalState.notes);
    const outputWithContext = await appendGitDiffStat(outputWithNotes, this.agent.config?.cwd ?? '');

    // Pause goal to prevent continuation loop from interfering during grading.
    try {
      await goal.pauseGoal({ reason: 'verifying' }, 'system');
    } catch (error) {
      return toolError(`Failed to pause goal for verification: ${errorMessage(error)}`, goal);
    }

    let rawGrade: unknown;
    try {
      rawGrade = await this.grader(goalState.objective, goalState.completionCriterion, outputWithContext);
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
        // Clear the emission-guard dedup bucket for this goal so a subsequent
        // goal with the same objective does not inherit stale dedup state.
        // Called after markComplete resolves (whether null or a snapshot) so
        // the bucket is cleared as soon as the referee accepts the goal.
        graderEmissionGuard.resetGoal(goalState.objective);
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

    // Deduplicate grader feedback before injection. If the referee repeats a
    // reason already seen for this goal, skip injecting it into context (the
    // agent already has the earlier feedback) and nudge it to address that.
    const denoised = graderEmissionGuard.filter(grade.reason, goalState.objective);
    if (denoised !== null) {
      this.appendGradingFeedback(denoised);
      return { output: `Verification failed: ${denoised}. Continue working.` };
    }
    return {
      output:
        'Previous verification feedback still applies. Address the earlier feedback and retry.',
    };
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
