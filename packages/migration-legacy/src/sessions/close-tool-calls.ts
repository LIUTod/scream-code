import type { NormalizedMessage } from './translator.js';

const PLACEHOLDER_TEXT = '[tool result unavailable — session imported from scream-cli]';

/**
 * Close dangling tool calls so no messages are dropped on resume.
 *
 * scream-core's context module defers messages while a tool exchange is open
 * (i.e. an assistant message has `toolCalls` whose ids are not all satisfied
 * by later `tool` messages) and only flushes once every pending tool-result
 * id is satisfied. A scream-cli session interrupted mid-tool-call therefore
 * never closes that exchange, and every subsequent message is silently
 * dropped from history.
 *
 * For each assistant `toolCall.id` with no matching `role:'tool'` message
 * anywhere in the list, this synthesizes a placeholder tool result and
 * inserts it immediately after the assistant message — before any later
 * real message — so the exchange closes in place and ordering is preserved.
 */
export function closeDanglingToolCalls(
  messages: readonly NormalizedMessage[],
): NormalizedMessage[] {
  const satisfied = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId !== undefined && msg.toolCallId !== '') {
      satisfied.add(msg.toolCallId);
    }
  }

  const out: NormalizedMessage[] = [];
  for (const msg of messages) {
    out.push(msg);
    if (msg.role !== 'assistant') continue;
    for (const call of msg.toolCalls) {
      if (call.id === '' || satisfied.has(call.id)) continue;
      out.push({
        role: 'tool',
        toolCallId: call.id,
        content: [{ type: 'text', text: PLACEHOLDER_TEXT }],
        toolCalls: [],
      });
      // Guard against an assistant message that lists the same call id twice.
      satisfied.add(call.id);
    }
  }
  return out;
}
