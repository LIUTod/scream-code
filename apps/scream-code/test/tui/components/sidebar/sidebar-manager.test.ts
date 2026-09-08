import type { Component } from '@liutod-scream/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import type { SidebarPanel } from '#/tui/components/sidebar/sidebar-panel';

const fakeComponent = {} as Component;

function panel(id: string, title = id, width = 30): SidebarPanel {
  return { id, title, width, build: () => fakeComponent };
}

describe('SidebarManager', () => {
  it('registers panels in order and starts closed', () => {
    const m = new SidebarManager(() => {});
    m.register(panel('a'));
    m.register(panel('b'));
    expect(m.allPanels.map((p) => p.id)).toEqual(['a', 'b']);
    expect(m.isOpen).toBe(false);
    expect(m.activePanel).toBeUndefined();
  });

  it('unregister removes a panel and clears active state', () => {
    const m = new SidebarManager(() => {});
    m.register(panel('a'));
    m.activate('a');
    m.unregister('a');
    expect(m.allPanels).toHaveLength(0);
    expect(m.activePanel).toBeUndefined();
    expect(m.isOpen).toBe(false);
  });

  it('toggle opens the targeted panel and a second toggle closes it', () => {
    const req = vi.fn();
    const m = new SidebarManager(req);
    m.register(panel('a'));
    m.register(panel('b'));
    m.toggle('a');
    expect(m.isOpen).toBe(true);
    expect(m.activePanel?.id).toBe('a');
    expect(req).toHaveBeenCalled();
    m.toggle('a');
    expect(m.isOpen).toBe(false);
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('toggle with no arg toggles the current active panel', () => {
    const m = new SidebarManager(() => {});
    m.register(panel('a'));
    m.activate('a');
    m.toggle();
    expect(m.isOpen).toBe(false);
  });

  it('toggle falls back to activating a panel when one is not active', () => {
    const m = new SidebarManager(() => {});
    m.register(panel('a'));
    m.toggle();
    expect(m.isOpen).toBe(true);
    expect(m.activePanel?.id).toBe('a');
  });

  it('next/prev cycle through panels and wrap around', () => {
    const m = new SidebarManager(() => {});
    m.register(panel('a'));
    m.register(panel('b'));
    m.register(panel('c'));
    m.activate('a');
    m.next();
    expect(m.activePanel?.id).toBe('b');
    m.next();
    expect(m.activePanel?.id).toBe('c');
    m.next();
    expect(m.activePanel?.id).toBe('a');
    m.prev();
    expect(m.activePanel?.id).toBe('c');
  });

  it('setWidth clamps to [24,60] and resetWidth restores the default', () => {
    const m = new SidebarManager(() => {});
    m.setWidth(10);
    expect(m.currentWidth).toBe(24);
    m.setWidth(200);
    expect(m.currentWidth).toBe(60);
    m.setWidth(30);
    expect(m.currentWidth).toBe(30);
    m.resetWidth();
    expect(m.currentWidth).toBe(30);
  });

  it('getData proxies the dataProvider', () => {
    const provider = () => ({ planMode: 'active' });
    const m = new SidebarManager(() => {}, { dataProvider: provider });
    expect(m.getData()).toEqual({ planMode: 'active' });
  });

  it('reads widthStore on construction and writes on setWidth', () => {
    const load = vi.fn(() => 40);
    const save = vi.fn();
    const m = new SidebarManager(() => {}, { widthStore: { load, save } });
    expect(load).toHaveBeenCalledOnce();
    expect(m.currentWidth).toBe(40);
    m.setWidth(45);
    expect(save).toHaveBeenCalledWith(45);
    expect(m.currentWidth).toBe(45);
  });

  it('prev from a closed state wraps to the last panel', () => {
    const m = new SidebarManager(() => {});
    m.register(panel('a'));
    m.register(panel('b'));
    m.register(panel('c'));
    m.prev();
    expect(m.activePanel?.id).toBe('c');
    m.next();
    expect(m.activePanel?.id).toBe('a');
  });

  it('activate returns false for an unknown id and true for a registered one', () => {
    const m = new SidebarManager(() => {});
    m.register(panel('a'));
    expect(m.activate('nope')).toBe(false);
    expect(m.activePanel).toBeUndefined();
    expect(m.isOpen).toBe(false);
    expect(m.activate('a')).toBe(true);
    expect(m.activePanel?.id).toBe('a');
  });
});
