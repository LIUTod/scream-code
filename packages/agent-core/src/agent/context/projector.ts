import type { ContentPart, Message, TextPart } from '@scream-code/ltod';

import type { ContextMessage } from './types';

/** Synthetic error text used when a tool result is missing and must be
 * filled in so the provider accepts the message sequence. */
const SYNTHETIC_TOOL_RESULT_TEXT =
  '<system>ERROR: The tool call did not complete because of an interruption. ' +
  'Do not assume the tool executed successfully, and do not invent its result.</system>';

export interface ProjectOptions {
  /**
   * When true, a trailing (in-flight) tool call whose result never arrived is
   * closed by synthesizing an error tool result. When false, the trailing
   * exchange is left open for the trim / replay synthesis to handle.
   */
  readonly synthesizeMissing?: boolean;
  readonly onAnomaly?: (anomaly: ProjectionAnomaly) => void;
}

export type ProjectionAnomaly =
  | { kind: 'tool_result_reordered'; toolCallId: string }
  | { kind: 'tool_result_synthesized'; toolCallId: string; trailing: boolean };

export function project(history: readonly ContextMessage[], options?: ProjectOptions): Message[] {
  // Keep partial or empty assistant placeholders away from providers.
  // They can appear when a turn is aborted or errors before any content
  // or tool call is appended.
  const usable = history.filter((message) => {
    return (
      message.partial !== true &&
      !(message.role === 'assistant' && message.content.length === 0 && message.toolCalls.length === 0)
    );
  });
  const merged = mergeAdjacentUserMessages(usable, options?.onAnomaly);
  return repairToolExchangeAdjacency(merged, options);
}

/**
 * Closes every tool exchange whose assistant `tool_use` is not fully answered
 * by a matching `tool_result`. A mid-history orphan (a later user/assistant
 * message follows) can never be in-flight, so it is always closed by
 * synthesizing an error result. A trailing orphan is closed only when
 * `synthesizeMissing` is set — otherwise it is left for the trim / replay
 * synthesis. This prevents the provider error "must be followed by tool
 * messages responding to each tool_call_id" after an interruption (e.g. a
 * network drop mid-batch).
 */
function repairToolExchangeAdjacency(
  messages: readonly Message[],
  options?: ProjectOptions,
): Message[] {
  // The trailing exchange is the only one whose missing result may still be
  // in-flight: any assistant tool_use that precedes a later user/assistant
  // message has been overtaken by a new turn and cannot be pending.
  let lastNonToolIndex = messages.length - 1;
  while (lastNonToolIndex >= 0 && messages[lastNonToolIndex]?.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const out: Message[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    const message = messages[i]!;
    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      out.push(message);
      continue;
    }

    out.push(message);
    const pending = new Set(message.toolCalls.map((toolCall) => toolCall.id));
    let foreignBetween = false;
    for (let j = i + 1; j < messages.length && pending.size > 0; j++) {
      if (consumed.has(j)) continue;
      const next = messages[j]!;
      const toolCallId = next.toolCallId;
      if (next.role === 'tool' && toolCallId !== undefined && pending.has(toolCallId)) {
        out.push(next);
        consumed.add(j);
        pending.delete(toolCallId);
        if (foreignBetween) options?.onAnomaly?.({ kind: 'tool_result_reordered', toolCallId });
      } else {
        foreignBetween = true;
      }
    }
    const isMidHistory = i < lastNonToolIndex;
    if (options?.synthesizeMissing === true || isMidHistory) {
      for (const missingId of pending) {
        out.push(makeSyntheticToolResult(missingId));
        options?.onAnomaly?.({
          kind: 'tool_result_synthesized',
          toolCallId: missingId,
          trailing: !isMidHistory,
        });
      }
    }
  }
  return out;
}

function makeSyntheticToolResult(toolCallId: string): Message {
  return {
    role: 'tool',
    content: [{ type: 'text', text: SYNTHETIC_TOOL_RESULT_TEXT }],
    toolCalls: [],
    toolCallId,
  };
}

/**
 * Drops a trailing open tool exchange from a projected message list: when the
 * last assistant message carries tool calls whose results never arrived and
 * nothing follows, truncate from that batch so the compacted history does not
 * carry an unterminated exchange (which would be rejected or, if synthesized,
 * pollute the compaction prompt).
 */
function mergeAdjacentUserMessages(
  history: readonly ContextMessage[],
  _onAnomaly?: (anomaly: ProjectionAnomaly) => void,
): Message[] {
  const out: ContextMessage[] = [];
  for (const message of history) {
    const previous = out.at(-1);
    if (
      canMergeUserMessage(message) &&
      previous !== undefined &&
      canMergeUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    out.push(message);
  }
  return out.map(stripContextMetadata);
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
    origin: a.origin,
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}
