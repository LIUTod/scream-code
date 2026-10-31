/**
 * Scheduled-task relay.
 *
 * A fired cron task runs *inside* the session, not through `submit()`, so its
 * turn carries no inbound context for the platform to reply to. This class
 * turns that turn into a delivery: announce the fire, collect the final text,
 * hand it to the caller's `send`.
 *
 * Two rules keep it from double-posting:
 *  - a fire that lands while a user turn is running is dropped — `steer()` has
 *    already merged it into that turn, whose reply reaches the chat anyway;
 *  - one forward at a time per session; a second fire during collection is
 *    skipped rather than interleaved.
 */

import { log } from '@scream-code/scream-code-sdk';
import type { Event } from '@scream-code/scream-code-sdk';

import type { ProactiveDelivery } from './proactive';
import { LineTurnCollector } from './turn-collector';

/** A fired turn that never reports its end must not block later fires. */
const DEFAULT_COLLECT_TIMEOUT_MS = 15 * 60_000;

export interface CronRelayOptions {
  /** Delivers one message to the chat that owns the session. */
  readonly send: (text: string) => Promise<ProactiveDelivery>;
  /** True while a turn the user started is running. */
  readonly isBusy: () => boolean;
  /** Overridable for tests; defaults to the turn budget. */
  readonly collectTimeoutMs?: number;
}

export class CronRelay {
  private collector: LineTurnCollector | undefined;
  private guard: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: CronRelayOptions) {}

  /**
   * A scheduled task fired; `notice` is the one-liner shown before the result.
   *
   * `pendingStart` is the `turn.started` event the core emits *before* the
   * `cron.fired` event (`steer()` launches the turn synchronously). Without
   * replaying it the collector would ignore every delta of that turn and never
   * settle, so no result would ever be delivered.
   */
  onFire(notice: string | null, pendingStart?: Event, failureNotice?: string): void {
    if (this.options.isBusy()) return;
    if (this.collector !== undefined) {
      log.warn('line: cron fire ignored, previous forward still collecting');
      return;
    }
    const collector = new LineTurnCollector(() => {
      this.clearGuard();
      this.collector = undefined;
      void this.deliver(collector, failureNotice);
    });
    this.collector = collector;
    this.guard = setTimeout(() => {
      if (this.collector !== collector) return;
      this.collector = undefined;
      log.warn('line: scheduled task turn produced no end event', {
        timeoutMs: this.options.collectTimeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS,
      });
    }, this.options.collectTimeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS);
    this.guard.unref?.();
    if (pendingStart !== undefined) collector.handleEvent(pendingStart);
    // `null` = the task is silent: skip the "fired" line, still deliver the result.
    if (notice !== null) {
      void this.options.send(notice).then((result) => {
        if (result !== 'sent') log.warn('line: cron notice not delivered', { result });
      });
    }
  }

  /** True while a fired task's turn is being collected. */
  isCollecting(): boolean {
    return this.collector !== undefined;
  }

  /** Drops any in-flight collection (session reset / shutdown). */
  dispose(): void {
    this.clearGuard();
    this.collector = undefined;
  }

  private clearGuard(): void {
    if (this.guard === undefined) return;
    clearTimeout(this.guard);
    this.guard = undefined;
  }

  /** Every other event of the session; ignored unless a fire is being collected. */
  onEvent(event: Event): void {
    if (this.collector === undefined) return;
    if (this.options.isBusy()) {
      // The user took the chat over mid-collection: their reply covers it.
      this.clearGuard();
      this.collector = undefined;
      return;
    }
    this.collector.handleEvent(event);
  }

  private async deliver(collector: LineTurnCollector, failureNotice?: string): Promise<void> {
    if (this.options.isBusy()) return;
    const text = collector.text.trim();
    if (text === '') {
      log.warn('line: scheduled task produced no reply text', { ended: collector.ended });
      // Silence is the one outcome a reminder must not have: tell the chat the
      // task ran and ended with nothing, instead of leaving it guessing.
      if (failureNotice !== undefined) {
        const result = await this.options.send(failureNotice);
        if (result !== 'sent') log.warn('line: cron failure notice not delivered', { result });
      }
      return;
    }
    const result = await this.options.send(text);
    if (result !== 'sent') log.warn('line: cron result not delivered', { result });
  }
}
