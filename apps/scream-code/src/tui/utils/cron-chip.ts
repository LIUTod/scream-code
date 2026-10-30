/**
 * Scheduled-task reminder → one-line status chip.
 *
 * A fired cron task already owns a transcript block (`CronMessageComponent`) and
 * a turn. The status bar adds the *live* signal: the reminder is time-sensitive,
 * so it must be visible above the editor for a few seconds even when the user is
 * looking at the input box, not the transcript.
 *
 * Copy follows the shared chip grammar `<symbol> <label>：<value>` — the symbol
 * lives in the copy, the colour comes from the caller (`accent` for a normal
 * fire, `warning` for a stale/overdue one).
 */

import { t } from '@scream-code/config';
import type { CronFiredEvent } from '@scream-code/scream-code-sdk';

import { previewText } from './child-request-notice';

/** Longest task prompt shown on the row. The full text stays in the transcript
 *  block, so the chip only needs enough words to recognise the task. */
const CRON_PREVIEW_CHARS = 40;

export type CronReminderTone = 'fired' | 'missed';

export interface CronReminderChip {
  readonly text: string;
  readonly tone: CronReminderTone;
}

function shorten(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length > max ? `${codePoints.slice(0, max - 1).join('')}…` : value;
}

/**
 * Build the chip for one `cron.fired` delivery.
 *
 * `previewText` runs first: the prompt is model/tool-authored text about to be
 * written into a terminal row, so control sequences are stripped and newlines
 * collapse before the length cap is applied.
 *
 * Precedence, most notable first:
 *   stale (7-day cutoff) → coalesced (missed theoretical fires) → one-shot →
 *   plain recurring fire.
 */
export function buildCronReminderChip(event: CronFiredEvent): CronReminderChip {
  const origin = event.origin;
  // An empty prompt would render as `⏰ 定时任务已触发：` with no value; the cron
  // expression is the only identity such a job has left, so fall back to it.
  const preview = shorten(previewText(event.prompt), CRON_PREVIEW_CHARS) || origin.cron;
  if (origin.stale) {
    return { text: t('status.cron_stale', { preview }), tone: 'missed' };
  }
  if (origin.coalescedCount > 1) {
    return {
      text: t('status.cron_fired_coalesced', { count: String(origin.coalescedCount), preview }),
      tone: 'fired',
    };
  }
  if (!origin.recurring) {
    return { text: t('status.cron_once', { preview }), tone: 'fired' };
  }
  return { text: t('status.cron_fired', { preview }), tone: 'fired' };
}
