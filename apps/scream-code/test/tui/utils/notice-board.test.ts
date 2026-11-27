import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoticeBoard } from '#/tui/utils/notice-board';

const note = (key: string, priority: number, ttlMs: number, text = key) => ({ key, text, color: '#fff', priority, ttlMs });

describe('NoticeBoard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the notice with the lowest priority number', () => {
    const board = new NoticeBoard(() => {});
    board.post(note('collab', 3, 8000));
    board.post(note('reminder', 1, 8000));
    board.post(note('mcp', 4, 8000));
    expect(board.top()?.text).toBe('reminder');
    board.dispose();
  });

  it('lets the newest of two equal priorities win', () => {
    const board = new NoticeBoard(() => {});
    board.post(note('a', 2, 8000));
    board.post(note('b', 2, 8000));
    expect(board.top()?.text).toBe('b');
    board.dispose();
  });

  it('replaces a notice that has the same key instead of stacking it', () => {
    const board = new NoticeBoard(() => {});
    board.post(note('mcp', 4, 8000, 'connecting 1/5'));
    board.post(note('mcp', 4, 8000, 'connecting 2/5'));
    expect(board.top()?.text).toBe('connecting 2/5');
    board.remove('mcp');
    expect(board.top()).toBeNull();
    board.dispose();
  });

  it('hands over to the next notice when the first one expires, and repaints', () => {
    const onChange = vi.fn();
    const board = new NoticeBoard(onChange);
    board.post(note('reminder', 1, 5000));
    board.post(note('collab', 3, 9000));
    expect(board.top()?.text).toBe('reminder');
    vi.advanceTimersByTime(5000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(board.top()?.text).toBe('collab');
    vi.advanceTimersByTime(4000);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(board.top()).toBeNull();
    board.dispose();
  });

  it('keeps a replaced notice alive for its new lifetime', () => {
    const board = new NoticeBoard(() => {});
    board.post(note('collab', 3, 4000));
    vi.advanceTimersByTime(3000);
    board.post(note('collab', 3, 4000));
    vi.advanceTimersByTime(3000);
    expect(board.top()).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(board.top()).toBeNull();
    board.dispose();
  });

  it('stops its timer on clear and dispose', () => {
    const onChange = vi.fn();
    const board = new NoticeBoard(onChange);
    board.post(note('a', 1, 1000));
    board.clear();
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
    board.post(note('b', 1, 1000));
    board.dispose();
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
