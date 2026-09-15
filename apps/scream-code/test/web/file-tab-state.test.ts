import { beforeEach, describe, expect, it, vi } from 'vitest';

// Node test env has no localStorage — install before the module import reads it.
vi.hoisted(() => {
  if ((globalThis as { localStorage?: unknown }).localStorage === undefined) {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    };
  }
});

import {
  activeDockTab,
  activeFileTab,
  closeDockTab,
  dockPanel,
  openDockTab,
  openFileInPanel,
  openFileTab,
  resolveInitialFileDisplayMode,
  saveFileViewerState,
  selectDockTab,
  setDockOpen,
  toggleDock,
} from '../../src/web/frontend/src/utils/fileTabState';

function reset(): void {
  dockPanel.tabs = [];
  dockPanel.activeTabId = null;
  dockPanel.panelOpen = false;
}

beforeEach(() => {
  reset();
  try {
    localStorage.removeItem('scream-file-tabs');
  } catch {
    // jsdom always has localStorage; guard is for safety only.
  }
});

describe('pure tab-list operations', () => {
  it('opens a new file tab tagged kind=file with viewerRevision 0', () => {
    const tabs = openFileTab([], {
      fileName: 'main.ts',
      filePath: '/src/main.ts',
      tabId: '/src/main.ts',
      sourceSessionId: null,
    });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.kind).toBe('file');
    expect(tabs[0]!.label).toBe('main.ts');
    expect('viewerRevision' in tabs[0]! && tabs[0]!.viewerRevision).toBe(0);
    expect('viewerState' in tabs[0]! && tabs[0]!.viewerState).toBeUndefined();
  });

  it('dedupes re-open without mode hint', () => {
    const once = openFileTab([], { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    const twice = openFileTab(once, { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    expect(twice).toBe(once); // unchanged identity
  });

  it('applies a diff mode hint with a revision bump', () => {
    const once = openFileTab([], { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    const hinted = openFileTab(once, { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts', modeHint: 'diff' });
    const tab = hinted[0]!;
    expect(tab.kind === 'file' && tab.initialDisplayMode).toBe('diff');
    expect(tab.kind === 'file' && tab.viewerRevision).toBe(1);
    expect(tab.kind === 'file' && tab.viewerState?.displayMode).toBe('diff');
  });

  it('saveFileViewerState rejects a stale revision', () => {
    const tabs = openFileTab([], { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    const stale = saveFileViewerState(tabs, '/a.ts', 7, { displayMode: 'source', wrapLines: true, scrollTop: 10, scrollLeft: 0 });
    expect(stale).toBe(tabs);
    const fresh = saveFileViewerState(tabs, '/a.ts', 0, { displayMode: 'source', wrapLines: true, scrollTop: 10, scrollLeft: 0 });
    const tab = fresh[0]!;
    expect(tab.kind === 'file' && tab.viewerState?.wrapLines).toBe(true);
  });

  it('resolveInitialFileDisplayMode prefers saved state, then hint, then source', () => {
    expect(resolveInitialFileDisplayMode(undefined, undefined)).toBe('source');
    expect(resolveInitialFileDisplayMode(undefined, 'diff')).toBe('diff');
    expect(resolveInitialFileDisplayMode({ displayMode: 'preview', wrapLines: false, scrollTop: 0, scrollLeft: 0 }, 'diff')).toBe('preview');
  });
});

describe('dock panel state machine (file tabs)', () => {
  it('opens a file: adds tab, activates, expands dock', () => {
    openFileInPanel('/src/a.ts');
    expect(dockPanel.tabs).toHaveLength(1);
    expect(dockPanel.activeTabId).toBe('/src/a.ts');
    expect(dockPanel.panelOpen).toBe(true);
  });

  it('opens multiple files and switches focus', () => {
    openFileInPanel('/src/a.ts');
    openFileInPanel('/src/b.ts');
    selectDockTab('/src/a.ts');
    expect(dockPanel.activeTabId).toBe('/src/a.ts');
    expect(activeFileTab()?.filePath).toBe('/src/a.ts');
  });

  it('closing the active tab activates the neighbor', () => {
    openFileInPanel('/src/a.ts');
    openFileInPanel('/src/b.ts');
    closeDockTab('/src/b.ts');
    expect(dockPanel.activeTabId).toBe('/src/a.ts');
    expect(dockPanel.panelOpen).toBe(true);
  });

  it('closing the last tab collapses the dock', () => {
    openFileInPanel('/src/a.ts');
    closeDockTab('/src/a.ts');
    expect(dockPanel.tabs).toHaveLength(0);
    expect(dockPanel.activeTabId).toBeNull();
    expect(dockPanel.panelOpen).toBe(false);
  });

  it('persists state across operations', () => {
    openFileInPanel('/src/a.ts');
    const raw = localStorage.getItem('scream-file-tabs');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { tabs: unknown[]; panelOpen: boolean };
    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.panelOpen).toBe(true);
  });

  it('setDockOpen keeps an existing tab active when reopening', () => {
    openFileInPanel('/src/a.ts');
    setDockOpen(false);
    setDockOpen(true);
    expect(dockPanel.activeTabId).toBe('/src/a.ts');
  });
});

describe('session-level dock tabs (singleton kinds)', () => {
  it('opens a session tab and expands the dock', () => {
    openDockTab('git');
    expect(dockPanel.tabs).toHaveLength(1);
    expect(dockPanel.tabs[0]!.kind).toBe('git');
    expect(dockPanel.activeTabId).toBe('dock:git');
    expect(dockPanel.panelOpen).toBe(true);
  });

  it('re-opening the same kind activates instead of creating a second tab', () => {
    openDockTab('git');
    openFileInPanel('/src/a.ts');
    openDockTab('git');
    expect(dockPanel.tabs).toHaveLength(2); // git + a.ts
    expect(dockPanel.tabs.filter((t) => t.kind === 'git')).toHaveLength(1);
    expect(dockPanel.activeTabId).toBe('dock:git');
  });

  it('mixes singleton session tabs with multi-instance file tabs', () => {
    openFileInPanel('/src/a.ts');
    openFileInPanel('/src/b.ts');
    openDockTab('todo');
    openDockTab('goal');
    expect(dockPanel.tabs.map((t) => t.kind)).toEqual(['file', 'file', 'todo', 'goal']);
    expect(activeDockTab()?.kind).toBe('goal');
    // Switching back to a file tab still resolves through activeFileTab.
    selectDockTab('/src/a.ts');
    expect(activeFileTab()?.filePath).toBe('/src/a.ts');
    expect(activeDockTab()?.kind).toBe('file');
  });

  it('closing a session tab leaves file tabs (and the dock) intact', () => {
    openFileInPanel('/src/a.ts');
    openDockTab('like');
    closeDockTab('dock:like');
    expect(dockPanel.tabs).toHaveLength(1);
    expect(dockPanel.activeTabId).toBe('/src/a.ts');
    expect(dockPanel.panelOpen).toBe(true);
  });

  it('closing the final session tab collapses the dock', () => {
    openDockTab('run');
    closeDockTab('dock:run');
    expect(dockPanel.tabs).toHaveLength(0);
    expect(dockPanel.panelOpen).toBe(false);
  });

  it('toggleDock flips visibility without touching the tab list', () => {
    openDockTab('detail');
    toggleDock();
    expect(dockPanel.panelOpen).toBe(false);
    expect(dockPanel.tabs).toHaveLength(1);
    toggleDock();
    expect(dockPanel.panelOpen).toBe(true);
    expect(dockPanel.activeTabId).toBe('dock:detail');
  });
});

describe('persisted-state repair', () => {
  it('upgrades legacy kind-less tabs to file tabs and drops junk', () => {
    localStorage.setItem(
      'scream-file-tabs',
      JSON.stringify({
        tabs: [
          { id: '/old/a.ts', label: 'a.ts', filePath: '/old/a.ts' }, // legacy, no kind
          { id: 'ghost', label: 'x' }, // no kind / no filePath → junk
          { id: 'dock:git', kind: 'git', label: 'Git' },
        ],
        activeTabId: 'dock:git',
        panelOpen: true,
      }),
    );
    // Re-import to run the normalisation path with the fixture in place.
    vi.resetModules();
    return import('../../src/web/frontend/src/utils/fileTabState').then((mod) => {
      expect(mod.dockPanel.tabs.map((t) => t.kind)).toEqual(['file', 'git']);
      expect(mod.dockPanel.activeTabId).toBe('dock:git');
      expect(mod.dockPanel.panelOpen).toBe(true);
      localStorage.removeItem('scream-file-tabs');
      // Restore the pristine singleton for the tests that follow.
      mod.dockPanel.tabs = [];
      mod.dockPanel.activeTabId = null;
      mod.dockPanel.panelOpen = false;
    });
  });
});
