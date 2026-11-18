/**
 * `scream report [--since 24h]`: what background work did, read straight from
 * what the host keeps — task runs, the "waiting for you" inbox, today's
 * tokens. No model is asked, so it costs nothing and says only what happened.
 * The daily brief (a task) is the written version of the same.
 */

import { t } from '@scream-code/config';
import { JobStore, listInbox, type InboxItem } from '@scream-code/scream-code-sdk';

import { formatTokenLimit } from '#/utils/usage/token-limit';

import { readHostSettings } from './settings';
import { hostTokensToday } from './usage';

function localTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function inboxText(item: InboxItem): string {
  if (item.kind === 'memory') return t('jobs.inbox_memory_line', { count: String(item.memories?.length ?? 0) });
  return firstLine(item.kind === 'question' ? (item.question?.items[0]?.question ?? '') : (item.approval?.action ?? ''));
}

export function buildReport(screamHomeDir: string, sinceMs: number, now: number = Date.now()): string[] {
  const since = now - sinceMs;
  const lines: string[] = [t('report.title', { since: localTime(since) })];

  const jobs = new JobStore(screamHomeDir).list();
  const ran = jobs
    .map((job) => ({ job, runs: job.runs.filter((run) => run.at >= since) }))
    .filter((entry) => entry.runs.length > 0);
  lines.push('', t('report.jobs'));
  if (ran.length === 0) lines.push(`  ${t('report.no_runs')}`);
  for (const { job, runs } of ran) {
    const ok = runs.filter((run) => run.ok).length;
    lines.push(`  ${job.title}  ${t('report.runs', { ok: String(ok), failed: String(runs.length - ok) })}`);
    const last = runs.at(-1)!;
    const summary = firstLine(last.summary);
    if (summary !== '') lines.push(`    ${last.ok ? '✓' : '✗'} ${localTime(last.at)}  ${summary}`);
  }
  const off = jobs.filter((job) => !job.enabled && job.disabledReason === 'fatigue');
  for (const job of off) lines.push(`  ${t('report.fatigued', { title: job.title })}`);
  for (const job of jobs) {
    if (job.lastSkipped !== undefined && job.lastSkipped.at >= since) {
      lines.push(`  ${t('report.skipped', { title: job.title, count: String(job.lastSkipped.count) })}`);
    }
  }

  const inbox = listInbox(screamHomeDir);
  const waiting = inbox.filter((item) => item.status === 'pending' && item.expiresAt > now);
  const expired = inbox.filter(
    (item) => (item.status === 'expired' || (item.status === 'pending' && item.expiresAt <= now)) && item.expiresAt >= since,
  );
  lines.push('', t('report.waiting', { count: String(waiting.length) }));
  for (const item of waiting) lines.push(`  ${item.id}  ${inboxText(item)}`);
  if (expired.length > 0) {
    lines.push(t('report.expired', { count: String(expired.length) }));
    for (const item of expired) lines.push(`  ${item.id}  ${inboxText(item)}`);
  }

  const limit = readHostSettings().dailyTokenLimit;
  lines.push(
    '',
    limit > 0
      ? t('service.tokens_limited', { used: formatTokenLimit(hostTokensToday(now)), limit: formatTokenLimit(limit) })
      : t('service.tokens_unlimited', { used: formatTokenLimit(hostTokensToday(now)) }),
  );
  return lines;
}
