import type { Component } from '@liutod-scream/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { LiveTailContainer } from '#/tui/components/transcript/live-tail-container';

class FakeChild implements Component {
  readonly invalidateSpy = vi.fn();

  constructor(
    private readonly lines: (innerWidth: number) => string[],
  ) {}

  invalidate(): void {
    this.invalidateSpy();
  }

  render(width: number): string[] {
    return this.lines(width);
  }
}

/** Strips the gutter so a case can index rows by their own text. */
function rows(container: LiveTailContainer): string[] {
  return container.render(40).map((line) => line.trim());
}

describe('LiveTailContainer', () => {
  it('renders a pinned child last and restores the array order once unpinned', () => {
    const c = new LiveTailContainer(1, 1);
    const first = new FakeChild(() => ['first']);
    const pinned = new FakeChild(() => ['pinned']);
    const last = new FakeChild(() => ['last']);
    c.addChild(first);
    c.addChild(pinned);
    c.addChild(last);

    c.pinTail(pinned);
    expect(rows(c)).toEqual(['first', 'last', 'pinned']);

    expect(c.unpinTail(pinned)).toBe(true);
    // Same set of rows, back in array order — the pin moved nothing out or in.
    expect(rows(c)).toEqual(['first', 'pinned', 'last']);
    expect(rows(c)).toHaveLength(3);
  });

  it('reports a row move only for a pinned child that is not already last', () => {
    // Already the array's last child: dropping the pin changes no row.
    const tailOnly = new LiveTailContainer(1, 1);
    const onlyBlock = new FakeChild(() => ['block']);
    tailOnly.addChild(onlyBlock);
    tailOnly.pinTail(onlyBlock);
    expect(tailOnly.unpinTail(onlyBlock)).toBe(false);

    const c = new LiveTailContainer(1, 1);
    const block = new FakeChild(() => ['block']);
    const below = new FakeChild(() => ['below']);
    c.addChild(block);
    c.addChild(below);

    // A different child must not release the pin (the block keeps rendering last).
    c.pinTail(block);
    expect(c.unpinTail(below)).toBe(false);
    expect(rows(c)).toEqual(['below', 'block']);
    // The pinned child is no longer the array's last one: the pin still moved
    // rows, so dropping it reports the move.
    expect(c.unpinTail(block)).toBe(true);
    expect(rows(c)).toEqual(['block', 'below']);

    // Nothing pinned at all: nothing to release.
    expect(c.unpinTail()).toBe(false);
  });

  it('falls back to the array order without throwing when the pinned child was removed', () => {
    const c = new LiveTailContainer(1, 1);
    const block = new FakeChild(() => ['block']);
    const below = new FakeChild(() => ['below']);
    c.addChild(block);
    c.addChild(below);
    c.pinTail(block);

    c.removeChild(block);

    expect(() => c.unpinTail(block)).not.toThrow();
    expect(c.unpinTail(block)).toBe(false);
    expect(rows(c)).toEqual(['below']);
  });

  it('drops the pin when the container is cleared', () => {
    const c = new LiveTailContainer(1, 1);
    const block = new FakeChild(() => ['block']);
    const below = new FakeChild(() => ['below']);
    c.addChild(block);
    c.addChild(below);
    c.pinTail(block);

    c.clear();

    expect(c.children).toHaveLength(0);
    expect(rows(c)).toEqual([]);
    // The pin did not survive the clear: a fresh pin governs later children.
    c.addChild(block);
    c.addChild(below);
    expect(rows(c)).toEqual(['block', 'below']);
  });

  it('invalidates every child, pinned or not', () => {
    const c = new LiveTailContainer(1, 1);
    const block = new FakeChild(() => ['block']);
    const below = new FakeChild(() => ['below']);
    c.addChild(block);
    c.addChild(below);
    c.pinTail(block);

    c.invalidate();

    expect(block.invalidateSpy).toHaveBeenCalledTimes(1);
    expect(below.invalidateSpy).toHaveBeenCalledTimes(1);
  });
});
