import { describe, expect, it } from 'vitest';

import { createChatStreamingCallbacks, StreamDraftTracker } from '../../src/loop/turn-step';

describe('StreamDraftTracker', () => {
  it('flushes once accumulated characters cross the threshold', () => {
    const flushes: Array<{ text: string; think: string }> = [];
    const tracker = new StreamDraftTracker((text, think) => flushes.push({ text, think }));

    tracker.onText('x'.repeat(4_000));
    expect(flushes).toHaveLength(0);
    tracker.onText('y'.repeat(97));
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.text).toBe('x'.repeat(4_000) + 'y'.repeat(97));
  });

  it('clear without a prior flush writes nothing to the wire', () => {
    const flushes: Array<{ text: string; think: string }> = [];
    const tracker = new StreamDraftTracker((text, think) => flushes.push({ text, think }));

    tracker.onText('below threshold');
    // Whether this flushed depends on wall-clock timing (the 1.5s window may
    // elapse on a loaded runner); both are valid. What clear() must do is
    // write the empty clear record ONLY if the wire actually carries a draft.
    const flushedBefore = flushes.length;
    tracker.clear();
    if (flushedBefore === 0) {
      expect(flushes).toEqual([]);
    } else {
      expect(flushes).toHaveLength(flushedBefore + 1);
      expect(flushes.at(-1)).toEqual({ text: '', think: '' });
    }

    // Content after the clear accumulates fresh.
    tracker.onText('z'.repeat(4_100));
    expect(flushes.length).toBeGreaterThan(0);
    expect(flushes.at(-1)?.text.endsWith('z'.repeat(4_100))).toBe(true);
  });

  it('clear after a flushed draft writes the empty clear record', () => {
    const flushes: Array<{ text: string; think: string }> = [];
    const tracker = new StreamDraftTracker((text, think) => flushes.push({ text, think }));

    tracker.onText('x'.repeat(4_100));
    expect(flushes).toHaveLength(1);
    tracker.clear();
    expect(flushes).toHaveLength(2);
    expect(flushes[1]).toEqual({ text: '', think: '' });

    // Second clear is a no-op: the wire draft is already gone.
    tracker.clear();
    expect(flushes).toHaveLength(2);
  });

  it('accumulates think and text side by side', () => {
    const flushes: Array<{ text: string; think: string }> = [];
    const tracker = new StreamDraftTracker((text, think) => flushes.push({ text, think }));
    tracker.onThink('t'.repeat(4_096));
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.think).toBe('t'.repeat(4_096));
    expect(flushes[0]?.text).toBe('');
  });

  it('never throws when the sink fails', () => {
    const tracker = new StreamDraftTracker(() => {
      throw new Error('sink down');
    });
    expect(() => tracker.onText('x'.repeat(5_000))).not.toThrow();
    expect(() => tracker.clear()).not.toThrow();
  });

  it('think part landing clears the draft (cross-step stale guard)', async () => {
    // Regression: a long-thinking tool step flushes a think-only draft; its
    // part lands via onThinkPart which MUST clear the wire draft, otherwise
    // a later short text step (own tracker, never flushed) cannot clear it
    // and a completed turn restores with a false "incomplete" marker.
    const drafts: Array<{ text: string; think: string }> = [];
    const callbacks = createChatStreamingCallbacks({
      dispatchEvent: async () => {},
      turnId: 't1',
      currentStep: 0,
      stepUuid: 's1',
      onStreamingDraft: (text, think) => {
        drafts.push({ text, think });
      },
    });

    const { onThinkDelta, onThinkPart } = callbacks;
    await onThinkDelta?.('t'.repeat(5_000));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.think.length).toBe(5_000);

    await onThinkPart?.({ type: 'thinking', thinking: 'done' } as never);
    expect(drafts.at(-1)).toEqual({ text: '', think: '' });

    // A second think flush after the part still works (next streaming span).
    await onThinkDelta?.('u'.repeat(5_000));
    expect(drafts).toHaveLength(3);
    expect(drafts.at(-1)?.think.startsWith('u')).toBe(true);
  });
});
