import { describe, expect, it } from 'vitest';

import {
  EDIT_SNAPSHOT_MAX_PATHS,
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
});
