import type { Component } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import { SidebarContainer } from '#/tui/components/sidebar/sidebar-container';
import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import type { SidebarPanel } from '#/tui/components/sidebar/sidebar-panel';

describe('SidebarContainer', () => {
  it('renders the body at the manager currentWidth, not the static panel width', () => {
    const manager = new SidebarManager(() => {});
    const widths: number[] = [];
    const panel: SidebarPanel = {
      id: 'p',
      title: 'P',
      width: 30,
      build: () =>
        ({
          render: (w: number) => {
            widths.push(w);
            return [];
          },
        }) as unknown as Component,
    };
    manager.register(panel);
    const container = new SidebarContainer(manager, () => {}, '#888888');
    manager.setWidth(45);
    manager.toggle('p');
    container.render(80);
    // body receives contentWidth = width(45) − 2 frames − 2 padding = 41
    expect(widths[0]).toBe(41);
  });

  it('renders nothing when the sidebar is closed', () => {
    const manager = new SidebarManager(() => {});
    const panel: SidebarPanel = {
      id: 'p',
      title: 'P',
      width: 30,
      build: () => ({ render: () => ['x'] }) as unknown as Component,
    };
    manager.register(panel);
    const container = new SidebarContainer(manager, () => {}, '#888888');
    expect(container.render(80)).toEqual([]);
    manager.toggle('p');
    const openLines = container.render(80);
    expect(openLines.length).toBeGreaterThan(1); // title strip + bordered body
    expect(openLines[0]).toContain('P');
    manager.close();
    expect(container.render(80)).toEqual([]);
  });

  it('rebuilds the body only when the runtime data key changes while open', () => {
    let planMode = 'active';
    let buildCount = 0;
    const manager = new SidebarManager(() => {}, {
      dataProvider: () => ({ planMode }),
    });
    const panel: SidebarPanel = {
      id: 'p',
      title: 'P',
      width: 30,
      build: () => {
        buildCount += 1;
        return { render: () => [] } as unknown as Component;
      },
    };
    manager.register(panel);
    const container = new SidebarContainer(manager, () => {}, '#888888');
    manager.toggle('p');
    container.render(80);
    expect(buildCount).toBe(1);
    container.render(80);
    expect(buildCount).toBe(1); // no planMode/backgroundTasks change → no rebuild
    planMode = 'off';
    container.render(80);
    expect(buildCount).toBe(2); // data key changed → rebuild
  });
});
