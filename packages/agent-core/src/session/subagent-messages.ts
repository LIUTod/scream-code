/**
 * Subagent message bus — the parent→child directed-message channel.
 *
 * Modeled on the directed-message semantics of the reference implementation
 * (send_subagent_message): the only legitimate sender is the parent agent,
 * messages are delivered at the child's next turn boundary, and a
 * high-priority "steer" operation is dequeued before plain "queue" messages.
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

const DEFAULT_IN_FLIGHT_LIMIT = 1;
const DEFAULT_BYTE_LIMIT = 16 * 1024;

/** UTF-8 byte length (TextEncoder is available in all supported runtimes). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export class SubagentMessageBus {
  private readonly mailboxes = new Map<string, Mailbox>();
  private nextId = 0;
  private nextSeq = 0;

  /** Number of undelivered messages currently addressed to `agentId`. */
  activeCount(agentId: string): number {
    return this.mailboxes.get(agentId)?.queue.length ?? 0;
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

  /** Drop every message addressed to `agentId` (used when a child completes). */
  clear(agentId: string): void {
    this.mailboxes.delete(agentId);
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
    deadline: overrides?.deadline ?? Date.now() + 60_000,
  };
}
