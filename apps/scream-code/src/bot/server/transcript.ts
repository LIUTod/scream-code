import type { Message } from '../shared/contracts';

/** Identity-only merge. Equal text is never evidence of equal identity. */
export function mergeMessages(projected: Message[], cached: Message[] | undefined): Message[] {
  if (cached === undefined) return projected;
  const ids = new Set(projected.map((message) => message.id));
  return [...projected,...cached.filter((message) => !ids.has(message.id))];
}

/** The assistant answer produced by one specific run, not the thread's newest. */
export function answerForRun(messages: readonly Message[], runId: string): string {
  const own = messages.findLast(
    (message) =>
      message.role === 'assistant' &&
      message.runId === runId &&
      message.content.trim().length > 0,
  );
  const fallback = messages.findLast(
    (message) => message.role === 'assistant' && message.content.trim().length > 0,
  );
  return (own ?? fallback)?.content.trim() ?? '';
}

/** Link new core messages to live aliases in turn/step order, never by text. */
export function reconcileMessages(
  projected: readonly Message[], cached: readonly Message[], eligibleRuns: ReadonlySet<string>,
): Message[] {
  const claimed = new Set<string>();
  const resolved = projected.map((core) => {
    const known = cached.find((message) => message.coreSessionId === core.coreSessionId && message.coreMessageId === core.coreMessageId);
    const canAlias = core.role !== 'user' || core.origin === undefined || (typeof core.origin === 'object' && core.origin !== null && 'kind' in core.origin && core.origin.kind === 'user');
    const previous = known ?? cached.find((message) => canAlias && message.coreMessageId === undefined && message.role === core.role &&
      message.runId !== undefined && eligibleRuns.has(message.runId) && !claimed.has(message.id));
    if (previous === undefined) return core;
    claimed.add(previous.id);
    return {...previous,...core,id:previous.id,createdAt:previous.createdAt,
      runId:previous.runId,turnId:previous.turnId,stepId:previous.stepId,origin:previous.origin};
  });
  const compacted = cached.filter((message) => message.coreMessageId !== undefined && !claimed.has(message.id));
  const pending = cached.filter((message) => message.coreMessageId === undefined && !claimed.has(message.id));
  // Keep compacted display history, then SDK order, then undispatched/live input.
  return [...compacted,...resolved,...pending];
}
