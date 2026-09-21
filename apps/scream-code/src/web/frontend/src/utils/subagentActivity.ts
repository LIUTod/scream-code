import type { SubagentActivity, SubagentActivityState, TokenUsage } from '../types';

const MAX_RETAINED_SUBAGENTS = 24;
const MAX_SUMMARY_LENGTH = 4_000;

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usageField(payload: Record<string, unknown>): TokenUsage | undefined {
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const candidate = usage as Partial<TokenUsage>;
  if (
    typeof candidate.inputOther !== 'number' ||
    typeof candidate.output !== 'number' ||
    typeof candidate.inputCacheRead !== 'number' ||
    typeof candidate.inputCacheCreation !== 'number'
  ) return undefined;
  return {
    inputOther: candidate.inputOther,
    output: candidate.output,
    inputCacheRead: candidate.inputCacheRead,
    inputCacheCreation: candidate.inputCacheCreation,
  };
}

function summaryField(payload: Record<string, unknown>, key: 'resultSummary' | 'error'): string | undefined {
  const text = stringField(payload, key);
  return text === undefined ? undefined : text.slice(0, MAX_SUMMARY_LENGTH);
}

function statusFrom(payload: Record<string, unknown>, fallback: SubagentActivityState): SubagentActivityState {
  if (payload.type === 'subagent.started') return 'running';
  if (payload.type === 'subagent.completed') return 'completed';
  if (payload.type === 'subagent.failed') return 'failed';
  return fallback;
}

function sortActivities(activities: readonly SubagentActivity[]): SubagentActivity[] {
  return [...activities]
    .toSorted((a, b) => {
      const aActive = a.state === 'spawning' || a.state === 'running';
      const bActive = b.state === 'spawning' || b.state === 'running';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, MAX_RETAINED_SUBAGENTS);
}

/**
 * Fold one durable `subagent.*` event into the Web-visible activity roster.
 * It tolerates a replay that begins mid-lifecycle, so a reconnect cannot leave
 * a child agent forever invisible merely because its spawn event was pruned.
 */
export function applySubagentActivityEvent(
  current: readonly SubagentActivity[],
  payload: { type: string; [key: string]: unknown },
  now = Date.now(),
): SubagentActivity[] {
  if (!payload.type.startsWith('subagent.')) return current as SubagentActivity[];

  const record = payload as Record<string, unknown>;
  const subagentId = stringField(record, 'subagentId');
  if (!subagentId) return current as SubagentActivity[];
  const index = current.findIndex((item) => item.subagentId === subagentId);
  const existing = index === -1 ? undefined : current[index];
  const state = statusFrom(record, existing?.state ?? 'spawning');
  const name = stringField(record, 'subagentName') ?? existing?.name ?? 'agent';
  const parentToolCallId = stringField(record, 'parentToolCallId') ?? existing?.parentToolCallId ?? '';
  const activity: SubagentActivity = {
    subagentId,
    name,
    parentToolCallId,
    description: stringField(record, 'description') ?? existing?.description,
    runInBackground: typeof record.runInBackground === 'boolean'
      ? record.runInBackground
      : (existing?.runInBackground ?? false),
    state,
    updatedAt: now,
    resultSummary: summaryField(record, 'resultSummary') ?? existing?.resultSummary,
    error: summaryField(record, 'error') ?? existing?.error,
    usage: usageField(record) ?? existing?.usage,
    contextTokens: numberField(record, 'contextTokens') ?? existing?.contextTokens,
    turns: numberField(record, 'turns') ?? existing?.turns,
    durationMs: numberField(record, 'durationMs') ?? existing?.durationMs,
    toolCallCount: numberField(record, 'toolCallCount') ?? existing?.toolCallCount,
  };

  const next = index === -1
    ? [...current, activity]
    : current.map((item, itemIndex) => itemIndex === index ? activity : item);
  return sortActivities(next);
}
