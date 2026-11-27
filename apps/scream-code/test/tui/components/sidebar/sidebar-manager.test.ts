import { describe, expect, it, vi } from 'vitest';

import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '#/tui/components/sidebar/session-status';

describe('SidebarManager', () => {
  it('opens and closes, and asks for a repaint each time', () => {
    const render = vi.fn();
    const manager = new SidebarManager(render);
    expect(manager.isOpen).toBe(false);
    manager.toggle();
    expect(manager.isOpen).toBe(true);
    manager.toggle();
    expect(manager.isOpen).toBe(false);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('follows the terminal until a width is chosen: about 40%, between 40 and 60 columns', () => {
    const manager = new SidebarManager(() => {});
    expect(manager.chosenWidth).toBeUndefined();
    expect(manager.widthFor(90)).toBe(40);
    expect(manager.widthFor(100)).toBe(40);
    expect(manager.widthFor(130)).toBe(52);
    expect(manager.widthFor(150)).toBe(60);
    expect(manager.widthFor(400)).toBe(60);
  });

  it('keeps a chosen width, clamped, wherever the terminal is, until it is reset', () => {
    const render = vi.fn();
    const manager = new SidebarManager(render);
    manager.setWidth(36);
    expect(manager.chosenWidth).toBe(36);
    expect(manager.widthFor(100)).toBe(36);
    expect(manager.widthFor(300)).toBe(36);
    manager.setWidth(5);
    expect(manager.chosenWidth).toBe(SIDEBAR_MIN_WIDTH);
    manager.setWidth(500);
    expect(manager.chosenWidth).toBe(SIDEBAR_MAX_WIDTH);
    manager.setWidth(Number.NaN);
    expect(manager.chosenWidth).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
    manager.resetWidth();
    expect(manager.chosenWidth).toBeUndefined();
    expect(manager.widthFor(130)).toBe(52);
    expect(render).toHaveBeenCalled();
  });

  it('reads its data from the provider on every call, and is empty without one', () => {
    const manager = new SidebarManager(() => {});
    expect(manager.getData()).toEqual({});
    let seconds = 1;
    manager.setDataProvider(() => ({ firstToken: [seconds] }));
    expect(manager.getData().firstToken).toEqual([1]);
    seconds = 2;
    expect(manager.getData().firstToken).toEqual([2]);
  });
});
