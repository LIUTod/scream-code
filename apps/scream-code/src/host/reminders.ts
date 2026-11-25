/**
 * Session reminders: one short message when a session the person is not
 * watching is done, waits for them, or failed — and when the background
 * itself is in trouble. They go to the chat channel (`/line`); the terminal
 * and the desktop keep their own notifications.
 *
 * What a reminder says, and never more: which session (its title), where (the
 * project), how long it ran, and what to do next. Never the conversation: a
 * chat platform's servers are not the person's machine, so an answer stays in
 * the session (a job's result, which the person asked to be sent, is the one
 * exception, and the job runner adds it).
 *
 * Nothing about starts or progress: a reminder is for something the person
 * should know or do now.
 *
 * Who gets one is the chat's setting (`reminders` in the line config):
 * `off`, `background` (sessions the background runs: work handed over or cut
 * off, job runs, approvals they wait on) or `away` — the default — which also
 * covers a terminal's sessions while the person is away from the terminal
 * (see `tui/utils/terminal-reminders.ts`). Only the background sends: the
 * chat connection lives in its process, so a terminal asks it to (`remind`).
 */

import { basename } from 'node:path';

import { t } from '@scream-code/config';

import { loadLineConfig } from '#/line/config';
import type { ProactiveDelivery } from '#/line/proactive';

export type ReminderMode = 'off' | 'background' | 'away';
export const DEFAULT_REMINDER_MODE: ReminderMode = 'away';

export type ReminderState = 'done' | 'waiting' | 'failed' | 'health';

export interface Reminder {
  readonly state: ReminderState;
  /** The session's (or job's) title, as stored; cleaned up when shown. */
  readonly title?: string | undefined;
  /** The session's project folder, shown by its name. */
  readonly workDir?: string | undefined;
  readonly elapsedMs?: number | undefined;
  /**
   * `waiting`: what it waits for (an action to approve; empty for a question).
   * `failed`: why it stopped. `health`: what is wrong.
   */
  readonly what?: string | undefined;
  /** `waiting`: an approval (default) or a question. */
  readonly waitingFor?: 'approval' | 'question' | undefined;
  /** Where the answer is given: in this chat (the lines that answer it) or back at the terminal. */
  readonly answer?: { readonly kind: 'chat'; readonly lines: readonly string[] } | { readonly kind: 'terminal' } | undefined;
  /** Work a crash, a shutdown or a power loss cut off, which the background finished. */
  readonly recovered?: boolean | undefined;
}

const TITLE_CHARS = 40;
const WHAT_CHARS = 200;

function oneLine(text: string, max: number): string {
  // Escape sequences (colour codes in a title), other control characters and
  // line breaks would show as junk or break the message apart in a chat.
  const line = text
    // eslint-disable-next-line no-control-regex
    .replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001F\u007F]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
}

/**
 * How a session is named in a reminder. A missing title, or one that is raw
 * markup (a prompt that was injected, not written), reads as an untitled
 * session of its project.
 */
export function reminderTitle(title: string | undefined, workDir: string | undefined): string {
  const cleaned = oneLine(title ?? '', TITLE_CHARS);
  if (cleaned !== '' && !cleaned.startsWith('<')) return cleaned;
  const project = workDir === undefined || workDir === '' ? '' : basename(workDir);
  return project === '' ? t('reminder.untitled') : t('reminder.untitled_in', { project });
}

export function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t('reminder.elapsed_short');
  if (minutes < 60) return t('reminder.elapsed_min', { m: String(minutes) });
  return t('reminder.elapsed_hour', { h: String(Math.floor(minutes / 60)), m: String(minutes % 60) });
}

/** The reminder as chat text: a header line, then what to do. */
export function formatReminder(reminder: Reminder): string {
  if (reminder.state === 'health') return t('reminder.health', { what: oneLine(reminder.what ?? '', WHAT_CHARS) });
  const title = reminderTitle(reminder.title, reminder.workDir);
  const what = oneLine(reminder.what ?? '', WHAT_CHARS);
  let header: string;
  if (reminder.state === 'done') {
    header = t(reminder.recovered === true ? 'reminder.done_recovered' : 'reminder.done', { title });
  } else if (reminder.state === 'failed') {
    header = what === '' ? t('reminder.failed_plain', { title }) : t('reminder.failed', { title, reason: what });
  } else if (reminder.waitingFor === 'question') {
    header = t('reminder.waiting_question', { title });
  } else {
    header = what === '' ? t('reminder.waiting_plain', { title }) : t('reminder.waiting_approval', { title, what });
  }
  const meta: string[] = [];
  if (reminder.workDir !== undefined && reminder.workDir !== '' && reminder.state !== 'waiting') {
    meta.push(basename(reminder.workDir));
  }
  if (reminder.elapsedMs !== undefined && reminder.state === 'done') meta.push(t('reminder.elapsed', { elapsed: formatElapsed(reminder.elapsedMs) }));
  if (reminder.answer?.kind === 'terminal') meta.push(t('reminder.back_to_terminal'));
  const lines = [[header, ...meta].join(' · ')];
  if (reminder.answer?.kind === 'chat') lines.push(...reminder.answer.lines);
  return lines.join('\n');
}

