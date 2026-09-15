import { reactive } from 'vue';
import {
  dockTabType,
  isRegisteredDockTabKind,
  sessionDockTabId,
  type DockTabKind,
  type SessionDockKind,
} from './dockTabTypes';

/* ── Types ────────────────────────────────────────────────────────────────── */

export type FileViewerDisplayMode = 'source' | 'preview' | 'diff';

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
}

/** A multi-instance file tab: one per opened path. */
export interface FileTab {
  id: string;
  kind: 'file';
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: FileViewerDisplayMode;
  viewerState?: FileViewerState;
  viewerRevision?: number;
}

/** A session-level dock tab (git / todo / goal / run / detail / like). */
export interface SessionDockTab {
  id: string;
  kind: SessionDockKind;
  label: string;
}

export type DockTab = FileTab | SessionDockTab;

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? 'source';
}

export const tabKind = (tab: DockTab): DockTabKind => tab.kind;

/* ── Pure tab-list operations ─────────────────────────────────────────────── */

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: 'diff';
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: DockTab[], input: OpenFileTabInput): DockTab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      kind: 'file',
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

  if (existing.kind !== 'file') return tabs;

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId || tab.kind !== 'file') return tab;
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

/** Add (or reuse) a singleton session-level tab. Keeps insertion order. */
export function openSessionTab(tabs: DockTab[], kind: SessionDockKind): DockTab[] {
  const id = sessionDockTabId(kind);
  if (tabs.some((tab) => tab.id === id)) return tabs;
  return [...tabs, { id, kind, label: dockTabType(kind).label }];
}

export function saveFileViewerState(
  tabs: DockTab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): DockTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId && tab.kind === 'file');
  if (index === -1) return tabs;
  const current = tabs[index] as FileTab;
  if ((current.viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...current, viewerState };
  return next;
}

/* ── Module-level state machine (tabs survive session switches) ──────────── */

const STORAGE_KEY = 'scream-file-tabs';

interface DockPanelState {
  tabs: DockTab[];
  activeTabId: string | null;
  panelOpen: boolean;
}

function loadPersisted(): Partial<DockPanelState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<DockPanelState>) : {};
  } catch {
    return {};
  }
}

function persist(state: DockPanelState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full / unavailable — tab layout is best-effort.
  }
}

/** Repair a persisted entry: legacy rows predate `kind` and are files;
 *  session rows must carry a registered kind. Drops anything malformed. */
function normalizeTab(raw: Partial<DockTab> & Record<string, unknown>): DockTab | null {
  if (typeof raw.id !== 'string' || typeof raw.label !== 'string') return null;
  if (raw.kind === undefined) {
    return typeof raw.filePath === 'string'
      ? ({ ...raw, kind: 'file' } as unknown as FileTab)
      : null;
  }
  if (!isRegisteredDockTabKind(raw.kind)) return null;
  if (raw.kind === 'file') {
    if (typeof raw.filePath !== 'string') return null;
    return raw as unknown as FileTab;
  }
  return { id: raw.id, kind: raw.kind, label: raw.label };
}

const persisted = loadPersisted();
const persistedTabs = (Array.isArray(persisted.tabs) ? persisted.tabs : [])
  .map((tab) => normalizeTab(tab as never))
  .filter((tab): tab is DockTab => tab !== null);
const persistedActive = typeof persisted.activeTabId === 'string' ? persisted.activeTabId : null;

/** Single source of truth for the right dock; any component may import. */
export const dockPanel = reactive<DockPanelState>({
  tabs: persistedTabs,
  // A persisted activeTabId may reference a tab dropped by an older format;
  // fall back to the last tab so the dock never renders empty while content
  // is available.
  activeTabId: persistedTabs.some((tab) => tab.id === persistedActive)
    ? persistedActive
    : (persistedTabs.at(-1)?.id ?? null),
  panelOpen: persisted.panelOpen === true,
});

function syncActive(): void {
  if (dockPanel.tabs.length === 0) {
    dockPanel.activeTabId = null;
    return;
  }
  if (!dockPanel.tabs.some((tab) => tab.id === dockPanel.activeTabId)) {
    dockPanel.activeTabId = dockPanel.tabs.at(-1)?.id ?? null;
  }
}

/** Open (or focus) a file tab; expands the dock. Returns the tab id. */
export function openFileInPanel(
  filePath: string,
  options: { modeHint?: 'diff'; sessionId?: string | null; label?: string } = {},
): string {
  const fileName = filePath.split('/').pop() || filePath;
  const tabId = filePath;
  dockPanel.tabs = openFileTab(dockPanel.tabs, {
    fileName: options.label ?? fileName,
    filePath,
    modeHint: options.modeHint,
    sourceSessionId: options.sessionId ?? null,
    tabId,
  });
  dockPanel.activeTabId = tabId;
  dockPanel.panelOpen = true;
  persist(dockPanel);
  return tabId;
}

/** Open (or activate) the singleton tab of a session-level kind. */
export function openDockTab(kind: SessionDockKind): string {
  const id = sessionDockTabId(kind);
  dockPanel.tabs = openSessionTab(dockPanel.tabs, kind);
  dockPanel.activeTabId = id;
  dockPanel.panelOpen = true;
  persist(dockPanel);
  return id;
}

export function selectDockTab(tabId: string): void {
  if (!dockPanel.tabs.some((tab) => tab.id === tabId)) return;
  dockPanel.activeTabId = tabId;
  persist(dockPanel);
}

/** Close a tab, activate a neighbor, and collapse the dock when empty. */
export function closeDockTab(tabId: string): void {
  const index = dockPanel.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  dockPanel.tabs = dockPanel.tabs.filter((tab) => tab.id !== tabId);
  if (dockPanel.activeTabId === tabId) {
    const neighbor = dockPanel.tabs[index] ?? dockPanel.tabs[index - 1] ?? null;
    dockPanel.activeTabId = neighbor ? neighbor.id : null;
  }
  if (dockPanel.tabs.length === 0) {
    dockPanel.panelOpen = false;
    dockPanel.activeTabId = null;
  }
  persist(dockPanel);
}

export function setDockOpen(open: boolean): void {
  dockPanel.panelOpen = open;
  if (open) syncActive();
  persist(dockPanel);
}

export function toggleDock(): void {
  setDockOpen(!dockPanel.panelOpen);
}

export const activeDockTab = (): DockTab | undefined =>
  dockPanel.tabs.find((tab) => tab.id === dockPanel.activeTabId);

export const activeFileTab = (): FileTab | undefined => {
  const tab = activeDockTab();
  return tab && tab.kind === 'file' ? tab : undefined;
};
