/**
 * Reminders about this terminal's session while the person is away from it:
 * the turn is done, it waits for an approval or an answer, or it failed. They
 * go to the chat channel through the background (the chat connection lives
 * there — `remindHost`), and only when the chat's setting is `away`, the
 * default (see host/reminders.ts).
 *
 * "Away" means the terminal has been out of focus for {@link AWAY_MS}: an
 * alt-tab to read docs should not reach the phone. A terminal that does not
 * report focus never counts as away, so it sends nothing — better a reminder
 * missing than one for a person sitting right there.
 *
 * An event that happens before the person has been away long enough is held
 * until they have, and dropped when, by then, they came back or it no longer
 * holds (the approval was answered, a new turn started).
 */

import { loadLineConfig } from '#/line/config';
import { remindHost } from '#/host/control';
import { DEFAULT_REMINDER_MODE } from '#/host/reminders';

export const AWAY_MS = 3 * 60 * 1000;
/**
 * A turn that ends is "done" only once nothing follows it: a goal starts its
 * next turn right away, and a queued message does too.
 */
const DONE_SETTLE_MS = 5_000;

export interface TerminalReminderEvent {
  readonly state: 'done' | 'waiting' | 'failed';
  /** Unique per event (session + turn or request): the background sends each once. */
  readonly key: string;
  readonly title?: string | undefined;
  readonly workDir?: string | undefined;
  readonly elapsedMs?: number | undefined;
  readonly what?: string | undefined;
  readonly waitingFor?: 'approval' | 'question' | undefined;
  /** Checked when the reminder is due: false drops it (answered, superseded). */
  readonly stillHolds?: (() => boolean) | undefined;
}

export interface TerminalRemindersDeps {
  /** When the terminal lost focus, or undefined while it has focus (or never reports it). */
  readonly unfocusedAt: () => number | undefined;
  readonly send?: ((event: TerminalReminderEvent) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export class TerminalReminders {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly send: (event: TerminalReminderEvent) => Promise<void>;

  constructor(private readonly deps: TerminalRemindersDeps) {
    this.now = deps.now ?? Date.now;
    this.send = deps.send ?? sendThroughBackground;
  }

  /** Something the person may want to hear about happened in this terminal's session. */
  note(event: TerminalReminderEvent): void {
    const at = this.now();
    const unfocusedAt = this.deps.unfocusedAt();
    if (unfocusedAt === undefined) return;
    const awayFor = at - unfocusedAt;
    const settle = event.state === 'done' ? DONE_SETTLE_MS : 0;
    const wait = Math.max(settle, AWAY_MS - awayFor);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      // Still away, and away since before the event — not back and gone
      // again, which means they saw it — and the event still holds.
      const since = this.deps.unfocusedAt();
      if (since === undefined || since > at) return;
      // (A timer may fire a hair early; a second of slack.)
      if (this.now() - since < AWAY_MS - 1_000) return;
      if (event.stillHolds !== undefined && !event.stillHolds()) return;
      void this.send(event).catch(() => {});
    }, wait);
    timer.unref?.();
    this.timers.add(timer);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

/** Ask the background to send it, when a chat is set up and wants a terminal's reminders. */
async function sendThroughBackground(event: TerminalReminderEvent): Promise<void> {
  const config = await loadLineConfig().catch(() => undefined);
  if (config?.feishu === undefined && config?.weixin === undefined) return;
  if ((config.reminders ?? DEFAULT_REMINDER_MODE) !== 'away') return;
  await remindHost(
    {
      state: event.state,
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.workDir === undefined ? {} : { workDir: event.workDir }),
      ...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
      ...(event.what === undefined ? {} : { what: event.what }),
      ...(event.waitingFor === undefined ? {} : { waitingFor: event.waitingFor }),
    },
    event.key,
  );
}
