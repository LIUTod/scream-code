import { describe, it, expect, vi } from 'vitest';

import { Text } from '@earendil-works/pi-tui';
import { CachedContainer } from '#/tui/utils/cached-container';

describe('CachedContainer', () => {
  it('caches render output until invalidated', () => {
    const container = new CachedContainer();
    const child = { render: vi.fn(() => ['line 1', 'line 2']) };
    container.addChild(child as unknown as Text);

    const first = container.render(80);
    expect(child.render).toHaveBeenCalledTimes(1);
    expect(first).toEqual(['line 1', 'line 2']);

    const second = container.render(80);
    expect(child.render).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('re-renders when width changes', () => {
    const container = new CachedContainer();
    const child = { render: vi.fn((width: number) => [`width ${width}`]) };
    container.addChild(child as unknown as Text);

    container.render(80);
    container.render(100);
    expect(child.render).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache when a child is added', () => {
    const container = new CachedContainer();
    const child = { render: vi.fn(() => ['line']) };
    container.addChild(child as unknown as Text);
    container.render(80);

    container.addChild(new Text('new', 0, 0));
    container.render(80);
    expect(child.render).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache when a child is removed', () => {
    const container = new CachedContainer();
    const text = new Text('line', 0, 0);
    const child = { render: vi.fn(() => ['line']) };
    container.addChild(child as unknown as Text);
    container.addChild(text);
    container.render(80);

    container.removeChild(text);
    container.render(80);
    expect(child.render).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache when cleared', () => {
    const container = new CachedContainer();
    const child = { render: vi.fn(() => ['line']) };
    container.addChild(child as unknown as Text);
    const before = container.render(80);

    container.clear();
    const after = container.render(80);
    expect(after).toEqual([]);
    expect(after).not.toBe(before);
  });

  it('invalidates cache when invalidate() is called', () => {
    const container = new CachedContainer();
    const child = { render: vi.fn(() => ['line']) };
    container.addChild(child as unknown as Text);
    container.render(80);

    container.invalidate();
    container.render(80);
    expect(child.render).toHaveBeenCalledTimes(2);
  });
});
