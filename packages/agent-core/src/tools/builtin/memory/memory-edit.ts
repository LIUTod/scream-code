import type { MemoryMemo } from '@scream-code/memory';
import { normalizeTags } from '@scream-code/memory';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const MemoryEditInputSchema = z.object({
  id: z.string().describe('The id of the memory memo to edit or delete.'),
  action: z
    .enum(['update', 'delete'])
    .describe("'update' modifies the memo; 'delete' removes it permanently."),
  updates: z
    .object({
      userNeed: z.string().optional().describe('Updated user need or goal.'),
      approach: z.string().optional().describe('Updated approach taken.'),
      outcome: z.string().optional().describe('Updated outcome.'),
      whatFailed: z.string().optional().describe('Updated dead-ends notes.'),
      whatWorked: z.string().optional().describe('Updated successful actions.'),
      note: z
        .string()
        .optional()
        .describe('Updated advisory note that helps future AI reuse this memo.'),
      distilled: z
        .string()
        .max(200)
        .optional()
        .describe('Updated latest one-sentence conclusion (最新归纳) for this memo.'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Updated semantic tags (e.g. ["react", "auth", "部署"]).'),
    })
    .optional()
    .describe('Fields to update when action is update.'),
});

export type MemoryEditInput = z.infer<typeof MemoryEditInputSchema>;

/**
 * Lets the model or user correct or delete a single memory memo.
 * Use this when a stored memory is wrong, outdated, or should be removed.
 */
export class MemoryEditTool implements BuiltinTool<MemoryEditInput> {
  readonly name = 'MemoryEdit' as const;
  readonly description =
    'Update or delete a single memory memo by id. ' +
    'Use this when the user says a memory is wrong, outdated, or should be removed, ' +
    'or when you need to correct a specific memo after reviewing it. ' +
    'For updates, only the fields provided are changed; omitted fields are preserved. ' +
    'Deletion is permanent.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryEditInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MemoryEditInput): ToolExecution {
    return {
      description: args.action === 'delete' ? 'Deleting memory memo' : 'Updating memory memo',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        const existing = await store.get(args.id);
        if (existing === undefined) {
          return { isError: true, output: `Memory memo "${args.id}" not found.` };
        }

        if (args.action === 'delete') {
          await store.delete(args.id);
          return { isError: false, output: `Deleted memory memo "${args.id}".` };
        }

        const updates = args.updates ?? {};
        const patch: Partial<MemoryMemo> = {};
        if (updates.userNeed !== undefined) patch.userNeed = updates.userNeed;
        if (updates.approach !== undefined) patch.approach = updates.approach;
        if (updates.outcome !== undefined) patch.outcome = updates.outcome;
        if (updates.whatFailed !== undefined) patch.whatFailed = updates.whatFailed;
        if (updates.whatWorked !== undefined) patch.whatWorked = updates.whatWorked;
        if (updates.note !== undefined) patch.note = updates.note.trim().length > 0 ? updates.note : undefined;
        if (updates.distilled !== undefined) {
          const text = updates.distilled.trim();
          patch.distilled = text.length > 0 ? text : undefined;
          // A user-directed rewrite is authored by the user, not by /dream.
          // Clearing it also drops the lineage: it is no longer a rule.
          patch.origin = text.length > 0 ? 'user' : 'session';
          patch.distilledAt = text.length > 0 ? Date.now() : undefined;
          patch.distilledFrom = text.length > 0 ? existing.distilledFrom : undefined;
        }
        if (updates.tags !== undefined) patch.tags = normalizeTags(updates.tags);

        if (Object.keys(patch).length === 0) {
          return { isError: true, output: 'No updates provided.' };
        }

        await store.update(args.id, patch);
        return {
          isError: false,
          output: `Updated memory memo "${args.id}".`,
        };
      },
    };
  }
}
