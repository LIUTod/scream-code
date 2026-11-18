import type { Agent } from '..';
import { describeLocalTimeZone, formatLocalIso } from '../../utils/local-time';
import { DynamicInjector } from './injector';

const LOCAL_DATE_VARIANT = 'local_date';

/** `2026-11-18`: the local calendar day of `ms`. */
function localDay(ms: number): string {
  return formatLocalIso(ms).slice(0, 10);
}

/**
 * Tells the model the date once the local day has changed.
 *
 * The system prompt carries the time the session was opened (`SCREAM_NOW`) and
 * never advances, which is right for a session that lasts an hour and wrong for
 * one that stays open for days: a chat channel's session, a long goal, or a
 * session that keeps scheduled tasks. Without this the model reads "today" off a
 * date that is days old and writes it into reports, file names and commits.
 *
 * It costs nothing on an ordinary session: nothing is injected while the day
 * is the one the session opened on. After the day changes, one reminder is
 * added, and again only on the next change, or when the previous copy left the
 * context (compaction, `/undo`, `/clear`). Reminders sit at the end of the
 * history, so the cached prefix is untouched.
 */
export class LocalDateInjector extends DynamicInjector {
  protected override readonly injectionVariant = LOCAL_DATE_VARIANT;
  private readonly openedOn: string;
  private toldOn: string | undefined;

  constructor(
    agent: Agent,
    private readonly now: () => number = Date.now,
  ) {
    super(agent);
    this.openedOn = localDay(this.now());
  }

  protected override getInjection(): string | undefined {
    const now = this.now();
    const today = localDay(now);
    if (today === this.openedOn) return undefined;
    if (this.injectedAt !== null && this.toldOn === today) return undefined;
    this.toldOn = today;
    return [
      `The local date has changed since this session was opened. It is now ${formatLocalIso(now)},`,
      `time zone ${describeLocalTimeZone(now)}. Use this date for "today", "yesterday" and any date you write;`,
      'the session-start time in the system prompt is out of date.',
    ].join(' ');
  }
}
