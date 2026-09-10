import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import type { Agent } from '../../../agent';
import DESCRIPTION from './contact-parent.md';

export const ContactParentInputSchema = z.object({
  request_type: z
    .enum(['info', 'handoff', 'escalate'])
    .describe(
      'info: ask the parent for context or clarification. handoff: ask the parent to route part of your work to a different capability (describe the need, never a named agent). escalate: bump a decision to the human.',
    ),
  message: z.string().min(1).max(8192).describe('What you need. Be specific.'),
  needs: z
    .string()
    .max(1024)
    .optional()
    .describe('handoff only: the capability needed, e.g. "independent verification of this logic".'),
  payload: z
    .object({
      artifacts: z.array(z.string()).max(20).optional().describe('Paths of finished work products.'),
      evidence: z.array(z.string()).max(20).optional().describe('Proof: test output, screenshots, diffs.'),
      missing: z.array(z.string()).max(20).optional().describe('What is unfinished or uncertain.'),
    })
    .optional(),
});

export class ContactParentTool {
  readonly name = 'ContactParent' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ContactParentInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly getAgent: () => Agent,
  ) {}

  resolveExecution(args: z.infer<typeof ContactParentInputSchema>): ToolExecution {
    return {
      description: `Contact parent (${args.request_type})`,
      approvalRule: this.name,
      execute: async () => {
        const result = this.subagentHost.submitChildRequest(this.getAgent(), args);
        return {
          isError: result.status !== 'accepted',
          output:
            result.status === 'accepted'
              ? result.deduped === true
                ? 'Request accepted (duplicate of an earlier request this turn; the parent already has it).'
                : 'Request accepted. The parent will see it at its next turn boundary; keep working while you wait.'
              : `Request rejected: ${result.status}.`,
        };
      },
    };
  }
}
