import { reactive } from 'vue';

/* ── Types (mirrors the reference Tab/FileViewerState shapes) ────────────── */

export type FileViewerDisplayMode = 'source' | 'preview' | 'diff';

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
}

export interface FileTab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: FileViewerDisplayMode;
  viewerState?: FileViewerState;
  viewerRevision?: number;
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? 'source';
}

/* ── Pure tab-list operations (ported 1:1) ───────────────────────────────── */

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: 'diff';
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: FileTab[], input: OpenFileTabInput): FileTab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        wrapLines: false,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      viewerRevision: 0,
    }];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: FileTab = { ...tab };
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        wrapLines: tab.viewerState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
      };
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

export function saveFileViewerState(
  tabs: FileTab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): FileTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}

/* ── Module-level state machine (tabs survive session switches) ──────────── */

const STORAGE_KEY = 'scream-file-tabs';

interface FilePanelState {
  tabs: FileTab[];
  activeTabId: string | null;
  panelOpen: boolean;
}

function loadPersisted(): Partial<FilePanelState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<FilePanelState>) : {};
  } catch {
    return {};
  }
}

function persist(state: FilePanelState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full / unavailable — tab layout is best-effort.
  }
}

const persisted = loadPersisted();
const persistedTabs = Array.isArray(persisted.tabs) ? persisted.tabs : [];
const persistedActive = typeof persisted.activeTabId === 'string' ? persisted.activeTabId : null;

/** Single source of truth for the right file panel; any component may import. */
export const filePanel = reactive<FilePanelState>({
  tabs: persistedTabs,
  // Persisted activeTabId may reference a tab dropped by an older version's
  // format; fall back to the last tab so the panel never renders empty state
  // with content available.
  activeTabId: persistedTabs.some((tab) => tab.id === persistedActive)
    ? persistedActive
    : (persistedTabs.at(-1)?.id ?? null),
  panelOpen: persisted.panelOpen === true,
});

function syncActive(): void {
  if (filePanel.tabs.length === 0) {
    filePanel.activeTabId = null;
    return;
  }
  if (!filePanel.tabs.some((tab) => tab.id === filePanel.activeTabId)) {
    filePanel.activeTabId = filePanel.tabs.at(-1)?.id ?? null;
  }
}

/** Open (or focus) a file tab; expands the panel. Returns the tab id. */
export function openFileInPanel(
  filePath: string,
  options: { modeHint?: 'diff'; sessionId?: string | null; label?: string } = {},
): string {
  const fileName = filePath.split('/').pop() || filePath;
  const tabId = filePath;
  filePanel.tabs = openFileTab(filePanel.tabs, {
    fileName: options.label ?? fileName,
    filePath,
    modeHint: options.modeHint,
    sourceSessionId: options.sessionId ?? null,
    tabId,
  });
  filePanel.activeTabId = tabId;
  filePanel.panelOpen = true;
  persist(filePanel);
  return tabId;
}

export function selectFileTab(tabId: string): void {
  if (!filePanel.tabs.some((tab) => tab.id === tabId)) return;
  filePanel.activeTabId = tabId;
  persist(filePanel);
}

/** Close a tab, activate a neighbor, and collapse the panel when empty. */
export function closeFileTab(tabId: string): void {
  const index = filePanel.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  filePanel.tabs = filePanel.tabs.filter((tab) => tab.id !== tabId);
  if (filePanel.activeTabId === tabId) {
    const neighbor = filePanel.tabs[index] ?? filePanel.tabs[index - 1] ?? null;
    filePanel.activeTabId = neighbor ? neighbor.id : null;
  }
  if (filePanel.tabs.length === 0) {
    filePanel.panelOpen = false;
    filePanel.activeTabId = null;
  }
  persist(filePanel);
}

export function setFilePanelOpen(open: boolean): void {
  filePanel.panelOpen = open;
  if (open) syncActive();
  persist(filePanel);
}

export function toggleFilePanel(): void {
  setFilePanelOpen(!filePanel.panelOpen);
}

export const activeFileTab = (): FileTab | undefined =>
  filePanel.tabs.find((tab) => tab.id === filePanel.activeTabId);
