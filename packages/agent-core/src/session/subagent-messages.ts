/**
 * Subagent message bus — the parent→child directed-message channel.
 *
 * Modeled on the directed-message semantics of the reference implementation
 * (send_subagent_message): the only legitimate sender is the parent agent, and
 * a high-priority "steer" operation is dequeued before plain "queue" messages.
 * A steer aimed at a child whose turn is running is injected into that turn by
 * the host (it joins at the child's next step boundary); everything else waits
 * in the mailbox for the child's next turn start.
 *
 * This is an in-memory, per-session structure: nothing here is persisted to
 * the session store, emitted over RPC, or survives a process restart. Child
 * agents poll their mailbox at the start of each turn; the bus itself has no
 * knowledge of agents, turns, or lifecycles — the host layer owns those checks.
 */

/** How a message is delivered to the target subagent. */
export type SubagentMessageOperation = 'queue' | 'steer';

/** Delivery outcomes, collapsed from the reference's nine states to the six
 *  that are reachable in a per-session in-memory bus. `not_owned` is safety-
 *  critical and is produced by the host's ownership check, not the bus. */
export type SubagentMessageStatus =
  | 'accepted'
  | 'not_found'
  | 'not_owned'
  | 'not_active'
  | 'saturated'
  | 'deadline_elapsed';

/** All caller-supplied fields of a message. `id`/`seq` are assigned by the
 *  bus on acceptance and are present only on the delivered SubagentMessage. */
export interface SubagentMessageInput {
  /** The parent agent that sent the message. */
  readonly fromAgentId: string;
  /** The subagent the message is addressed to. */
  readonly toAgentId: string;
  readonly operation: SubagentMessageOperation;
  readonly text: string;
  /** Maximum number of queued messages the target may hold at once. */
  readonly inFlightLimit: number;
  /** Maximum total UTF-8 byte length of a single message. */
  readonly byteLimit: number;
  /** Epoch-ms deadline; messages past it are no longer deliverable. */
  readonly deadline: number;
}

export interface SubagentMessage extends SubagentMessageInput {
  /** Unique message id. */
  readonly id: string;
  /** Monotonic arrival order, used for stable FIFO within an operation class. */
  readonly seq: number;
}

interface Mailbox {
  queue: SubagentMessage[];
}

/**
 * Undelivered messages a child may hold at once. More than one so a single
 * message the child has not reached a boundary for cannot jam the channel.
 */
export const DEFAULT_IN_FLIGHT_LIMIT = 4;
export const DEFAULT_BYTE_LIMIT = 16 * 1024;
/**
 * How long a queued message stays deliverable. A child turn routinely outlasts
 * a minute (long tool calls, several steps), so the window has to cover a real
 * turn rather than expire while the child is still working.
 */
export const SUBAGENT_MESSAGE_DEADLINE_MS = 300_000;

/** UTF-8 byte length (TextEncoder is available in all supported runtimes). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Byte length of a message body. Callers that deliver a message without going
 * through `send` (the mid-run steer path) use this to apply the same limit.
 */
export function subagentMessageBytes(text: string): number {
  return byteLength(text);
}

export class SubagentMessageBus {
  private readonly mailboxes = new Map<string, Mailbox>();
  private nextId = 0;
  private nextSeq = 0;

  /**
   * Number of messages still deliverable for `agentId`. Expired ones are not
   * counted: `poll` drops them, so counting them would make the host spend a
   * delivery turn on a message that can never arrive.
   */
  activeCount(agentId: string): number {
    const queue = this.mailboxes.get(agentId)?.queue;
    if (queue === undefined) return 0;
    const now = Date.now();
    return queue.reduce((count, m) => (m.deadline > now ? count + 1 : count), 0);
  }

  /**
   * Queue a message for a subagent. Pure mailbox logic: ownership, liveness
   * and activity checks belong to the host. Returns the delivery status and,
   * on acceptance, the queue depth seen by the recipient at poll time.
   */
  send(msg: SubagentMessageInput): { status: SubagentMessageStatus; reason?: 'bytes' | 'queue'; queueDepth?: number } {
    if (Date.now() > msg.deadline) return { status: 'deadline_elapsed' };
    if (byteLength(msg.text) > msg.byteLimit) return { status: 'saturated', reason: 'bytes' };

    let mailbox = this.mailboxes.get(msg.toAgentId);
    if (mailbox === undefined) {
      mailbox = { queue: [] };
      this.mailboxes.set(msg.toAgentId, mailbox);
    }
    if (mailbox.queue.length >= msg.inFlightLimit) return { status: 'saturated', reason: 'queue' };

    const message: SubagentMessage = {
      ...msg,
      id: `${msg.fromAgentId}:${msg.toAgentId}:${++this.nextId}`,
      seq: ++this.nextSeq,
    };
    mailbox.queue.push(message);
    return { status: 'accepted', queueDepth: mailbox.queue.length };
  }

  /**
   * Deliver all pending, unexpired messages for `agentId`. Steer messages are
   * always dequeued before queue messages; within an operation class, arrival
   * order is preserved via the monotonically increasing `seq` (this is a stable
   * two-pass collection, not a sort). Messages past their deadline are dropped.
   */
  poll(agentId: string): SubagentMessage[] {
    const mailbox = this.mailboxes.get(agentId);
    if (mailbox === undefined || mailbox.queue.length === 0) return [];
    const now = Date.now();
    const live = mailbox.queue.filter((m) => m.deadline > now);
    mailbox.queue = [];
    const steers = live.filter((m) => m.operation === 'steer');
    const queues = live.filter((m) => m.operation === 'queue');
    steers.sort((a, b) => a.seq - b.seq);
    queues.sort((a, b) => a.seq - b.seq);
    return [...steers, ...queues];
  }
}

/** Construct a message with the bus defaults applied. */
export function buildSubagentMessage(
  fromAgentId: string,
  toAgentId: string,
  operation: SubagentMessageOperation,
  text: string,
  overrides?: { inFlightLimit?: number; byteLimit?: number; deadline?: number },
): SubagentMessageInput {
  return {
    fromAgentId,
    toAgentId,
    operation,
    text,
    inFlightLimit: overrides?.inFlightLimit ?? DEFAULT_IN_FLIGHT_LIMIT,
    byteLimit: overrides?.byteLimit ?? DEFAULT_BYTE_LIMIT,
    deadline: overrides?.deadline ?? Date.now() + SUBAGENT_MESSAGE_DEADLINE_MS,
  };
}
