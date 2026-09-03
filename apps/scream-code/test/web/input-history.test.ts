import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../src/web/frontend/src/types';
import {
  INPUT_HISTORY_LIMIT,
  deriveHistoryFromMessages,
  mergeInputHistory,
} from '../../src/web/frontend/src/utils/inputHistory';

function msg(id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, tools: [], ...extra };
}

describe('deriveHistoryFromMessages', () => {
  it('returns user texts newest-first, skipping assistant/system/local messages', () => {
    const messages: ChatMessage[] = [
      msg('1', 'user', '第一个问题'),
      msg('2', 'assistant', '回答一'),
      msg('3', 'user', '第二个问题'),
      msg('4', 'system', '系统通知'),
      msg('5', 'user', '本地占位', { local: true }),
    ];
    expect(deriveHistoryFromMessages(messages)).toEqual(['第二个问题', '第一个问题']);
  });

  it('dedupes repeated user texts keeping the newest occurrence', () => {
    const messages: ChatMessage[] = [
      msg('1', 'user', '同一个问题'),
      msg('2', 'user', '另一个问题'),
      msg('3', 'user', '同一个问题'),
    ];
    expect(deriveHistoryFromMessages(messages)).toEqual(['同一个问题', '另一个问题']);
  });

  it('skips blank/whitespace-only contents and tolerates missing content', () => {
    const messages: ChatMessage[] = [
      msg('1', 'user', '   '),
      msg('2', 'user', ''),
      msg('3', 'user', '  实际内容  '),
    ];
    expect(deriveHistoryFromMessages(messages)).toEqual(['实际内容']);
  });

  it('caps at the limit starting from the newest messages', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < INPUT_HISTORY_LIMIT + 10; i += 1) {
      messages.push(msg(`m${i}`, 'user', `msg-${i}`));
    }
    const out = deriveHistoryFromMessages(messages);
    expect(out).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(out[0]).toBe(`msg-${INPUT_HISTORY_LIMIT + 9}`);
    expect(out).not.toContain('msg-0');
  });

  it('returns an empty array for an empty journal', () => {
    expect(deriveHistoryFromMessages([])).toEqual([]);
  });
});

describe('mergeInputHistory', () => {
  it('merges derived entries chronologically with stored-only entries before them', () => {
    const merged = mergeInputHistory(
      ['/cmd', '旧输入', '共享输入'], // stored: old→new
      ['新输入', '共享输入'], // derived: newest→oldest
    );
    expect(merged).toEqual(['/cmd', '旧输入', '共享输入', '新输入']);
  });

  it('dedupes trimmed entries and never emits duplicates', () => {
    const merged = mergeInputHistory(['  dup  ', 'dup'], ['dup ']);
    expect(merged).toEqual(['dup']);
  });

  it('falls back to stored history in chronological order when no journal is loaded yet', () => {
    expect(mergeInputHistory(['/a', '/b'], [])).toEqual(['/a', '/b']);
  });

  it('keeps the newest `limit` entries and drops the oldest overflow', () => {
    const stored: string[] = [];
    const derived: string[] = [];
    for (let i = 0; i < 30; i += 1) stored.push(`stored-${i}`); // old→new
    for (let i = 39; i >= 0; i -= 1) derived.push(`derived-${i}`); // newest→oldest
    const merged = mergeInputHistory(stored, derived);
    expect(merged).toHaveLength(INPUT_HISTORY_LIMIT);
    // stored-only entries are treated as older offline records, so the
    // chronological list opens with them (minus the dropped overflow).
    expect(merged[0]).toBe('stored-20');
    expect(merged).not.toContain('stored-0');
    // …and closes with the journal entries, newest last.
    expect(merged.at(-1)).toBe('derived-39');
  });
});
