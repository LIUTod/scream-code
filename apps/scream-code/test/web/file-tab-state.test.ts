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
  activeFileTab,
  closeFileTab,
  filePanel,
  openFileInPanel,
  openFileTab,
  resolveInitialFileDisplayMode,
  saveFileViewerState,
  selectFileTab,
  setFilePanelOpen,
} from '../../src/web/frontend/src/utils/fileTabState';

function reset(): void {
  filePanel.tabs = [];
  filePanel.activeTabId = null;
  filePanel.panelOpen = false;
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
  it('opens a new tab with viewerRevision 0', () => {
    const tabs = openFileTab([], {
      fileName: 'main.ts',
      filePath: '/src/main.ts',
      tabId: '/src/main.ts',
      sourceSessionId: null,
    });
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe('main.ts');
    expect(tabs[0].viewerRevision).toBe(0);
    expect(tabs[0].viewerState).toBeUndefined();
  });

  it('dedupes re-open without mode hint', () => {
    const once = openFileTab([], { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    const twice = openFileTab(once, { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    expect(twice).toBe(once); // unchanged identity
  });

  it('applies a diff mode hint with a revision bump', () => {
    const once = openFileTab([], { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    const hinted = openFileTab(once, { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts', modeHint: 'diff' });
    expect(hinted[0].initialDisplayMode).toBe('diff');
    expect(hinted[0].viewerRevision).toBe(1);
    expect(hinted[0].viewerState?.displayMode).toBe('diff');
  });

  it('saveFileViewerState rejects a stale revision', () => {
    const tabs = openFileTab([], { fileName: 'a.ts', filePath: '/a.ts', tabId: '/a.ts' });
    const stale = saveFileViewerState(tabs, '/a.ts', 7, { displayMode: 'source', wrapLines: true, scrollTop: 10, scrollLeft: 0 });
    expect(stale).toBe(tabs);
    const fresh = saveFileViewerState(tabs, '/a.ts', 0, { displayMode: 'source', wrapLines: true, scrollTop: 10, scrollLeft: 0 });
    expect(fresh[0].viewerState?.wrapLines).toBe(true);
  });

  it('resolveInitialFileDisplayMode prefers saved state, then hint, then source', () => {
    expect(resolveInitialFileDisplayMode(undefined, undefined)).toBe('source');
    expect(resolveInitialFileDisplayMode(undefined, 'diff')).toBe('diff');
    expect(resolveInitialFileDisplayMode({ displayMode: 'preview', wrapLines: false, scrollTop: 0, scrollLeft: 0 }, 'diff')).toBe('preview');
  });
});

describe('file panel state machine', () => {
  it('opens a file: adds tab, activates, expands panel', () => {
    openFileInPanel('/src/a.ts');
    expect(filePanel.tabs).toHaveLength(1);
    expect(filePanel.activeTabId).toBe('/src/a.ts');
    expect(filePanel.panelOpen).toBe(true);
  });

  it('opens multiple files and switches focus', () => {
    openFileInPanel('/src/a.ts');
    openFileInPanel('/src/b.ts');
    selectFileTab('/src/a.ts');
    expect(filePanel.activeTabId).toBe('/src/a.ts');
    expect(activeFileTab()?.filePath).toBe('/src/a.ts');
  });

  it('closing the active tab activates the neighbor', () => {
    openFileInPanel('/src/a.ts');
    openFileInPanel('/src/b.ts');
    closeFileTab('/src/b.ts');
    expect(filePanel.activeTabId).toBe('/src/a.ts');
    expect(filePanel.panelOpen).toBe(true);
  });

  it('closing the last tab collapses the panel', () => {
    openFileInPanel('/src/a.ts');
    closeFileTab('/src/a.ts');
    expect(filePanel.tabs).toHaveLength(0);
    expect(filePanel.activeTabId).toBeNull();
    expect(filePanel.panelOpen).toBe(false);
  });

  it('persists state across operations', () => {
    openFileInPanel('/src/a.ts');
    const raw = localStorage.getItem('scream-file-tabs');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { tabs: unknown[]; panelOpen: boolean };
    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.panelOpen).toBe(true);
  });

  it('setFilePanelOpen keeps an existing tab active when reopening', () => {
    openFileInPanel('/src/a.ts');
    setFilePanelOpen(false);
    setFilePanelOpen(true);
    expect(filePanel.activeTabId).toBe('/src/a.ts');
  });
});
