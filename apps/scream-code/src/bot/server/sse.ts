/** Process-local, globally ordered SSE replay. Durable state remains in the database. */
import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '../shared/contracts';

const DEFAULT_BUFFER_SIZE = 500;
const DEFAULT_PENDING_LIMIT = 500;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 30_000;
const PROCESS_EPOCH = randomUUID();

export interface PublishInput {
  readonly botId: string;
  readonly threadId?: string | undefined;
  readonly roomId?: string | undefined;
  readonly type: ServerEvent['type'];
  readonly data: unknown;
}

export interface EventWatermark {
  readonly epoch: string;
  readonly seq: number;
}

export type EventSink = (event: ServerEvent) => void;

interface Subscriber {
  readonly botId: string | undefined;
  readonly sink: EventSink;
  readonly afterSeq: number;
  readonly pending: ServerEvent[];
  buffering: boolean;
  closed: boolean;
  readonly finish: (error?: Error) => void;
}

export interface SseSubscription {
  readonly watermark: EventWatermark;
  readonly ready: Promise<void>;
  readonly unsubscribe: () => void;
}

/** Only the current epoch/global-sequence protocol is accepted. */
export function parseLastEventId(raw: string | undefined | null): EventWatermark | undefined {
  if (raw === undefined || raw === null) return undefined;
  const match = /^([^\s:]+):(0|[1-9]\d*)$/.exec(raw.trim());
  if (match === null) return undefined;
  const epoch = match[1];
  const seq = Number(match[2]);
  if (epoch === undefined || !Number.isSafeInteger(seq)) return undefined;
  return { epoch, seq };
}

export class SseHub {
  readonly epoch: string;
  private seq = 0;
  private readonly buffer: ServerEvent[] = [];
  private readonly fanout: ServerEvent[] = [];
  private publishing = false;
  private readonly subscribers = new Set<Subscriber>();
  private readonly bufferSize: number;
  private readonly pendingLimit: number;
  private readonly snapshotTimeoutMs: number;
  private closed = false;

