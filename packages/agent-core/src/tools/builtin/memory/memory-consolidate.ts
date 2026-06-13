import {
  applyConsolidation,
  buildConsolidationPlan,
  type ConsolidationPlan,
} from '@scream-code/memory';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const MemoryMemoSummarySchema = z.object({
  id: z.string(),
  sourceSessionId: z.string(),
  sourceSessionTitle: z.string().optional(),
  userNeed: z.string(),
  approach: z.string(),
  outcome: z.string(),
  whatFailed: z.string(),
  whatWorked: z.string(),
  extractionSource: z.string(),
  recordedAt: z.number(),
});

const DuplicateGroupSchema = z.object({
  memos: z.array(MemoryMemoSummarySchema),
  merged: z.object({
    userNeed: z.string(),
    approach: z.string(),
    outcome: z.string(),
    whatFailed: z.string(),
    whatWorked: z.string(),
  }),
  reason: z.string(),
});

const ConsolidationPlanSchema = z.object({
  duplicateGroups: z.array(DuplicateGroupSchema),
  resolved: z.array(MemoryMemoSummarySchema),
  stale: z.array(MemoryMemoSummarySchema),
  summary: z.object({
    totalMemos: z.number(),
    duplicatesFound: z.number(),
    resolvedFound: z.number(),
    staleFound: z.number(),
    memosAfterConsolidation: z.number(),
  }),
});

export type MemoryConsolidateApplyInput = z.infer<typeof ConsolidationPlanSchema>;

/**
 * Produces a consolidation plan for the global memory memo store: near-duplicate
 * groups, resolved entries, and stale entries. The model should present this plan
 * to the user and ask for confirmation before applying it.
 */
export class MemoryConsolidatePlanTool implements BuiltinTool<Record<string, never>> {
  readonly name = 'MemoryConsolidatePlan' as const;
  readonly description =
    'Analyze the global memory memo store and produce a consolidation plan. ' +
    'The plan includes groups of near-duplicate memos to merge, resolved (completed) ' +
    'memos to remove, and stale memos to prune. Only call this when the user has ' +
    'invoked /dream. Present the returned plan to the user and ask for confirmation ' +
    'before calling MemoryConsolidateApply.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(z.object({}));

  constructor(private readonly agent: Agent) {}

  resolveExecution(): ToolExecution {
    return {
      description: 'Building memory consolidation plan',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        const plan = await buildConsolidationPlan(store);
        if (plan.summary.totalMemos === 0) {
          return {
            isError: false,
            output: 'The memory memo store is empty; nothing to consolidate.',
          };
        }

        return {
          isError: false,
          output: JSON.stringify(plan),
        };
      },
    };
  }
}

/**
 * Applies a consolidation plan produced by MemoryConsolidatePlan. Deletes the
 * original memos in duplicate groups and appends merged replacements, deletes
 * resolved and stale memos, and returns the count of deleted/created entries.
 */
export class MemoryConsolidateApplyTool implements BuiltinTool<MemoryConsolidateApplyInput> {
  readonly name = 'MemoryConsolidateApply' as const;
  readonly description =
    'Apply a memory consolidation plan produced by MemoryConsolidatePlan. ' +
    'This deletes the original memos in duplicate groups and appends merged ' +
    'replacements, deletes resolved and stale memos, and returns the count of ' +
    'deleted and created entries. Only call this after the user has explicitly ' +
    'confirmed the plan shown from MemoryConsolidatePlan.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ConsolidationPlanSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MemoryConsolidateApplyInput): ToolExecution {
    return {
      description: 'Applying memory consolidation plan',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        const plan: ConsolidationPlan = args;
        const result = await applyConsolidation(store, plan);
        await this.agent.dreamTracker.recordDream();
        return {
          isError: false,
          output: `Consolidation complete. Deleted ${result.deleted} memo(s) and created ${result.created} merged memo(s).`,
        };
      },
    };
  }
}
