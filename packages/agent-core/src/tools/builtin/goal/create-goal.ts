import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const CreateGoalToolInputSchema = z
  .object({
    objective: z.string().min(1).describe('The objective to pursue. Must have a verifiable end state.'),
    completionCriterion: z
      .string()
      .optional()
      .describe('How to verify the goal is complete. Include when the user provides one.'),
    replace: z
      .boolean()
      .optional()
      .describe('Replace an existing active or paused goal instead of failing.'),
  })
  .strict();

export type CreateGoalToolInput = z.infer<typeof CreateGoalToolInputSchema>;

export class CreateGoalTool implements BuiltinTool<CreateGoalToolInput> {
  readonly name = 'CreateGoal' as const;
  readonly description = 'Create a durable goal for the current session. The goal becomes structured state that the agent pursues autonomously through continuation turns until completion or blockage.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CreateGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: CreateGoalToolInput): ToolExecution {
    const goal = this.agent.goal;

    return {
      description: 'Creating a goal',
      approvalRule: this.name,
      execute: async () => {
        const snapshot = await goal.createGoal(
          {
            objective: args.objective,
            completionCriterion: args.completionCriterion,
            replace: args.replace,
          },
          'model',
        );
        return { output: JSON.stringify({ goal: snapshot }, null, 2) };
      },
    };
  }
}
