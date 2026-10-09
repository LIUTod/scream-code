/**
 * Subagent message bus — the parent→child directed-message channel.
 *
 * Directed-message semantics: the only legitimate sender is the parent agent,
 * and a high-priority "steer" operation is dequeued before plain "queue"
 * messages. A steer aimed at a child whose turn is running is injected into
 * that turn by the host (it joins at the child's next step boundary);
 * everything else waits in the mailbox for the child's next turn start.
 *
 * This is an in-memory, per-session structure: nothing here is persisted to
 * the session store, emitted over RPC, or survives a process restart. Child
 * agents poll their mailbox at the start of each turn; the bus itself has no
 * knowledge of agents, turns, or lifecycles — the host layer owns those checks.
 *
 * Delivery contract (in-session, time-boxed): an accepted message is delivered
 * if its target polls the mailbox before its deadline, and expires afterwards.
 * "Delivered" means it reached the target's next turn inside this session — the
 * bus is memory-only, so nothing survives a process restart, and a message that
 * is never polled is dropped at its deadline rather than persisted for later.
 * The host reports those boundaries at the tool surface instead of promising
 * more than this file can keep: a finished target is refused (`not_active`), a
 * vanished parent is refused (`parent_gone`), and the accepted-queued receipt
 * states the expiry window. Nothing else may discard an accepted message before
 * then — in particular a finished child's terminal must not purge the mailbox:
 * the parent has already been told `accepted`, and re-hydrating the child
 * (ensureAgent) rebuilds the agent, not this in-memory bus, so a terminal purge
 * would destroy a message that neither the parent nor a resume could recover.
 * Expired mail is reclaimed lazily on the next bus access (`reclaimExpired`),
 * which keeps the mailbox map bounded without such a purge.
 */

/** How a message is delivered to the target subagent. */
export type SubagentMessageOperation = 'queue' | 'steer';

/** Delivery outcomes, collapsed from the reference's nine states to the six
 *  that are reachable in a per-session in-memory bus. `not_owned` and
 *  `parent_gone` are safety-critical and are produced by the host's
 *  ownership/liveness checks, not the bus. There is deliberately no
 *  `deadline_elapsed` status: both tool paths stamp the deadline when they
 *  build the message (`Date.now() + SUBAGENT_MESSAGE_DEADLINE_MS`), so a send
 *  can never observe an already-elapsed deadline; expiry is enforced where it
 *  matters, by `poll`/`reclaimExpired`, and a message that expires undelivered
 *  is reported as such by the accepted-queued receipt's time box. */
export type SubagentMessageStatus =
  | 'accepted'
  | 'not_found'
  | 'not_owned'
  | 'not_active'
  | 'parent_gone'
  | 'saturated';

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
   * delivery turn on a message that can never arrive. Counting is also an
   * ordinary bus access, so it reclaims mail that has expired by now.
   */
  activeCount(agentId: string): number {
    this.reclaimExpired(Date.now());
    // Reclaiming above removed every expired message, so what remains is
    // exactly the deliverable set.
    return this.mailboxes.get(agentId)?.queue.length ?? 0;
  }

  /**
   * Queue a message for a subagent. Pure mailbox logic: ownership, liveness
   * and activity checks belong to the host. Returns the delivery status and,
   * on acceptance, the stable message id plus the queue depth seen by the
   * recipient at poll time.
   *
   * The id is the reconciliation handle for a delivery: it is unique within
   * this bus, never reissued (see `clear`), carried by the delivered message
   * and returned here so the host can tie a retried send to the message it
   * duplicates and can watch the message's consumption (`holdsMessage`).
   */
  send(msg: SubagentMessageInput): {
    status: SubagentMessageStatus;
    reason?: 'bytes' | 'queue';
    queueDepth?: number;
    messageId?: string;
  } {
    const now = Date.now();
    // Reclaim before deciding: an expired message is not deliverable, so it
    // must not hold an in-flight slot and turn an honest send into `saturated`.
    this.reclaimExpired(now);
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
    return { status: 'accepted', queueDepth: mailbox.queue.length, messageId: message.id };
  }

  /**
   * Drop every queued message in every mailbox (session teardown). Id and seq
   * counters stay monotonic so identifiers issued before the clear are never
   * reissued.
   */
  clear(): void {
    this.mailboxes.clear();
  }

  /** How many mailboxes currently hold undelivered mail (diagnostics). */
  get mailboxCount(): number {
    return this.mailboxes.size;
  }

  /**
   * Whether the message with this id is still queued and deliverable — the
   * consumption check behind the host's parent→child dedupe: while this
   * returns true a retried send is a duplicate, and once it returns false the
   * message has been delivered (or expired) and the retry must go through.
   * Ordinary bus access: expired mail is reclaimed first, so an expired
   * message reads as no longer in flight, which is exactly right — it will
   * never reach the child.
   */
  holdsMessage(id: string): boolean {
    this.reclaimExpired(Date.now());
    for (const mailbox of this.mailboxes.values()) {
      if (mailbox.queue.some((message) => message.id === id)) return true;
    }
    return false;
  }

  /**
   * Drop mail that can no longer be delivered and free the mailbox slot it
   * pinned. A message is deliverable only until its deadline; past it, `poll`
   * would discard it rather than hand it to the child, so keeping it would pin
   * memory for a run that has already ended. Called on every ordinary bus
   * access — send, activeCount, poll — which is what keeps the mailbox map
   * bounded now that a finished child's terminal no longer purges its mailbox.
   */
  private reclaimExpired(now: number): void {
    for (const [agentId, mailbox] of this.mailboxes) {
      const live = mailbox.queue.filter((m) => m.deadline > now);
      if (live.length === 0) {
        this.mailboxes.delete(agentId);
      } else if (live.length !== mailbox.queue.length) {
        mailbox.queue = live;
      }
    }
  }

  /**
   * Deliver all pending, unexpired messages for `agentId`. Steer messages are
   * always dequeued before queue messages; within an operation class, arrival
   * order is preserved via the monotonically increasing `seq` (this is a stable
   * two-pass collection, not a sort). Messages past their deadline are
   * reclaimed, never delivered.
   *
   * The mailbox entry is removed once its queue is emptied: a polled-out (or
   * fully expired) mailbox must not pin a Map slot.
   */
  poll(agentId: string): SubagentMessage[] {
    const now = Date.now();
    this.reclaimExpired(now);
    const mailbox = this.mailboxes.get(agentId);
    if (mailbox === undefined) return [];
    // Delivery consumes the queue, so the entry leaves with the messages it
    // held.
    this.mailboxes.delete(agentId);
    const steers = mailbox.queue.filter((m) => m.operation === 'steer');
    const queues = mailbox.queue.filter((m) => m.operation === 'queue');
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