  constructor(options: { readonly bufferSize?: number; readonly epoch?: string; readonly pendingLimit?: number; readonly snapshotTimeoutMs?: number } = {}) {
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.pendingLimit = options.pendingLimit ?? DEFAULT_PENDING_LIMIT;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.pendingLimit) || this.pendingLimit < 1) throw new Error('SSE pending limit must be a positive integer');
    if (!Number.isSafeInteger(this.snapshotTimeoutMs) || this.snapshotTimeoutMs < 1) throw new Error('SSE snapshot timeout must be a positive integer');
    this.epoch = options.epoch ?? PROCESS_EPOCH;
    if (!Number.isSafeInteger(this.bufferSize) || this.bufferSize < 1) {
      throw new Error('SSE buffer size must be a positive integer');
    }
    if (!/^[^\s:]+$/.test(this.epoch)) throw new Error('Invalid SSE epoch');
  }

  publish(input: PublishInput): ServerEvent {
    if (this.closed) throw new Error('SSE hub is closed');
    this.seq += 1;
    const event = {
      epoch: this.epoch,
      seq: this.seq,
      type: input.type,
      botId: input.botId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
      data: input.data,
    } satisfies ServerEvent & EventWatermark;
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.fanout.push(event);
    if (!this.publishing) {
      this.publishing = true;
      try {
        while (this.fanout.length > 0) {
          const next = this.fanout.shift();
          if (next === undefined) continue;
          // A sink can subscribe while being called; do not deliver that event twice.
          const recipients = Array.from(this.subscribers);
          for (const subscriber of recipients) {
            if (subscriber.closed || next.seq <= subscriber.afterSeq || (subscriber.botId !== undefined && subscriber.botId !== next.botId)) continue;
            if (subscriber.buffering) {
              if (subscriber.pending.length >= this.pendingLimit) this.failSnapshot(subscriber, 'pending_overflow');
              else subscriber.pending.push(next);
            } else this.deliver(subscriber, next);
          }
        }
      } finally {
        this.publishing = false;
      }
    }
    return event;
  }

  /**
   * Attach before capturing the watermark. Replay through it, write the snapshot,
   * then drain every event published during that write. No event is skipped just
   * because an asynchronous snapshot may already include its state.
   */
  subscribe(
    options: {
      readonly botId?: string | undefined;
      readonly lastEventId?: string | undefined;
      readonly snapshot?: (watermark: EventWatermark, signal: AbortSignal) => void | Promise<void>;
    },
    sink: EventSink,
  ): SseSubscription {
    if (this.closed) throw new Error('SSE hub is closed');
    const completion = Promise.withResolvers<void>();
    const snapshotAbort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const subscriber: Subscriber = {
      botId: options.botId, sink, afterSeq: this.seq, pending: [], buffering: true, closed: false,
      finish: (error) => {
        if (subscriber.closed) return;
        subscriber.closed = true;
        subscriber.pending.length = 0;
        clearTimeout(timeout);
        this.subscribers.delete(subscriber);
        snapshotAbort.abort();
        if (error === undefined) completion.resolve();
        else completion.reject(error);
      },
    };
    this.subscribers.add(subscriber);
    const watermark: EventWatermark = { epoch: this.epoch, seq: this.seq };
    const unsubscribe = () => { subscriber.finish(); };
    const cursor = parseLastEventId(options.lastEventId);
    const reason = options.lastEventId === undefined
      ? undefined
      : cursor === undefined ? 'invalid_cursor'
      : cursor.epoch !== this.epoch ? 'epoch_mismatch'
      : cursor.seq > watermark.seq ? 'future_cursor'
      : cursor.seq < (this.buffer[0]?.seq ?? this.seq + 1) - 1 ? 'buffer_gap'
      : undefined;
    // Copy the replay slice before invoking user code: a sink can publish again.
    const replay = reason === undefined && cursor !== undefined
      ? this.replay(cursor.seq, options.botId)
      : [];
    if (reason !== undefined) {
      this.deliver(subscriber, {
        ...watermark, type: 'resync', data: { reason, ...watermark },
      });
    }
    for (const event of replay) this.deliver(subscriber, event);

    const drain = () => {
      while (!subscriber.closed && subscriber.pending.length > 0) {
        const event = subscriber.pending.shift();
        if (event !== undefined) this.deliver(subscriber, event);
      }
      subscriber.buffering = false;
      clearTimeout(timeout);
      completion.resolve();
    };
    try {
      const snapshot = subscriber.closed ? undefined : options.snapshot?.(watermark, snapshotAbort.signal);
      if (snapshot === undefined) drain();
      else {
        if (!subscriber.closed) {
          timeout = setTimeout(() => { this.failSnapshot(subscriber, 'snapshot_timeout'); }, this.snapshotTimeoutMs);
          timeout.unref?.();
        }
        // Observe the operation even after cancellation, without holding its queue
        // or making ready wait for an uncancellable writer to eventually finish.
        void Promise.resolve(snapshot).then(drain, (error: unknown) => {
          subscriber.finish(error instanceof Error ? error : new Error(String(error)));
        });
      }
    } catch (error) {
      subscriber.finish(error instanceof Error ? error : new Error(String(error)));
    }
    return { watermark, ready: completion.promise, unsubscribe };
  }

  replay(afterSeq: number, botId?: string): readonly ServerEvent[] {
    return this.buffer.filter((event) => event.seq > afterSeq && (botId === undefined || event.botId === botId));
  }

  currentSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  close(): void {
    this.closed = true;
    this.buffer.length = 0;
    this.fanout.length = 0;
    for (const subscriber of this.subscribers) subscriber.finish();
    this.subscribers.clear();
  }

  /** A slow snapshot loses continuity: signal a gap, discard pending, close.
   * The gateway must close the wire when ready rejects, and honor the snapshot
   * AbortSignal. Clients reconnect with resync rather than consume a partial drain.
   */
  private failSnapshot(subscriber: Subscriber, reason: 'pending_overflow' | 'snapshot_timeout'): void {
    if (subscriber.closed) return;
    const watermark = { epoch: this.epoch, seq: this.seq };
    this.deliver(subscriber, { ...watermark, type: 'resync', data: { reason, ...watermark } });
    subscriber.finish(new Error(`SSE snapshot ${reason}`));
  }

  private deliver(subscriber: Subscriber, event: ServerEvent): void {
    if (subscriber.closed) return;
    try {
      subscriber.sink(event);
    } catch {
      subscriber.finish();
    }
  }
}

export function eventId(event: ServerEvent): string {
  return `${event.epoch}:${String(event.seq)}`;
}
