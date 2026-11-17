import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { type FitItem, fitRow } from '#/tui/utils/fit-row';

const item = (id: string, rank: FitItem['rank'], ...variants: string[]): FitItem => ({
  id,
  rank,
  variants,
});

describe('fitRow', () => {
  it('lays the groups out flush left and flush right when everything fits', () => {
    const row = fitRow([item('a', 1, 'aaa'), item('b', 1, 'bbb')], [item('c', 1, 'ccc')], 30);
    expect(row).toBe(`aaa  bbb${' '.repeat(30 - 8 - 3)}ccc`);
    expect(visibleWidth(row)).toBe(30);
  });

  it('pads a row without a right group, and right-aligns a row without a left group', () => {
    expect(fitRow([item('a', 1, 'aaa')], [], 10)).toBe('aaa       ');
    expect(fitRow([], [item('c', 1, 'ccc')], 10)).toBe('       ccc');
    expect(fitRow([], [], 4)).toBe('    ');
  });

  it('returns an empty string for a width of zero or less', () => {
    expect(fitRow([item('a', 1, 'aaa')], [], 0)).toBe('');
    expect(fitRow([item('a', 1, 'aaa')], [], -5)).toBe('');
  });

  it('drops the highest-ranked item first', () => {
    const left = [item('keep', 1, 'KEEP'), item('mid', 5, 'MID'), item('gone', 9, 'GONE')];
    // KEEP + MID needs 4 + 2 + 3 = 9; with GONE it is 15.
    const row = fitRow(left, [], 10);
    expect(row).toContain('KEEP');
    expect(row).toContain('MID');
    expect(row).not.toContain('GONE');
    expect(fitRow(left, [], 5).trimEnd()).toBe('KEEP');
  });

  it('on a tie drops the later item in reading order first, keeping the leftmost', () => {
    const left = [item('x', 5, 'XX'), item('y', 5, 'YY'), item('z', 5, 'ZZ')];
    expect(fitRow(left, [], 8).trimEnd()).toBe('XX  YY');
    expect(fitRow(left, [], 4).trimEnd()).toBe('XX');
    // Left items are ahead of right items in reading order.
    expect(fitRow([item('l', 5, 'LL')], [item('r', 5, 'RR')], 4).trim()).toBe('LL');
  });

  it('shrinks through the variants before dropping an item', () => {
    const left = [item('label', 5, 'long label', 'label', 'l')];
    expect(fitRow(left, [], 10)).toBe('long label');
    expect(fitRow(left, [], 9)).toBe('label    '.padEnd(9));
    expect(fitRow(left, [], 3)).toBe('l  ');
    // Only after the shortest variant does not fit either is it dropped.
    expect(fitRow(left, [], 0)).toBe('');
    expect(fitRow([...left, item('other', 1, 'OOOO')], [], 5).trimEnd()).toBe('OOOO');
  });

  it('honours one rank per shrink step', () => {
    // Step 0→1 at 9 (before the sibling's drop at 5), step 1→2 at 1 (after it).
    const items = [item('a', [9, 1], 'AAAAAAAA', 'AAAA', 'A'), item('b', 5, 'BBBB')];
    expect(fitRow(items, [], 14)).toBe('AAAAAAAA  BBBB');
    // 13 cols: only the cheap first step is taken, B stays.
    expect(fitRow(items, [], 10).trimEnd()).toBe('AAAA  BBBB');
    // 9 cols: B goes (rank 5) before A's second step (rank 1).
    expect(fitRow(items, [], 9).trimEnd()).toBe('AAAA');
    expect(fitRow(items, [], 3).trimEnd()).toBe('A');
  });

  it('can rank dropping separately from shrinking', () => {
    // `cache` shrinks early (rank 10) but is dropped late (dropRank 1).
    const cache: FitItem = { id: 'cache', rank: 10, dropRank: 1, variants: ['CACHE HIT 99', 'C99'] };
    const switches = item('sw', 5, 'SWITCH');
    // 12 + 2 + 6 = 20 fits whole; one column less and only the cheap shrink is taken.
    expect(fitRow([cache, switches], [], 20).trimEnd()).toBe('CACHE HIT 99  SWITCH');
    expect(fitRow([cache, switches], [], 19).trimEnd()).toBe('C99  SWITCH');
    expect(fitRow([cache, switches], [], 10).trimEnd()).toBe('C99');
  });

  it('never drops a keep item, only shrinks it', () => {
    const model: FitItem = { id: 'model', rank: 0.1, keep: true, variants: ['modelname', 'mod…'] };
    const extra = item('extra', 5, 'EXTRA');
    expect(fitRow([model, extra], [], 6).trimEnd()).toBe('mod…');
    expect(fitRow([model, extra], [], 16).trimEnd()).toBe('modelname  EXTRA');
    // 15 columns: EXTRA (rank 5) goes before the keep model has to shrink.
    expect(fitRow([model, extra], [], 15).trimEnd()).toBe('modelname');
  });

  it('hard-cuts with an ellipsis only when nothing but keep items is left and still too wide', () => {
    const model: FitItem = { id: 'model', rank: 0.1, keep: true, variants: ['abcdefghij'] };
    const row = fitRow([model], [], 6);
    expect(visibleWidth(row)).toBe(6);
    expect(row).toContain('…');
  });

  it('keeps at least `groupGap` columns between the groups', () => {
    const left = [item('l', 1, 'LLLL')];
    const right = [item('r', 5, 'RRRR')];
    // 4 + 3 + 4 = 11 fits exactly at 11; one column less and R must go.
    expect(fitRow(left, right, 11)).toBe('LLLL   RRRR');
    expect(fitRow(left, right, 10).trimEnd()).toBe('LLLL');
    expect(fitRow(left, right, 10, { groupGap: 2 })).toBe('LLLL  RRRR');
  });

  it('measures styled variants by their visible width', () => {
    const previous = chalk.level;
    chalk.level = 3;
    try {
      const styled = chalk.hex('#79eb00').bold('abcd');
      expect(visibleWidth(styled)).toBe(4);
      const row = fitRow([{ id: 'a', rank: 1, variants: [styled] }], [item('b', 1, 'zz')], 12);
      expect(visibleWidth(row)).toBe(12);
      expect(row).toContain(styled);
    } finally {
      chalk.level = previous;
    }
  });

  it('counts wide (CJK / emoji) characters as two columns', () => {
    const row = fitRow([item('a', 1, '计划')], [item('b', 1, '📟️ k2')], 12);
    expect(visibleWidth(row)).toBe(12);
    expect(row.startsWith('计划')).toBe(true);
    expect(row.endsWith('📟️ k2')).toBe(true);
  });

  it('ignores items without any variant', () => {
    const row = fitRow([item('empty', 1), item('a', 1, 'aa')], [], 6);
    expect(row).toBe('aa    ');
  });

  describe('properties (fixed-seed fuzz)', () => {
    // Small deterministic LCG so a failure is reproducible.
    function rng(seed: number): () => number {
      let state = seed;
      return () => {
        state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        return state / 4_294_967_296;
      };
    }
    const WORDS = ['a', 'bb', 'ccc', '计划', '群狼', 'RLM', '缓存命中: 98.90%', '📟️ model', 'Line: 未连接'];

    function randomItems(next: () => number, tag: string): FitItem[] {
      const count = 1 + Math.floor(next() * 5);
      return Array.from({ length: count }, (_, index) => {
        const variantCount = 1 + Math.floor(next() * 3);
        const variants = Array.from({ length: variantCount }, () => WORDS[Math.floor(next() * WORDS.length)]!);
        const id = `${tag}${String(index)}`;
        return { id, rank: Math.floor(next() * 10), keep: next() < 0.2, variants: variants.map((v) => `${v}#${id}`) };
      });
    }

    it('always yields exactly `width` columns and never overflows', () => {
      const next = rng(7);
      for (let round = 0; round < 400; round++) {
        const left = randomItems(next, 'L');
        const right = randomItems(next, 'R');
        const width = 1 + Math.floor(next() * 90);
        const row = fitRow(left, right, width);
        expect(visibleWidth(row), `round ${String(round)} width ${String(width)}`).toBe(width);
      }
    });

    it('never shows fewer items on a wider row', () => {
      const next = rng(11);
      const lost: string[] = [];
      for (let round = 0; round < 150; round++) {
        const left = randomItems(next, 'L');
        const right = randomItems(next, 'R');
        const ids = [...left, ...right].map((entry) => entry.id);
        let previous = new Set<string>();
        for (let width = 1; width <= 120; width++) {
          const row = fitRow(left, right, width);
          // An item is on the row when any of its variants is.
          const shown = new Set(ids.filter((id) => row.includes(`#${id}`)));
          // Ignore hard cuts: a cut row can lose the tail of a keep item.
          if (!row.includes('…')) {
            for (const id of previous) {
              if (!shown.has(id)) lost.push(`round ${String(round)} width ${String(width)} lost ${id}`);
            }
          }
          previous = shown;
        }
      }
      expect(lost).toEqual([]);
    });
  });
});
