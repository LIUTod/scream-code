/**
 * SendSubagentMessageTool — parent→child directed-message tool.
 *
 * The parent agent uses this to steer, interject into, or queue a message to
 * one of its own subagents. A steer aimed at a child whose turn is running is
 * injected into that turn and joins at the child's next step boundary; an
 * interject does the same but also interrupts the tool batch in flight; every
 * other message waits in the session-level SubagentMessageBus (FIFO within an
 * operation class; steer precedes queue) and is injected into the child's
 * prompt at its next turn start. A child can never send to itself, and a
 * message addressed to a child owned by a different parent is refused as
 * not_owned.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import {
  DEFAULT_BYTE_LIMIT,
  SUBAGENT_MESSAGE_DEADLINE_MS,
} from '../../../session/subagent-messages';
import DESCRIPTION from './send-subagent-message.md';

const BYTE_LIMIT_KIB = DEFAULT_BYTE_LIMIT / 1024;
const DEADLINE_MINUTES = Math.round(SUBAGENT_MESSAGE_DEADLINE_MS / 60_000);

export const SendSubagentMessageInputSchema = z.object({
  agent_id: z.string().min(1).describe('Agent id of the target subagent, as returned by Agent.'),
  operation: z
    .enum(['queue', 'steer', 'interject'])
    .describe(
      "queue: delivered when the subagent starts its next turn, after any steer messages. steer: delivered into the subagent's running turn at its next step boundary, or first in the mailbox if no turn is running. interject: like steer, but also interrupts the tool call the subagent has in flight right now — use it to correct a subagent stuck in a long wait; it falls back to the mailbox when no turn is running.",
    ),
  message: z
    .string()
    .min(1)
    // The real boundary is UTF-8 BYTES, not characters: a `.max(16_384)`
    // character cap advertised ~16k Chinese characters while the same text
    // blows the byte limit past ~5.4k (3 bytes per character). The refinement
    // states the limit in the unit the bus and the host actually enforce. A
    // custom check has no JSON Schema rendering (maxLength counts characters),
    // so the description below is how the model learns the same boundary.
    .refine((value) => new TextEncoder().encode(value).length <= DEFAULT_BYTE_LIMIT, {
      message: `Message must be at most ${BYTE_LIMIT_KIB} KiB of UTF-8 text.`,
    })
    .describe(
      `Message to deliver to the subagent. At most ${BYTE_LIMIT_KIB} KiB of UTF-8 text (about 5,400 Chinese characters); a longer message is rejected.`,
    ),
});

export type SendSubagentMessageInput = z.infer<typeof SendSubagentMessageInputSchema>;

const STATUS_TO_TEXT: Record<string, string> = {
  not_found: 'No such subagent.',
  not_owned: 'That subagent is not owned by the current agent; only the owning parent may message it.',
  not_active:
    'The subagent already finished; messages cannot reach it in this session. Use Agent(resume=<agent id>, prompt=<your decision>) to continue it with your reply.',
  parent_gone:
    'Message refused: the parent agent that owns this session state is no longer running, so the message was not queued. Resume that agent and send the message again from there.',
  saturated:
    'Message rejected: the target mailbox is already holding its maximum number of undelivered messages.',
};

const ACCEPTED_TEXT = {
  'mid-run':
    "Message accepted and delivered into the subagent's running turn; it joins at the subagent's next step boundary. Delivery is in-session only — nothing is persisted across a process restart.",
  interjected:
    "Message accepted and interjected: the subagent's in-flight tool batch was interrupted so the message takes effect immediately. Delivery is in-session only — nothing is persisted across a process restart.",
  queued:
    `Message accepted and queued; it is delivered when the subagent starts its next turn. Delivery is in-session and time-boxed: an undelivered message expires ${DEADLINE_MINUTES} minutes after acceptance (nothing survives a process restart; a resume in this session before the deadline can still pick it up).`,
} as const;

/** Why an accepted `interject` fell back to the mailbox instead of firing. */
const DOWNGRADE_TEXT = {
  structured:
    'Interject downgraded to a queued message: the subagent returns a structured (JSON) answer, so its tool batch is never interrupted.',
  idle: 'Interject downgraded to a queued message: no turn is running, so there is no tool batch to interrupt.',
  'steer-buffer-full':
    "Interject downgraded to a queued message: the subagent's steer buffer is full.",
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
                result.downgrade !== undefined ? ` ${DOWNGRADE_TEXT[result.downgrade]}` : ''
              }${
                result.duplicate === true
                  ? ` Duplicate of a message already in flight${
                      result.messageId === undefined ? '' : ` (id: ${result.messageId})`
                    } — the subagent will see it once.`
                  : ''
              }`
            : result.reason === 'bytes'
              ? `Message rejected: it exceeds the ${BYTE_LIMIT_KIB} KiB UTF-8 byte limit for a single message.`
              : STATUS_TO_TEXT[result.status] ?? result.status;
        return {
          isError: result.status !== 'accepted',
          output: reasonText,
        };
      },
    };
  }
}
