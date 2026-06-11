import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const WriteGoalNoteInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'A concise note about what you learned, verified, or decided. ' +
          'Notes are injected into future continuation turns so you can build on prior work.',
      ),
  })
  .strict();

export type WriteGoalNoteInput = z.infer<typeof WriteGoalNoteInputSchema>;

export class WriteGoalNoteTool implements BuiltinTool<WriteGoalNoteInput> {
  readonly name = 'WriteGoalNote' as const;
  readonly description =
    'Record a working note during goal execution. Notes persist across continuation turns and are injected automatically. ' +
    'Use this to record facts you verified, dead ends you hit, decisions you made, or anything future-you should not re-derive.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteGoalNoteInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: WriteGoalNoteInput): ToolExecution {
    const goal = this.agent.goal;

    return {
      description: 'Writing a goal note',
      approvalRule: this.name,
      execute: async () => {
        const snapshot = await goal.addNote(args.content);
        if (snapshot === null) {
          return { output: JSON.stringify({ error: 'No active goal' }) };
        }
        return {
          output: JSON.stringify({
            recorded: true,
            totalNotes: snapshot.notes.length,
          }),
        };
      },
    };
  }
}
