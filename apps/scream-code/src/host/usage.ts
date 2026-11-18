/**
 * What the background host's own work spent today, in tokens, and the daily
 * limit on it (`dailyTokenLimit` in `host/settings.json`; 0 or absent = none).
 *
 * Only work nobody is watching counts here: background-task runs and
 * continued work, all of which run in the host. Once today's total reaches
 * the limit, the host starts no new task run and continues nothing until the
 * local day changes; a conversation the person is in is never cut off by it.
 * Tokens, not money: a custom model has no price, so a money limit would
 * count it as free.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session, SessionUsage } from '@scream-code/scream-code-sdk';

import { getHostDir } from './control';
import { readHostSettings } from './settings';

interface UsageFile {
  readonly day: string;
  readonly tokens: number;
}

function usagePath(): string {
  return join(getHostDir(), 'usage.json');
}

export function localDay(ms: number = Date.now()): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Tokens the host's unattended work spent today. */
export function hostTokensToday(now: number = Date.now()): number {
  try {
    const file = JSON.parse(readFileSync(usagePath(), 'utf8')) as Partial<UsageFile>;
    return file.day === localDay(now) && typeof file.tokens === 'number' ? file.tokens : 0;
  } catch {
    return 0;
  }
}

/** Add a finished run's usage to today's total. */
export function addHostTokens(tokens: number, now: number = Date.now()): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return hostTokensToday(now);
  const next: UsageFile = { day: localDay(now), tokens: hostTokensToday(now) + Math.round(tokens) };
  mkdirSync(getHostDir(), { recursive: true });
  const temp = `${usagePath()}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next)}\n`, 'utf8');
  renameSync(temp, usagePath());
  return next.tokens;
}

/** Everything a session spent: input (cache included) plus output, over all models. */
export function usageTokens(usage: SessionUsage | undefined): number {
  const total = usage?.total;
  if (total === undefined) return 0;
  return total.inputOther + total.inputCacheRead + total.inputCacheCreation + total.output;
}

/** Whether today's limit is reached (false when there is no limit). */
export function hostBudgetReached(now: number = Date.now()): boolean {
  const limit = readHostSettings().dailyTokenLimit;
  return limit > 0 && hostTokensToday(now) >= limit;
}

/** A session's usage, or undefined when it cannot be read (closed, a stand-in). */
export async function readUsage(session: Session): Promise<SessionUsage | undefined> {
  try {
    return await session.getUsage();
  } catch {
    return undefined;
  }
}
