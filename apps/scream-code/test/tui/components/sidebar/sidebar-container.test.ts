import type { Component } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import { SidebarContainer } from '#/tui/components/sidebar/sidebar-container';
import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import type { ColorPalette } from '#/tui/theme/colors';
import type { SidebarPanel } from '#/tui/components/sidebar/sidebar-panel';

const fakePalette = { primary: '#79eb00' } as unknown as ColorPalette;

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
    const container = new SidebarContainer(manager, () => {}, fakePalette);
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
    const container = new SidebarContainer(manager, () => {}, fakePalette);
    expect(container.render(80)).toEqual([]);
    manager.toggle('p');
    const openLines = container.render(80);
    expect(openLines.length).toBeGreaterThan(2); // leading blank + title strip + body
    expect(openLines[0]).toBe(''); // leading blank aligns with the welcome box
    expect(openLines[1]).toContain('P');
    manager.close();
    expect(container.render(80)).toEqual([]);
  });

  it('builds each panel body once and never rebuilds on data changes (live render)', () => {
    let turns = 1;
    let buildCount = 0;
    const manager = new SidebarManager(() => {}, {
      dataProvider: () => ({
        sessionStats: {
          turns,
          toolCalls: 0,
          compactions: 0,
          apiCalls: 0,
          tokensTotal: 0,
          tokensInputCacheHit: 0,
          tokensInputCacheMiss: 0,
          tokensOutput: 0,
          startedAt: Date.now(),
        },
      }),
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
    const container = new SidebarContainer(manager, () => {}, fakePalette);
    manager.toggle('p');
    container.render(80);
    expect(buildCount).toBe(1);
    container.render(80);
    expect(buildCount).toBe(1);
    turns = 42; // data change does not rebuild; the body renders live
    container.render(80);
    expect(buildCount).toBe(1);
  });

  it('stack renders every visible panel section in registration order', () => {
    const manager = new SidebarManager(() => {});
    const make = (id: string, text: string): SidebarPanel => ({
      id,
      title: id.toUpperCase(),
      width: 30,
      build: () => ({ render: () => [text] }) as unknown as Component,
    });
    manager.register(make('a', 'body-a'));
    manager.register(make('b', 'body-b'));
    const container = new SidebarContainer(manager, () => {}, fakePalette);
    manager.toggle('a');
    const text = container.render(80).join('\n');
    expect(text).toContain('body-a');
    expect(text).toContain('body-b');
    expect(text.indexOf('A') < text.lastIndexOf('B')).toBe(true); // A above B
  });

  it('skips panels hidden by the visible predicate', () => {
    const manager = new SidebarManager(() => {}, {
      dataProvider: () => ({ goal: undefined }),
    });
    const make = (id: string, visible?: (data: { goal?: unknown }) => boolean): SidebarPanel => ({
      id,
      title: id.toUpperCase(),
      width: 30,
      visible: visible as SidebarPanel['visible'],
      build: () => ({ render: () => [id] }) as unknown as Component,
    });
    manager.register(make('git'));
    manager.register(make('goal', (data) => data.goal !== undefined));
    const container = new SidebarContainer(manager, () => {}, fakePalette);
    manager.toggle('git');
    const lines = container.render(80).join('\n');
    expect(lines).toContain('git');
    expect(lines).not.toContain('goal');
  });
});
