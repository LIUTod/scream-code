import { describe, expect, it } from 'vitest';

import {
  buildLineMapping,
  diffLineRuns,
  physicalLinesOf,
} from '../../src/tools/support/line-diff';

describe('physicalLinesOf', () => {
  it('counts lines the way Read and Edit do', () => {
    expect(physicalLinesOf('')).toEqual([]);
    expect(physicalLinesOf('a\n')).toEqual(['a']);
    expect(physicalLinesOf('a')).toEqual(['a']);
    expect(physicalLinesOf('a\nb\n')).toEqual(['a', 'b']);
    expect(physicalLinesOf('a\nb')).toEqual(['a', 'b']);
  });
});

describe('diffLineRuns', () => {
  it('produces one equal run when nothing changed', () => {
    const runs = diffLineRuns(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(runs).toEqual([{ type: 'equal', snapStart: 1, snapEnd: 3, curStart: 1, curEnd: 3 }]);
  });

  it('reports pure inserts as insert runs with empty snapshot spans', () => {
    // Insert at the start.
    expect(diffLineRuns(['b', 'c'], ['a', 'b', 'c'])).toEqual([
      { type: 'insert', snapStart: 1, snapEnd: 0, curStart: 1, curEnd: 1 },
      { type: 'equal', snapStart: 1, snapEnd: 2, curStart: 2, curEnd: 3 },
    ]);
    // Insert at the end.
    expect(diffLineRuns(['a'], ['a', 'x', 'y'])).toEqual([
      { type: 'equal', snapStart: 1, snapEnd: 1, curStart: 1, curEnd: 1 },
      { type: 'insert', snapStart: 2, snapEnd: 1, curStart: 2, curEnd: 3 },
    ]);
    // Insert in the middle.
    expect(diffLineRuns(['a', 'c'], ['a', 'b', 'c'])).toEqual([
      { type: 'equal', snapStart: 1, snapEnd: 1, curStart: 1, curEnd: 1 },
      { type: 'insert', snapStart: 2, snapEnd: 1, curStart: 2, curEnd: 2 },
      { type: 'equal', snapStart: 2, snapEnd: 2, curStart: 3, curEnd: 3 },
    ]);
  });

  it('reports pure deletes as delete runs with empty current spans', () => {
    // Delete from the middle.
    expect(diffLineRuns(['a', 'b', 'c'], ['a', 'c'])).toEqual([
      { type: 'equal', snapStart: 1, snapEnd: 1, curStart: 1, curEnd: 1 },
      { type: 'delete', snapStart: 2, snapEnd: 2, curStart: 2, curEnd: 1 },
      { type: 'equal', snapStart: 3, snapEnd: 3, curStart: 2, curEnd: 2 },
    ]);
    // Delete the head.
    expect(diffLineRuns(['a', 'b'], ['b'])).toEqual([
      { type: 'delete', snapStart: 1, snapEnd: 1, curStart: 1, curEnd: 0 },
      { type: 'equal', snapStart: 2, snapEnd: 2, curStart: 1, curEnd: 1 },
    ]);
    // Delete the tail.
    expect(diffLineRuns(['a', 'b'], ['a'])).toEqual([
      { type: 'equal', snapStart: 1, snapEnd: 1, curStart: 1, curEnd: 1 },
      { type: 'delete', snapStart: 2, snapEnd: 2, curStart: 2, curEnd: 1 },
    ]);
  });

  it('handles mixed insert and delete runs', () => {
    const runs = diffLineRuns(['a', 'b', 'c', 'd', 'e'], ['a', 'x', 'c', 'e']);
    expect(runs).toEqual([
      { type: 'equal', snapStart: 1, snapEnd: 1, curStart: 1, curEnd: 1 },
      { type: 'insert', snapStart: 2, snapEnd: 1, curStart: 2, curEnd: 2 },
      { type: 'delete', snapStart: 2, snapEnd: 2, curStart: 3, curEnd: 2 },
      { type: 'equal', snapStart: 3, snapEnd: 3, curStart: 3, curEnd: 3 },
      { type: 'delete', snapStart: 4, snapEnd: 4, curStart: 4, curEnd: 3 },
      { type: 'equal', snapStart: 5, snapEnd: 5, curStart: 4, curEnd: 4 },
    ]);
  });

  it('maps a full rewrite into one insert and one delete run with no shared lines', () => {
    const runs = diffLineRuns(['a', 'b'], ['x', 'y']);
    expect(runs).toEqual([
      { type: 'insert', snapStart: 1, snapEnd: 0, curStart: 1, curEnd: 2 },
      { type: 'delete', snapStart: 1, snapEnd: 2, curStart: 3, curEnd: 2 },
    ]);
  });

  it('returns null past the DP size cap instead of ballooning memory', () => {
    const big = Array.from({ length: 3001 }, (_, i) => `line-${String(i)}`);
    expect(diffLineRuns(big, [...big])).toBeNull();
    // Just under the cap still diffs.
    const ok = Array.from({ length: 2000 }, (_, i) => `line-${String(i)}`);
    const runs = diffLineRuns(ok, [...ok]);
    expect(runs).not.toBeNull();
    expect(runs?.[0]?.type).toBe('equal');
  });
});

describe('buildLineMapping', () => {
  it('maps snapshot lines through equal runs and leaves deleted lines unmapped', () => {
    const runs = diffLineRuns(['a', 'b', 'c', 'd', 'e'], ['a', 'x', 'c', 'e']);
    if (runs === null) throw new Error('expected a diff');
    const mapping = buildLineMapping(runs, 5, 4);

    expect(mapping.mapSnapshotLine(1)).toBe(1);
    expect(mapping.mapSnapshotLine(2)).toBeUndefined(); // deleted externally
    expect(mapping.mapSnapshotLine(3)).toBe(3);
    expect(mapping.mapSnapshotLine(4)).toBeUndefined(); // deleted externally
    expect(mapping.mapSnapshotLine(5)).toBe(4);
  });

  it('flags the first non-equal run touching the window', () => {
    const runs = diffLineRuns(['a', 'b', 'c', 'd', 'e'], ['a', 'x', 'c', 'e']);
    if (runs === null) throw new Error('expected a diff');
    const mapping = buildLineMapping(runs, 5, 4);

    // Window [3..5] maps to [3..4]; the insert's current span [2..2] is below
    // it and the deletes touch snapshot lines 2 and 4 — line 4 is inside the
    // snapshot window, so the delete run conflicts.
    const conflict = mapping.firstConflictingRun(3, 5, 3, 4);
    expect(conflict?.type).toBe('delete');
    expect(conflict?.snapStart).toBe(4);

    // Window [1..1] maps to [1..1] — clear of every external change.
    expect(mapping.firstConflictingRun(1, 1, 1, 1)).toBeUndefined();

    // Window [5..5] maps to [4..4] — the only nearby change (delete of
    // snapshot line 4) is outside the window and its current span is empty.
    expect(mapping.firstConflictingRun(5, 5, 4, 4)).toBeUndefined();
  });

  it('treats an insert landing inside the mapped window as a conflict', () => {
    const runs = diffLineRuns(['a', 'b', 'c'], ['a', 'x', 'y', 'b', 'c']);
    if (runs === null) throw new Error('expected a diff');
    const mapping = buildLineMapping(runs, 3, 5);

    // Window [2..3] maps to [4..5]; the insert's current span [2..3] sits
    // below it — clear.
    expect(mapping.firstConflictingRun(2, 3, 4, 5)).toBeUndefined();
    // Window [1..3] maps to [1..5]; the insert's current span [2..3] falls
    // inside — conflict.
    const conflict = mapping.firstConflictingRun(1, 3, 1, 5);
    expect(conflict?.type).toBe('insert');
    expect(conflict?.curStart).toBe(2);
    expect(conflict?.curEnd).toBe(3);
  });
});
