import type { Message } from '#/message';
import {
  normalizeToolCallIdsForProvider,
  sanitizeOpenAIResponsesCallId,
  sanitizeToolCallId,
} from '#/providers/tool-call-id';
import { describe, expect, it } from 'vitest';

describe('sanitizeToolCallId', () => {
  it('passes through clean ids unchanged', () => {
    expect(sanitizeToolCallId('abc_123-def')).toBe('abc_123-def');
  });

  it('replaces non-safe characters with underscores', () => {
    expect(sanitizeToolCallId('call.id:1')).toBe('call_id_1');
    expect(sanitizeToolCallId('id with spaces')).toBe('id_with_spaces');
    expect(sanitizeToolCallId('特殊字符')).toBe('____');
  });

  it('truncates to maxLength', () => {
    expect(sanitizeToolCallId('abcdefghijklmnop', 8)).toBe('abcdefgh');
  });

  it('returns empty string for empty input without maxLength', () => {
    expect(sanitizeToolCallId('')).toBe('');
  });
});

describe('sanitizeOpenAIResponsesCallId', () => {
  it('strips pipe suffix from OpenAI Responses IDs', () => {
    expect(sanitizeOpenAIResponsesCallId('call_abc|step_1')).toBe('call_abc');
  });

  it('falls back to full id when no pipe', () => {
    expect(sanitizeOpenAIResponsesCallId('call_abc')).toBe('call_abc');
  });

  it('sanitizes after splitting', () => {
    expect(sanitizeOpenAIResponsesCallId('call.abc:1|step.1')).toBe('call_abc_1');
  });
});

describe('normalizeToolCallIdsForProvider', () => {
  function makeMsg(toolCalls: Array<{ id: string }>, toolCallId?: string): Message {
    return {
      role: toolCallId !== undefined ? 'user' : 'assistant',
      content: [],
      toolCalls: toolCalls.map((tc) => ({
        type: 'function' as const,
        id: tc.id,
        name: 'test',
        arguments: null,
      })),
      toolCallId,
    };
  }

  it('returns messages unchanged when all IDs are already clean', () => {
    const messages = [makeMsg([{ id: 'abc_123' }])];
    const result = normalizeToolCallIdsForProvider(messages, {
      normalize: (id) => sanitizeToolCallId(id),
    });
    expect(result).toBe(messages); // same reference
  });

  it('sanitizes dirty IDs in toolCalls and toolCallId', () => {
    const messages = [
      makeMsg([{ id: 'call.1' }]),
      makeMsg([], 'call.1'),
    ];
    const result = normalizeToolCallIdsForProvider(messages, {
      normalize: (id) => sanitizeToolCallId(id),
    });
    expect(result[0]!.toolCalls[0]!.id).toBe('call_1');
    expect(result[1]!.toolCallId).toBe('call_1');
  });

  it('resolves collisions with numeric suffix', () => {
    // Two different IDs that normalize to the same thing
    const messages = [
      makeMsg([{ id: 'call:a' }, { id: 'call-a' }]),
      makeMsg([], 'call:a'),
      makeMsg([], 'call-a'),
    ];
    const result = normalizeToolCallIdsForProvider(messages, {
      normalize: (id) => sanitizeToolCallId(id),
    });
    const id1 = result[0]!.toolCalls[0]!.id;
    const id2 = result[0]!.toolCalls[1]!.id;
    // They must be different
    expect(id1).not.toBe(id2);
    // toolCallIds must match their corresponding tool calls
    expect(result[1]!.toolCallId).toBe(id1);
    expect(result[2]!.toolCallId).toBe(id2);
  });

  it('truncates long IDs and resolves collisions', () => {
    const longId = 'a'.repeat(100);
    const messages = [
      makeMsg([{ id: longId }]),
      makeMsg([], longId),
    ];
    const result = normalizeToolCallIdsForProvider(messages, {
      normalize: (id) => sanitizeToolCallId(id, 10),
      maxLength: 10,
    });
    expect(result[0]!.toolCalls[0]!.id).toHaveLength(10);
    expect(result[1]!.toolCallId).toBe(result[0]!.toolCalls[0]!.id);
  });

  it('handles empty messages', () => {
    const result = normalizeToolCallIdsForProvider([], {
      normalize: (id) => sanitizeToolCallId(id),
    });
    expect(result).toEqual([]);
  });

  it('uses fallback id for empty normalized result', () => {
    const messages = [makeMsg([{ id: '...' }])];
    const result = normalizeToolCallIdsForProvider(messages, {
      normalize: () => '',
    });
    expect(result[0]!.toolCalls[0]!.id).toBe('tool_call');
  });
});