/** Which reminders a chat setting lets through. */
export function reminderAllowed(mode: ReminderMode, source: 'background' | 'terminal'): boolean {
  if (mode === 'off') return false;
  return source === 'background' || mode === 'away';
}

export interface ReminderOutboxOptions {
  readonly send: (chat: string, text: string) => Promise<ProactiveDelivery>;
  /** A message that did not reach its chat (no address yet, or the platform refused it). */
  readonly onUndelivered?: ((chat: string, delivery: Exclude<ProactiveDelivery, 'sent'>) => void) | undefined;
  /** Messages for one chat within this window go out as one. */
  readonly gatherMs?: number | undefined;
}

const SEEN_KEPT = 500;

/**
 * Sends chat messages for the background: one message per chat for whatever
 * arrives within a few seconds (three sessions finishing together are one
 * message, not three pings), and each reminder once (`key`), however many
 * processes or sweeps report it.
 */
export class ReminderOutbox {
  private readonly pending = new Map<string, { texts: string[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly seen = new Set<string>();
  private readonly gatherMs: number;

  constructor(private readonly options: ReminderOutboxOptions) {
    this.gatherMs = options.gatherMs ?? 10_000;
  }

  /** Queue `text` for `chat`; false when `key` was already sent. */
  push(chat: string, text: string, key?: string): boolean {
    if (key !== undefined) {
      if (this.seen.has(key)) return false;
      this.seen.add(key);
      if (this.seen.size > SEEN_KEPT) this.seen.delete(this.seen.values().next().value!);
    }
    const queued = this.pending.get(chat);
    if (queued !== undefined) {
      queued.texts.push(text);
      return true;
    }
    const timer = setTimeout(() => {
      void this.flush(chat);
    }, this.gatherMs);
    timer.unref?.();
    this.pending.set(chat, { texts: [text], timer });
    return true;
  }

  /** Send everything queued now (shutdown). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((chat) => this.flush(chat)));
  }

  private async flush(chat: string): Promise<void> {
    const queued = this.pending.get(chat);
    if (queued === undefined) return;
    this.pending.delete(chat);
    clearTimeout(queued.timer);
    const delivery = await this.options.send(chat, queued.texts.join('\n\n')).catch(() => 'failed' as const);
    if (delivery !== 'sent') this.options.onUndelivered?.(chat, delivery);
  }
}

const SETTINGS_TTL_MS = 30_000;

/**
 * The chat's reminder setting, read from the line config (it changes in
 * `/line` while the background runs, so it is read again every half minute
 * rather than once at start).
 */
export class ReminderSettings {
  private cached: { readonly mode: ReminderMode; readonly at: number } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** The last mode read (the default before the first), refreshing it in the background when stale. */
  latest(): ReminderMode {
    if (this.cached === undefined || this.now() - this.cached.at >= SETTINGS_TTL_MS) void this.mode();
    return this.cached?.mode ?? DEFAULT_REMINDER_MODE;
  }

  async mode(): Promise<ReminderMode> {
    const now = this.now();
    if (this.cached !== undefined && now - this.cached.at < SETTINGS_TTL_MS) return this.cached.mode;
    const config = await loadLineConfig().catch(() => undefined);
    const mode = config?.reminders ?? DEFAULT_REMINDER_MODE;
    this.cached = { mode, at: now };
    return mode;
  }
}

/** What a terminal sends in a `remind` request; undefined when it is not one. */
export function parseTerminalReminder(value: unknown): Reminder | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const state = raw['state'];
  if (state !== 'done' && state !== 'waiting' && state !== 'failed') return undefined;
  const text = (key: string, max: number): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' ? value.slice(0, max) : undefined;
  };
  const elapsed = raw['elapsedMs'];
  return {
    state,
    title: text('title', 400),
    workDir: text('workDir', 4096),
    what: text('what', 1000),
    ...(typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? { elapsedMs: elapsed } : {}),
    ...(raw['waitingFor'] === 'question' ? { waitingFor: 'question' as const } : {}),
    // A terminal's session is answered where it runs.
    ...(state === 'waiting' ? { answer: { kind: 'terminal' as const } } : {}),
  };
}
