import { describe, expect, it } from 'vitest';

import { MAX_COMPACTED_HISTORY_ENTRIES } from '../../../src/agent/compaction/full';
import { TRAIL_ENTRIES_KEPT_ON_READ } from '../../../src/agent/records/persistence';
import { locateTrail, trimSnapshotTrail } from '../../../src/agent/records/snapshot-trail';

function snapshot(trail: unknown[], extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'context.snapshot',
      history: [
        // A message mentioning the key, and a tool call whose args hold the key:
        // neither is the top-level trail.
        { role: 'user', content: [{ type: 'text', text: 'what is "compactedHistory": [1, 2] ?' }] },
        { role: 'assistant', toolCalls: [{ name: 'Edit', args: { compactedHistory: ['nested', ']', '\\"'] } }] },
      ],
      compactedHistory: trail,
      ...extra,
    }),
    'utf8',
  );
}

describe('snapshot trail trimming on bytes', () => {
  it('keeps the last entries of the top-level trail only, and the rest of the record exactly', () => {
    const trail = [1, 2, 3, 4].map((n) => ({ summary: `s${String(n)} with "quotes", [brackets] and \\ backslash`, messages: [{ n }] }));
    const line = snapshot(trail, { after: 'tail ]' });
    const trimmed = JSON.parse(trimSnapshotTrail(line, 2).toString('utf8')) as Record<string, unknown>;
    const original = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
    expect(trimmed['compactedHistory']).toEqual(trail.slice(-2));
    expect({ ...trimmed, compactedHistory: null }).toEqual({ ...original, compactedHistory: null });
  });

  it('empties the trail to the exact form the reclaim pass recognises', () => {
    const line = snapshot([{ a: 1 }, { b: 2 }]);
    const emptied = trimSnapshotTrail(line, 0).toString('utf8');
    expect(emptied).toContain('"compactedHistory":[]');
    expect(JSON.parse(emptied).history).toEqual(JSON.parse(line.toString('utf8')).history);
  });

  it('returns the same buffer when there is nothing to cut or no top-level trail', () => {
    const short = snapshot([{ a: 1 }]);
    expect(trimSnapshotTrail(short, 2)).toBe(short);
    const none = Buffer.from(JSON.stringify({ type: 'context.snapshot', history: [{ compactedHistory: [1, 2, 3] }] }));
    expect(locateTrail(none)).toBeUndefined();
    expect(trimSnapshotTrail(none, 0)).toBe(none);
    const torn = Buffer.from('{"type":"context.snapshot","compactedHistory":[{"a":1},{"b"');
    expect(trimSnapshotTrail(torn, 0)).toBe(torn);
  });

  it('keeps on read what restore keeps', () => {
    expect(TRAIL_ENTRIES_KEPT_ON_READ).toBe(MAX_COMPACTED_HISTORY_ENTRIES);
  });
});

describe('emptying a superseded snapshot trail for reclaim', () => {
  it('always ends with the marker the reclaim pass looks for, even when the byte scan cannot place the trail', async () => {
    const { withEmptySnapshotTrail } = await import('../../../src/agent/records/persistence');
    const withTrail = snapshot([{ a: 1 }]);
    expect(withEmptySnapshotTrail(withTrail).toString()).toContain('"compactedHistory":[]');
    // A snapshot written without the key: the old parse path adds it.
    const noKey = Buffer.from(JSON.stringify({ type: 'context.snapshot', history: [] }));
    expect(withEmptySnapshotTrail(noKey).toString()).toContain('"compactedHistory":[]');
    // Not JSON: returned untouched.
    const broken = Buffer.from('{"type":"context.snapshot",');
    expect(withEmptySnapshotTrail(broken)).toBe(broken);
  });
});
