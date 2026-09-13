/**
 * SendSubagentMessageTool — parent→child directed-message tool.
 *
 * The parent agent uses this to steer or queue a message to one of its own
 * subagents. A steer aimed at a child whose turn is running is injected into
 * that turn and joins at the child's next step boundary; every other message
 * waits in the session-level SubagentMessageBus (FIFO within an operation
 * class; steer precedes queue) and is injected into the child's prompt at its
 * next turn start. A child can never send to itself, and a message addressed to
 * a child owned by a different parent is refused as not_owned.
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
    .describe('queue: delivered when the subagent starts its next turn, after any steer messages. steer: delivered into the subagent\'s running turn at its next step boundary, or first in the mailbox if no turn is running.'),
  message: z.string().min(1).max(16_384).describe('Message to deliver to the subagent.'),
});

export type SendSubagentMessageInput = z.infer<typeof SendSubagentMessageInputSchema>;

const STATUS_TO_TEXT: Record<string, string> = {
  not_found: 'No such subagent.',
  not_owned: 'That subagent is not owned by the current agent; only the owning parent may message it.',
  not_active:
    'The subagent already finished; messages cannot reach it. Use Agent(resume=<agent id>, prompt=<your decision>) to continue it with your reply.',
  saturated:
    'Message rejected: the target mailbox is already holding its maximum number of undelivered messages.',
  deadline_elapsed: 'Message rejected: its delivery deadline elapsed before it could be sent.',
};

const ACCEPTED_TEXT = {
  'mid-run':
    "Message accepted and delivered into the subagent's running turn; it joins at the subagent's next step boundary.",
  queued:
    'Message accepted and queued; it is delivered when the subagent starts its next turn.',
} as const;

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
          result.status === 'accepted'
            ? `${ACCEPTED_TEXT[result.delivery ?? 'queued']}${
                result.duplicate === true
                  ? ' Duplicate of a message already in flight — the subagent will see it once.'
                  : ''
              }`
            : result.reason === 'bytes'
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
