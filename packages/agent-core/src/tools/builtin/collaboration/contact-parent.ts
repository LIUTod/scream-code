import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import type { SubagentMessageStatus } from '../../../session/subagent-messages';
import type { Agent } from '../../../agent';
import DESCRIPTION from './contact-parent.md';

/** Rejections the child can act on. A request that was not accepted was not
 *  delivered — none of these may read like a delayed delivery. */
const REJECT_TEXT: Partial<Record<SubagentMessageStatus, string>> = {
  not_active:
    'Request rejected: this agent is no longer an active child of its parent in this session, so the request was not delivered. Do not wait for a reply.',
  parent_gone:
    'Request rejected: the parent agent is no longer running in this session, so it cannot receive this request and no reply will come. Do not wait — finish the remaining work and return your result; a resumed parent can pick this agent up again with Agent(resume=<agent id>).',
  saturated:
    'Request rejected: this turn already used its budget of 4 collaboration requests. Resolve what you can yourself, and report the open question in your result instead.',
};

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
      expecting: z
        .string()
        .max(500)
        .optional()
        .describe('What a good reply looks like — the shape, format, or acceptance criteria you want back.'),
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
              : (REJECT_TEXT[result.status] ?? `Request rejected: ${result.status}.`),
        };
      },
    };
  }
}
