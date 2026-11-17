import type { ContentPart, Message, ToolCall } from '@scream-code/ltod';

/**
 * Request-structure repair: the recovery for a provider that rejects the
 * message sequence itself (see `isRecoverableRequestStructureError` in ltod —
 * "text content blocks must be non-empty", "first message must use the user
 * role", "roles must alternate", "tool_use ids must be unique", "must not be
 * empty").
 *
 * The context projector already keeps the common shapes valid, but stricter
 * endpoints still refuse some sequences an interruption or a resumed wire can
 * leave behind. The rejection is deterministic — the same history is re-sent
 * every step — so the loop normalizes once and retries, and keeps the
 * normalized projection for the rest of the turn (`StructureRepairState`).
 *
 * Only the request copy changes; the stored history is untouched. Every step
 * keeps the conversation's meaning: blank text is dropped, an empty tool
 * result says so, same-role runs merge in order, a sequence that opens on the
 * assistant gets a neutral user turn in front, and a repeated tool-call id is
 * renamed together with the result that answers it.
 */

/** Stands in for a tool result whose content was empty or blank. */
export const EMPTY_TOOL_RESULT_TEXT = '(no output)';
/** Opens a sequence whose first non-system message is not the user's. */
export const CONTINUATION_USER_TEXT = '(continuing the conversation)';

function isBlankText(part: ContentPart): boolean {
  return part.type === 'text' && part.text.trim().length === 0;
}

/** Blank text parts out; a tool result keeps a marker, other empty messages go. */
function dropBlankContent(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const content = message.content.filter((part) => !isBlankText(part));
    if (message.role === 'tool') {
      out.push({
        ...message,
        content: content.length > 0 ? content : [{ type: 'text', text: EMPTY_TOOL_RESULT_TEXT }],
      });
      continue;
    }
    if (content.length === 0 && message.toolCalls.length === 0) continue;
    out.push({ ...message, content });
  }
  return out;
}

/**
 * Merge runs of user messages, and of assistant messages, into one message
 * each, in order. An assistant message that carries tool calls is never merged
 * into: its results must follow it directly.
 */
function mergeSameRoleRuns(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    const mergeable =
      previous !== undefined &&
      previous.role === message.role &&
      (message.role === 'user' || (message.role === 'assistant' && previous.toolCalls.length === 0));
    if (!mergeable) {
      out.push(message);
      continue;
    }
    out[out.length - 1] = {
      ...previous,
      content: [...previous.content, ...message.content],
      toolCalls: [...previous.toolCalls, ...message.toolCalls],
    };
  }
  return out;
}

/** The first non-system message must be the user's. */
function ensureUserFirst(messages: readonly Message[]): Message[] {
  const first = messages.findIndex((message) => message.role !== 'system');
  if (first === -1 || messages[first]!.role === 'user') return [...messages];
  return [
    ...messages.slice(0, first),
    { role: 'user', content: [{ type: 'text', text: CONTINUATION_USER_TEXT }], toolCalls: [] },
    ...messages.slice(first),
  ];
}

/**
 * Give every tool call a unique id. A repeated id is renamed on the assistant
 * message that repeats it and on the result that answers that call: the n-th
 * call with an id in a message is answered by the n-th later tool result with
 * that id (results before the message belong to earlier calls).
 */
function dedupeToolCallIds(messages: readonly Message[]): Message[] {
  const out = [...messages];
  const used = new Set<string>();
  for (const message of out) {
    for (const call of message.toolCalls) used.add(call.id);
  }
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const message = out[i]!;
    if (message.toolCalls.length === 0) continue;
    const occurrence = new Map<string, number>();
    const renames: Array<{ readonly id: string; readonly nth: number; readonly renamed: string }> = [];
    const toolCalls: ToolCall[] = message.toolCalls.map((call) => {
      const nth = occurrence.get(call.id) ?? 0;
      occurrence.set(call.id, nth + 1);
      if (!seen.has(call.id)) {
        seen.add(call.id);
        return call;
      }
      let suffix = 2;
      while (used.has(`${call.id}_${String(suffix)}`)) suffix += 1;
      const renamed = `${call.id}_${String(suffix)}`;
      used.add(renamed);
      seen.add(renamed);
      renames.push({ id: call.id, nth, renamed });
      return { ...call, id: renamed };
    });
    if (renames.length === 0) continue;
    out[i] = { ...message, toolCalls };
    // Positions are taken before any rename, so renaming one result cannot
    // shift which result the next repeat of the same id maps to.
    const answers = new Map<string, number[]>();
    for (let j = i + 1; j < out.length; j++) {
      const candidate = out[j]!;
      if (candidate.role !== 'tool' || candidate.toolCallId === undefined) continue;
      const list = answers.get(candidate.toolCallId) ?? [];
      list.push(j);
      answers.set(candidate.toolCallId, list);
    }
    for (const { id, nth, renamed } of renames) {
      const index = answers.get(id)?.[nth];
      if (index !== undefined) out[index] = { ...out[index]!, toolCallId: renamed };
    }
  }
  return out;
}

export function repairMessageStructure(messages: readonly Message[]): Message[] {
  return dedupeToolCallIds(ensureUserFirst(mergeSameRoleRuns(dropBlankContent(messages))));
}
