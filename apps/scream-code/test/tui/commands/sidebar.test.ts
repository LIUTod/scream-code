import { describe, expect, it, vi } from 'vitest';

import { handleSidebarCommand, parseSidebarCommand } from '#/tui/commands/sidebar';
import { SidebarManager } from '#/tui/components/sidebar/sidebar-manager';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

describe('parseSidebarCommand', () => {
  it('toggles on a bare command', () => {
    expect(parseSidebarCommand('')).toEqual({ kind: 'toggle' });
    expect(parseSidebarCommand('  ')).toEqual({ kind: 'toggle' });
    expect(parseSidebarCommand('toggle')).toEqual({ kind: 'toggle' });
  });

  it('reads a width, or a hand-back to auto', () => {
    expect(parseSidebarCommand('width 40')).toEqual({ kind: 'width', cols: 40 });
    expect(parseSidebarCommand('width auto')).toEqual({ kind: 'resetWidth' });
    expect(parseSidebarCommand('width reset')).toEqual({ kind: 'resetWidth' });
  });

  it('says how to use it when the width is missing or not a number, and rejects the panel commands that are gone', () => {
    expect(parseSidebarCommand('width')).toMatchObject({ kind: 'error', message: expect.stringContaining('usage') });
    expect(parseSidebarCommand('width wide')).toMatchObject({ kind: 'error' });
    for (const gone of ['next', 'prev', 'panel jobs']) {
      expect(parseSidebarCommand(gone)).toMatchObject({ kind: 'error', message: expect.stringContaining('unknown') });
    }
  });
});

describe('handleSidebarCommand', () => {
  function host(): { host: SlashCommandHost; manager: SidebarManager; status: ReturnType<typeof vi.fn> } {
    const manager = new SidebarManager(() => {});
    const status = vi.fn();
    return { host: { state: { sidebarManager: manager }, showStatus: status } as unknown as SlashCommandHost, manager, status };
  }

  it('opens and closes, and says which', async () => {
    const h = host();
    await handleSidebarCommand(h.host, '');
    expect(h.manager.isOpen).toBe(true);
    expect(h.status).toHaveBeenLastCalledWith('sidebar: open');
    await handleSidebarCommand(h.host, '');
    expect(h.status).toHaveBeenLastCalledWith('sidebar: closed');
  });

  it('fixes the width and hands it back', async () => {
    const h = host();
    await handleSidebarCommand(h.host, 'width 36');
    expect(h.manager.chosenWidth).toBe(36);
    expect(h.status).toHaveBeenLastCalledWith('sidebar: closed (36 cols)');
    await handleSidebarCommand(h.host, 'width auto');
    expect(h.manager.chosenWidth).toBeUndefined();
  });

  it('only reports a usage error', async () => {
    const h = host();
    await handleSidebarCommand(h.host, 'next');
    expect(h.manager.isOpen).toBe(false);
    expect(h.status).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });
});
