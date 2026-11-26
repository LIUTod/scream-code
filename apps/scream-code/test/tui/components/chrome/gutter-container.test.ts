import type { Component } from '@liutod-scream/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';

import { CONTENT_START } from '../../../helpers/row-markers';

class FakeChild implements Component {
  constructor(
    private readonly lines: (innerWidth: number) => string[],
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.lines(width);
  }
}

describe('GutterContainer', () => {
  it('prefixes every child line with `left` spaces', () => {
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => ['hello', 'world']));
    expect(c.render(20)).toEqual([`  ${CONTENT_START}hello`, `  ${CONTENT_START}world`]);
  });

  it('shrinks the width passed to children by left + right', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(2, 3);
    c.addChild(new FakeChild(seenWidth));
    c.render(20);
    expect(seenWidth).toHaveBeenCalledWith(15);
  });

  it('clamps inner width to at least 1 when gutters would otherwise consume it', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(5, 5);
    c.addChild(new FakeChild(seenWidth));
    c.render(2);
    expect(seenWidth).toHaveBeenCalledWith(1);
  });

  it('stacks lines from multiple children in order', () => {
    const c = new GutterContainer(1, 0);
    c.addChild(new FakeChild(() => ['a1', 'a2']));
    c.addChild(new FakeChild(() => ['b1']));
    expect(c.render(10)).toEqual([` ${CONTENT_START}a1`, ` ${CONTENT_START}a2`, ` ${CONTENT_START}b1`]);
  });

  it('returns an empty array when there are no children', () => {
    const c = new GutterContainer(2, 2);
    expect(c.render(20)).toEqual([]);
  });

  it('preserves ANSI sequences within child lines (only the leading pad is plain)', () => {
    const colored = '[31mred[0m';
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => [colored]));
    expect(c.render(20)).toEqual([`  ${CONTENT_START}${colored}`]);
  });

  it('keeps OSC 133 zone markers at the very start of a row, ahead of the gutter', () => {
    const c = new GutterContainer(1, 1);
    c.addChild(new FakeChild(() => ['\u001B]133;A\u0007■ asked', 'plain']));
    expect(c.render(20)).toEqual([`\u001B]133;A\u0007 ${CONTENT_START}■ asked`, ` ${CONTENT_START}plain`]);
  });

  it('marks the gutter as decoration so a copy leaves the padding out', () => {
    const c = new GutterContainer(3, 0);
    c.addChild(new FakeChild(() => ['text', '']));
    const [text, blank] = c.render(20);
    expect(text).toBe(`   ${CONTENT_START}text`);
    // A blank row keeps its mark too: it is a paragraph break, not decoration to drop.
    expect(blank).toBe(`   ${CONTENT_START}`);
  });

  it('does not add a second mark to a row that already says where its text starts', () => {
    const c = new GutterContainer(2, 0);
    c.addChild(new FakeChild(() => [`■ ${CONTENT_START}asked`]));
    expect(c.render(20)).toEqual([`  ■ ${CONTENT_START}asked`]);
  });

  it('adds no mark when there is no gutter', () => {
    const c = new GutterContainer(0, 2);
    c.addChild(new FakeChild(() => ['plain']));
    expect(c.render(20)).toEqual(['plain']);
  });
});
