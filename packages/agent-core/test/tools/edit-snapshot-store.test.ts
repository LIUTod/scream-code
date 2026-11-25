import { describe, expect, it } from 'vitest';

import {
  EDIT_SNAPSHOT_HISTORY,
  EDIT_SNAPSHOT_MAX_PATHS,
  EDIT_SNAPSHOT_TOTAL_BYTES,
  EditSnapshotStore,
  type EditSnapshot,
} from '../../src/tools/support/edit-snapshot-store';

function snapshotOf(content: string, recordedAt: EditSnapshot['recordedAt'] = 'read'): EditSnapshot {
  return { content, anchor: `anchor-${content}`, recordedAt };
}

describe('EditSnapshotStore', () => {
  it('round-trips remember and recall per path', () => {
    const store = new EditSnapshotStore();
    store.remember('/a.ts', snapshotOf('A'));
    store.remember('/b.ts', snapshotOf('B', 'edit'));

    expect(store.recall('/a.ts')).toEqual(snapshotOf('A'));
    expect(store.recall('/b.ts')).toEqual(snapshotOf('B', 'edit'));
    expect(store.recall('/missing.ts')).toBeUndefined();
  });

  it('overwrites the snapshot for the same path', () => {
    const store = new EditSnapshotStore();
    store.remember('/a.ts', snapshotOf('old'));
    store.remember('/a.ts', snapshotOf('new', 'edit'));

    expect(store.recall('/a.ts')).toEqual(snapshotOf('new', 'edit'));
    expect(store.recall('/a.ts')).toEqual(snapshotOf('new', 'edit'));
  });

  it('evicts the least-recently-used path past the 64-path cap', () => {
    const store = new EditSnapshotStore();
    expect(EDIT_SNAPSHOT_MAX_PATHS).toBe(64);
    for (let i = 0; i < EDIT_SNAPSHOT_MAX_PATHS; i += 1) {
      store.remember(`/p${String(i)}.ts`, snapshotOf(`c${String(i)}`));
    }

    // Inserting one more evicts the untouched oldest path.
    store.remember('/overflow.ts', snapshotOf('overflow'));
    expect(store.recall('/p0.ts')).toBeUndefined();
    expect(store.recall('/overflow.ts')).toBeDefined();
  });

  it('recall touches recency, protecting a path from the next eviction', () => {
    const store = new EditSnapshotStore();
    for (let i = 0; i < EDIT_SNAPSHOT_MAX_PATHS; i += 1) {
      store.remember(`/p${String(i)}.ts`, snapshotOf(`c${String(i)}`));
    }

    // Touch p0 so it becomes most-recent, then push one more path in: p1 (the
    // new least-recent) is evicted instead, and p0 survives.
    expect(store.recall('/p0.ts')).toEqual(snapshotOf('c0'));
    store.remember('/overflow.ts', snapshotOf('overflow'));

    expect(store.recall('/p0.ts')).toEqual(snapshotOf('c0'));
    expect(store.recall('/p1.ts')).toBeUndefined();
    expect(store.recall('/overflow.ts')).toBeDefined();
  });

  it('skips snapshots whose content exceeds the per-snapshot budget', () => {
    const store = new EditSnapshotStore();
    const oversized = 'a'.repeat(2 * 1024 * 1024 + 1);
    store.remember('/big.ts', snapshotOf(oversized));

    expect(store.recall('/big.ts')).toBeUndefined();
    // A path remembered before (or after) the oversized attempt is unaffected.
    store.remember('/small.ts', snapshotOf('S'));
    store.remember('/big.ts', snapshotOf(oversized));
    expect(store.recall('/small.ts')).toEqual(snapshotOf('S'));
  });

  it('keeps the views before the latest, so an older anchor still resolves', () => {
    const store = new EditSnapshotStore();
    store.remember('/a.ts', snapshotOf('read'));
    store.remember('/a.ts', snapshotOf('edit1', 'edit'));
    store.remember('/a.ts', snapshotOf('edit2', 'edit'));

    expect(store.recall('/a.ts')).toEqual(snapshotOf('edit2', 'edit'));
    expect(store.recallAnchor('/a.ts', 'anchor-read')).toEqual(snapshotOf('read'));
    expect(store.recallAnchor('/a.ts', 'anchor-nope')).toBeUndefined();
  });

  it('tells a change made only by the model’s own edits from any other', () => {
    const store = new EditSnapshotStore();
    store.remember('/a.ts', snapshotOf('read'));
    store.remember('/a.ts', snapshotOf('mine', 'edit'));

    expect(store.changedOnlyByOwnEdits('/a.ts', 'anchor-read', 'mine')).toBe(true);
    // The disk holds something else than our last apply: someone else changed it.
    expect(store.changedOnlyByOwnEdits('/a.ts', 'anchor-read', 'theirs')).toBe(false);
    // A Read after the anchor's view is not an own edit.
    store.remember('/b.ts', snapshotOf('first'));
    store.remember('/b.ts', snapshotOf('second'));
    expect(store.changedOnlyByOwnEdits('/b.ts', 'anchor-first', 'second')).toBe(false);
  });

  it('keeps a bounded history per path and re-reads do not fill it twice', () => {
    const store = new EditSnapshotStore();
    store.remember('/a.ts', snapshotOf('read'));
    store.remember('/a.ts', snapshotOf('read'));
    for (let i = 0; i < EDIT_SNAPSHOT_HISTORY; i += 1) store.remember('/a.ts', snapshotOf(`e${String(i)}`, 'edit'));

    // The oldest view fell out of the history; the newest ones remain.
    expect(store.recallAnchor('/a.ts', 'anchor-read')).toBeUndefined();
    expect(store.recallAnchor('/a.ts', `anchor-e${String(EDIT_SNAPSHOT_HISTORY - 1)}`)).toBeDefined();
  });

  it('drops older views first when the total budget is exceeded', () => {
    const store = new EditSnapshotStore();
    const chunk = 'x'.repeat(2 * 1024 * 1024 - 16);
    const count = Math.ceil(EDIT_SNAPSHOT_TOTAL_BYTES / chunk.length) + 2;
    for (let i = 0; i < count; i += 1) store.remember(`/p${String(i)}.ts`, snapshotOf(`${chunk}${String(i)}`));
    // The newest path always survives; the oldest went to stay within budget.
    expect(store.recall(`/p${String(count - 1)}.ts`)).toBeDefined();
    expect(store.recall('/p0.ts')).toBeUndefined();
  });

  it('keeps a view the model wrote as its own when it is read back', () => {
    const store = new EditSnapshotStore();
    store.remember('/a.ts', snapshotOf('read'));
    store.remember('/a.ts', snapshotOf('mine', 'edit'));
    // Re-reading the file it just edited: the same view, still the model's own.
    store.remember('/a.ts', snapshotOf('mine', 'read'));

    expect(store.recall('/a.ts')?.recordedAt).toBe('edit');
    expect(store.changedOnlyByOwnEdits('/a.ts', 'anchor-read', 'mine')).toBe(true);
  });
});
