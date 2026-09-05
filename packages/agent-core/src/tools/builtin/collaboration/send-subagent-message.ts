/**
 * SendSubagentMessageTool — parent→child directed-message tool.
 *
 * The parent agent uses this to steer or queue a message to one of its own
 * subagents. Delivery is enforced by the session-level SubagentMessageBus
 * (FIFO within an operation class; steer precedes queue) and the message is
 * injected into the child's prompt at its next turn start. A child can never
 * send to itself, and a message addressed to a child owned by a different
 * parent is refused as not_owned.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import DESCRIPTION from './send-subagent-message.md';

export const SendSubagentMessageInputSchema = z.object({
  agent_id: z.string().min(1).describe('Agent id of the target subagent, as returned by Agent.'),
  operation: z
    .enum(['queue', 'steer'])
    .describe('queue: delivered at the next turn boundary, after any steer messages. steer: delivered first (highest priority).'),
  message: z.string().min(1).max(16_384).describe('Message to deliver to the subagent.'),
});

export type SendSubagentMessageInput = z.infer<typeof SendSubagentMessageInputSchema>;

const STATUS_TO_TEXT: Record<string, string> = {
  accepted: 'Message accepted for delivery.',
  not_found: 'No such subagent.',
  not_owned: 'That subagent is not owned by the current agent; only the owning parent may message it.',
  not_active: 'The subagent is no longer active; messages are not accepted.',
  saturated: 'Message rejected: the target mailbox is at its in-flight limit.',
  deadline_elapsed: 'Message rejected: its delivery deadline elapsed before it could be sent.',
};

export class SendSubagentMessageTool implements BuiltinTool<SendSubagentMessageInput> {
  readonly name = 'SendSubagentMessage' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendSubagentMessageInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: SendSubagentMessageInput): ToolExecution {
    const description = `Messaging subagent ${args.agent_id} (${args.operation})`;
    return {
      description,
      approvalRule: this.name,
      execute: async () => {
        const result = this.subagentHost.sendMessage(
          args.agent_id,
          args.operation,
          args.message,
        );
        const reasonText =
          result.reason === 'bytes'
            ? 'Message rejected: it exceeds the byte limit for a single message.'
            : STATUS_TO_TEXT[result.status] ?? result.status;
        return {
          isError: result.status !== 'accepted',
          output: reasonText,
        };
      },
    };
  }
}
