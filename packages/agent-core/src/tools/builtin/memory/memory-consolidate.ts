import { applyConsolidation, buildConsolidationPlan } from '@scream-code/memory';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

/**
 * The apply payload is deliberately id-based. The first version asked the model
 * to echo the whole plan back; on a real library that is ~85k tokens of tool
 * arguments, which no model can emit — the call arrives truncated and fails
 * validation. Sending ids plus the new text keeps it a few kilobytes.
 */
const MergeSchema = z.object({
  memoIds: z.array(z.string()).min(2).max(5).describe('Memories to replace, oldest to newest is fine.'),
  merged: z.object({
    userNeed: z.string().min(1).max(400),
    approach: z.string().min(1).max(800),
    outcome: z.string().min(1).max(200),
    whatFailed: z.string().max(800),
    whatWorked: z.string().max(800),
    tags: z.array(z.string()).max(8).optional(),
    distilled: z
      .string()
      .min(1)
      .max(200)
      .describe('One-sentence rule: the situation, the action, and what to expect.'),
  }),
  allowSupersede: z
    .boolean()
    .optional()
    .describe('Required to replace a memo that already carries a rule. Leave unset otherwise.'),
});

const DistillationSchema = z.object({
  memoId: z.string(),
  distilled: z
    .string()
    .min(1)
    .max(200)
    .describe('One-sentence rule distilled from this memo. The memo itself is kept.'),
});

const InductionSchema = z.object({
  topic: z.string().min(1).max(120),
  sourceMemoIds: z.array(z.string()).min(3).max(6).describe('Evidence memos. They are never modified.'),
  rule: z.object({
    userNeed: z.string().min(1).max(400),
    approach: z.string().min(1).max(800),
    distilled: z.string().min(1).max(200),
    tags: z.array(z.string()).max(8).optional(),
  }),
});

const ConsolidationApplySchema = z.object({
  merges: z
    .array(MergeSchema)
    .max(8)
    .optional()
    .describe('Near-duplicate groups to fold into one memory each. Omit when there are none.'),
  distillations: z
    .array(DistillationSchema)
    .max(15)
    .optional()
    .describe('Existing memories that gain a rule. Omit when there are none.'),
  inductions: z
    .array(InductionSchema)
    .max(4)
    .optional()
    .describe('New rules induced from several related memories; sources stay untouched. Omit when there are none.'),
});

export type MemoryConsolidateApplyInput = z.infer<typeof ConsolidationApplySchema>;

/**
 * Analyzes the memory memo store and proposes work for /dream: near-duplicate
 * groups to merge, memories that deserve a one-line rule, and themes that
 * suggest a new rule. Nothing in the plan is a deletion.
 */
export class MemoryConsolidatePlanTool implements BuiltinTool<Record<string, never>> {
  readonly name = 'MemoryConsolidatePlan' as const;
  readonly description =
    'Analyze the memory store and propose a dream pass. Returns duplicateGroups ' +
    '(memories that are the same experience written more than once — candidate merges), ' +
    'nearMisses (close but distinct, for judgement), distillCandidates (memories that ' +
    'should gain a one-sentence rule) and inductionClusters (memories sharing a theme ' +
    'that may hide one reusable rule). Nothing here is a deletion: the pass only merges ' +
    'duplicates you confirm, adds rules to existing memories, and adds new rule memories. ' +
    'It is incremental — a second run right after the first has almost nothing left. ' +
    'Only call this when the user has invoked /dream.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(z.object({}));

  constructor(private readonly agent: Agent) {}

  resolveExecution(): ToolExecution {
    return {
      description: 'Building dream plan',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        const plan = await buildConsolidationPlan(store);
        if (plan.summary.totalMemos === 0) {
          return { isError: false, output: 'The memory store is empty; nothing to dream about.' };
        }
        if (plan.summary.unseen === 0) {
          return {
            isError: false,
            output:
              'Every memory has already been through a dream pass; there is nothing new to integrate. ' +
              'That is a normal, complete result — report it and stop.',
          };
        }

        return { isError: false, output: JSON.stringify(plan) };
      },
    };
  }
}

/**
 * Applies one dream pass. Only an explicitly listed merge replaces anything, and
 * a merge is recorded so it can be undone; every other memory keeps its place.
 */
export class MemoryConsolidateApplyTool implements BuiltinTool<MemoryConsolidateApplyInput> {
  readonly name = 'MemoryConsolidateApply' as const;
  readonly description =
    'Apply one dream pass. merges: fold each listed near-duplicate group into one memory ' +
    '(the sources are replaced, and the merge is recorded so it can be undone). ' +
    'distillations: add a one-sentence rule to an existing memory; the memory and its ' +
    'origin are kept. inductions: add a new rule memory distilled from several related ' +
    'memories; those sources are not modified. Nothing else is touched — memories are ' +
    'never removed for being old. Entries that fail validation are reported back instead ' +
    'of failing the pass. Only call this after the user has confirmed what will change.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ConsolidationApplySchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MemoryConsolidateApplyInput): ToolExecution {
    return {
      description: 'Applying dream pass',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        const result = await applyConsolidation(store, {
          merges: (args.merges ?? []).map((merge) => ({
            memoIds: merge.memoIds,
            merged: merge.merged,
            ...(merge.allowSupersede === true ? { allowSupersede: true } : {}),
          })),
          distillations: args.distillations ?? [],
          inductions: args.inductions ?? [],
        });
        await this.agent.dreamTracker.recordDream();

        const parts = [
          `merged ${result.merged.length} group(s)`,
          `distilled ${result.distilled.length} memory(ies)`,
          `induced ${result.induced.length} new rule(s)`,
        ];
        const skipped = result.skipped.length === 0
          ? ''
          : ` Skipped ${result.skipped.length}: ${result.skipped
              .slice(0, 10)
              .map((entry) => `${entry.id} (${entry.reason})`)
              .join('; ')}${result.skipped.length > 10 ? '; …' : ''}`;
        const mergedIds = result.merged.map((entry) => entry.mergeId).join(', ');
        return {
          isError: false,
          output:
            `Dream pass complete: ${parts.join(', ')}.${skipped}` +
            (mergedIds === '' ? '' : ` Merge id(s) for undo: ${mergedIds}.`) +
            ' Report this to the user in their language; do not describe it as cleanup.',
        };
      },
    };
  }
}
