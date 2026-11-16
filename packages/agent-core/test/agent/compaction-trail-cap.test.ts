/**
 * The compaction debug trail keeps a rendering of the whole pre-fold history
 * per compaction. Nothing reads it back — it exists so someone inspecting a
 * session can see what a compaction summarized — yet every `context.snapshot`
 * wrote the entire accumulated trail, so a session that compacted 16 times
 * wrote 16 snapshots of growing size (2 MB to 44 MB, ~400 MB total) while the
 * state actually restored (`history`) stayed under 1 MB. The trail is bounded
 * to the most recent compactions, in memory and in what restore brings back.
 */
import { describe, expect, it } from 'vitest';

import { MAX_COMPACTED_HISTORY_ENTRIES } from '#/agent/compaction/full';
import { testAgent } from './harness/agent';

describe('compaction debug trail', () => {
  it('keeps only the most recent entries as compactions accumulate', () => {
    const ctx = testAgent();
    const total = MAX_COMPACTED_HISTORY_ENTRIES + 3;
    for (let index = 1; index <= total; index += 1) {
      ctx.agent.context.appendUserMessage([{ type: 'text', text: `marker-${String(index)}` }]);
      ctx.agent.fullCompaction.markCompleted();
    }

    const trail = ctx.agent.fullCompaction.compactedHistory;
    expect(trail).toHaveLength(MAX_COMPACTED_HISTORY_ENTRIES);
    // Each entry renders the history as it was at that compaction, so entry k
    // mentions markers 1..k. The two kept are the last two compactions; the
    // earlier ones are what falls off.
    expect(trail[0]?.text).toContain(`marker-${String(total - 1)}`);
    expect(trail[0]?.text).not.toContain(`marker-${String(total)}`);
    expect(trail[1]?.text).toContain(`marker-${String(total)}`);
  });

  it('trims an oversized trail restored from an older snapshot, so the next snapshot is small', () => {
    const ctx = testAgent();
    const oversized = Array.from({ length: 16 }, (_, index) => ({ text: `entry-${String(index)}` }));

    ctx.agent.fullCompaction.restoreCompactedHistory(oversized);

    const trail = ctx.agent.fullCompaction.compactedHistory;
    expect(trail).toHaveLength(MAX_COMPACTED_HISTORY_ENTRIES);
    expect(trail.map((entry) => entry.text)).toEqual(
      oversized.slice(-MAX_COMPACTED_HISTORY_ENTRIES).map((entry) => entry.text),
    );
  });

  it('keeps a short trail untouched', () => {
    const ctx = testAgent();
    ctx.agent.fullCompaction.restoreCompactedHistory([{ text: 'only one' }]);
    expect(ctx.agent.fullCompaction.compactedHistory).toEqual([{ text: 'only one' }]);
  });
});
