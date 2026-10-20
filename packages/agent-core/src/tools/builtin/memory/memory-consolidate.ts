import {
  applyDreamPlan,
  buildDreamPlan,
  type DreamApplyResult,
} from '@scream-code/memory';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const DreamKindSchema = z.enum(['fact', 'preference', 'procedure', 'pitfall']);

const DreamApplySchema = z.object({
  clusters: z.array(
    z.object({
      memoIds: z.array(z.string()),
      digest: z.object({
        topic: z.string(),
        kind: DreamKindSchema,
        statement: z.string(),
        confidence: z.enum(['high', 'medium', 'low']),
        evidenceIds: z.array(z.string()),
      }),
    }),
  ),
  /** Restore a previous induction inside its grace window and delete that card. */
  undoDigestId: z.string().optional(),
});

export type MemoryConsolidateApplyInput = z.infer<typeof DreamApplySchema>;

/**
 * Produces a read-only dream plan for the global memory store: topic clusters
 * of active memos, the digests that already exist, and pending maintenance.
 * The model should present the plan to the user before applying it.
 */
export class MemoryConsolidatePlanTool implements BuiltinTool<Record<string, never>> {
  readonly name = 'MemoryConsolidatePlan' as const;
  readonly description =
    'Build a dream plan for the global memory memos. Returns topic clusters of ' +
    'active memos (id, topic hint, memo ids, a short sample, kind guess), the ' +
    'digests that already exist, pending maintenance counts, and a summary with ' +
    'the estimated number of LLM calls. Planning never writes or deletes ' +
    'anything. Only call this when the user has invoked /dream. Present the plan ' +
    'to the user and ask for confirmation before calling MemoryConsolidateApply.';
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

        const plan = await buildDreamPlan(store);
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
 * Applies model-written digests: memos are folded into digest cards and marked
 * `digested`, staying restorable until the grace window expires. Undigested
 * memos are never deleted by this tool.
 */
export class MemoryConsolidateApplyTool implements BuiltinTool<MemoryConsolidateApplyInput> {
  readonly name = 'MemoryConsolidateApply' as const;
  readonly description =
    'Apply digests written from a MemoryConsolidatePlan. Each cluster carries ' +
    'its memoIds plus a digest (topic, kind, statement, confidence, evidenceIds) ' +
    'that you write yourself; evidenceIds must be a subset of that cluster’s ' +
    'memoIds, and the same topic in another project is a different digest. ' +
    'Successful memos are folded into the digest and marked digested, then ' +
    'physically deleted after a 14-day grace window. Applying also runs ' +
    'maintenance: memos folded more than 14 days ago are deleted, unfolded ' +
    'episodic memos untouched for 90 days expire, the active set is capped at ' +
    '2000, and digests beyond 200 are evicted; manually written memos are never ' +
    'deleted. Pass undoDigestId to restore a previous induction inside the grace ' +
    'window and remove its card. Only call this after the user has explicitly ' +
    'confirmed the plan shown from MemoryConsolidatePlan.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DreamApplySchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MemoryConsolidateApplyInput): ToolExecution {
    return {
      description: 'Applying dream plan',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        let result: DreamApplyResult;
        try {
          result = await applyDreamPlan(store, args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, output: `Dream plan rejected: ${message}` };
        }

        await this.agent.dreamTracker.recordDream();
        return {
          isError: false,
          output: formatResult(result),
        };
      },
    };
  }
}

function formatResult(result: DreamApplyResult): string {
  return (
    `Dream applied: created ${result.created}, updated ${result.updated}, ` +
    `archived ${result.archived}, restored ${result.restored}, evicted ${result.evicted} ` +
    `(deletedExpired ${result.deletedExpired}, deletedStale ${result.deletedStale}, ` +
    `dormant ${result.dormant}); totalMemos ${result.totalMemos}, ` +
    `totalDigests ${result.totalDigests}.`
  );
}
