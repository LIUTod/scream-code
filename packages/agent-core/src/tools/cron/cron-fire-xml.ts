/**
 * Cron-fire XML rendering — produces the chat-history injection text
 * the scheduler hands to the model when a CronTask fires.
 *
 * Output shape:
 *   <cron-fire jobId="..." cron="..." recurring="true|false" coalescedCount="N" stale="true|false" firedAt="2026-11-18T09:03:00+08:00">
 *   <instruction>FIRING_INSTRUCTION</instruction>
 *   <prompt>
 *   verbatim user prompt
 *   </prompt>
 *   </cron-fire>
 *
 * Mirrors `agent/context/notification-xml.ts`: attribute values are
 * escape-safe via `stringAttr`, but the body inside `<prompt>` is
 * verbatim. The injection target is an LLM-visible transcript where
 * double-escaping would be noisier than literal punctuation.
 */
import type { CronJobOrigin } from '../../agent/context/types';
import { formatLocalIso } from '../../utils/local-time';

/**
 * The `<instruction>` line says what the prompt cannot say about itself. A
 * stored prompt is written in schedule-speak ("every morning, append …"), and
 * schedule-shaped text arriving with no frame reads as a request to SET UP a
 * schedule: a model can answer "that task is already configured" and do no
 * work, which records as a success. The cron tools' own description explains
 * the envelope, but the cron group is deferred, so a fired turn may not have
 * it loaded; the frame therefore rides in every envelope.
 */
export const FIRING_INSTRUCTION =
  'This is a scheduled task firing now. Do the work in the prompt below in this turn. ' +
  'Do not list, recreate or reschedule the task unless the prompt asks for that.';

export function renderCronFireXml(
  origin: CronJobOrigin,
  prompt: string,
  /**
   * When the fire is delivered. Rendered as local time with its offset so a
   * daily task ("summarize what changed since yesterday") knows today's date —
   * the system prompt only carries the time the session was opened.
   */
  firedAtMs?: number,
): string {
  const jobId = stringAttr(origin.jobId, 'unknown');
  const cron = stringAttr(origin.cron, 'unknown');
  const recurring = origin.recurring ? 'true' : 'false';
  const coalescedCount = String(origin.coalescedCount);
  const stale = origin.stale ? 'true' : 'false';
  const firedAt =
    firedAtMs !== undefined && Number.isFinite(firedAtMs)
      ? ` firedAt="${formatLocalIso(firedAtMs)}"`
      : '';

  return [
    `<cron-fire jobId="${jobId}" cron="${cron}" recurring="${recurring}" coalescedCount="${coalescedCount}" stale="${stale}"${firedAt}>`,
    `<instruction>${FIRING_INSTRUCTION}</instruction>`,
    '<prompt>',
    prompt,
    '</prompt>',
    '</cron-fire>',
  ].join('\n');
}

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  // Attribute boundary safety: escape `&` and `"`. Body-text `<` / `>`
  // stay untouched — the injection target is an LLM-visible transcript
  // where double-escaping would be noisier than literal punctuation.
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
