/**
 * `repairMessageStructure`: the normalization the loop applies once a
 * provider rejects the message sequence itself. Each rule is pinned on its
 * own, plus the guarantees that matter for a retry: a valid sequence passes
 * through unchanged, and the input is never mutated (only the request copy
 * changes, never the stored history).
 */
import type { Message, ToolCall } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import {
  CONTINUATION_USER_TEXT,
  EMPTY_TOOL_RESULT_TEXT,
  repairMessageStructure,
} from '../../src/loop/structure-repair';

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistant(text: string, toolCalls: ToolCall[] = []): Message {
  return { role: 'assistant', content: text === '' ? [] : [{ type: 'text', text }], toolCalls };
}

function call(id: string): ToolCall {
  return { type: 'function', id, name: 'echo', arguments: '{}' };
}

function result(toolCallId: string, text: string): Message {
  return { role: 'tool', content: [{ type: 'text', text }], toolCalls: [], toolCallId };
}

const system: Message = { role: 'system', content: [{ type: 'text', text: 'sys' }], toolCalls: [] };

describe('repairMessageStructure', () => {
  it('leaves a valid sequence as it is', () => {
    const valid = [system, user('hi'), assistant('', [call('a')]), result('a', 'ok'), assistant('done')];
    expect(repairMessageStructure(valid)).toEqual(valid);
  });

  it('drops blank text parts and the messages they leave empty', () => {
    const repaired = repairMessageStructure([
      user('hi'),
      { role: 'assistant', content: [{ type: 'text', text: '  ' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'again' }], toolCalls: [] },
    ]);
    // The blank assistant message goes, so the two user turns merge.
    expect(repairMessageStructure(repaired)).toEqual(repaired);
    expect(repaired).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'again' }], toolCalls: [] },
    ]);
  });

  it('keeps an assistant tool call whose text is blank', () => {
    const repaired = repairMessageStructure([
      user('hi'),
      { role: 'assistant', content: [{ type: 'text', text: '' }], toolCalls: [call('a')] },
      result('a', 'ok'),
    ]);
    expect(repaired[1]).toEqual({ role: 'assistant', content: [], toolCalls: [call('a')] });
  });

  it('gives an empty tool result a marker instead of dropping it', () => {
    const repaired = repairMessageStructure([
      user('hi'),
      assistant('', [call('a')]),
      { role: 'tool', content: [{ type: 'text', text: ' ' }], toolCalls: [], toolCallId: 'a' },
    ]);
    expect(repaired[2]).toEqual(result('a', EMPTY_TOOL_RESULT_TEXT));
  });

  it('merges same-role runs in order, but never into an assistant tool call', () => {
    const repaired = repairMessageStructure([
      user('one'),
      user('two'),
      assistant('a'),
      assistant('b', [call('x')]),
      result('x', 'ok'),
      assistant('c'),
    ]);
    expect(repaired).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
        toolCalls: [call('x')],
      },
      result('x', 'ok'),
      assistant('c'),
    ]);
    // An assistant message that already carries tool calls keeps its boundary:
    // its results must follow it directly.
    const withCalls = repairMessageStructure([user('u'), assistant('', [call('y')]), assistant('after')]);
    expect(withCalls).toHaveLength(3);
  });

  it('puts a neutral user turn in front when the sequence opens on the assistant', () => {
    const repaired = repairMessageStructure([system, assistant('resumed'), user('next')]);
    expect(repaired).toEqual([system, user(CONTINUATION_USER_TEXT), assistant('resumed'), user('next')]);
  });

  it('renames a repeated tool-call id together with the result that answers it', () => {
    const repaired = repairMessageStructure([
      user('u'),
      assistant('', [call('dup')]),
      result('dup', 'first'),
      assistant('', [call('dup')]),
      result('dup', 'second'),
    ]);
    expect(repaired[1]!.toolCalls[0]!.id).toBe('dup');
    expect(repaired[2]!.toolCallId).toBe('dup');
    expect(repaired[3]!.toolCalls[0]!.id).toBe('dup_2');
    expect(repaired[4]).toEqual(result('dup_2', 'second'));
  });

  it('maps repeats inside one message to results by order, three deep', () => {
    const repaired = repairMessageStructure([
      user('u'),
      assistant('', [call('x'), call('x'), call('x')]),
      result('x', 'r1'),
      result('x', 'r2'),
      result('x', 'r3'),
    ]);
    expect(repaired[1]!.toolCalls.map((c) => c.id)).toEqual(['x', 'x_2', 'x_3']);
    expect(repaired.slice(2).map((m) => [m.toolCallId, (m.content[0] as { text: string }).text])).toEqual([
      ['x', 'r1'],
      ['x_2', 'r2'],
      ['x_3', 'r3'],
    ]);
  });

  it('never picks a renamed id that is already in use', () => {
    const repaired = repairMessageStructure([
      user('u'),
      assistant('', [call('a'), call('a_2')]),
      result('a', '1'),
      result('a_2', '2'),
      assistant('', [call('a')]),
      result('a', '3'),
    ]);
    expect(repaired[4]!.toolCalls[0]!.id).toBe('a_3');
    expect(repaired[5]!.toolCallId).toBe('a_3');
  });

  it('does not mutate its input', () => {
    const input = [
      assistant('lead'),
      user(' '),
      assistant('', [call('d')]),
      result('d', ''),
      assistant('', [call('d')]),
      result('d', 'x'),
    ];
    const snapshot = structuredClone(input);
    repairMessageStructure(input);
    expect(input).toEqual(snapshot);
  });
});
