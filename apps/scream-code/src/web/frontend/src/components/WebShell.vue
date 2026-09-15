<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { useScreamWebClient } from '../composables/useScreamWebClient';
import { useSlashCommands } from '../composables/useSlashCommands';
import { usePanelResize } from '../composables/usePanelResize';
import type { WorkspaceMode } from './ModeSwitch.vue';
import type { ShellView } from './Sidebar.vue';
import {
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_COMPACT_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  SPLIT_PANEL_MIN_WIDTH,
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
} from '../utils/panelLayout';
import {
  activeDockTab,
  dockPanel,
  openFileInPanel,
  setDockOpen,
} from '../utils/fileTabState';
import type { SessionDockKind } from '../utils/dockTabTypes';
import { readStoredString, writeStoredString } from '../utils/storage';
import { useToast } from '../composables/useToast';
import { closeSettingsModal } from '../composables/useSettingsModal';
import { useWorkspacePreference } from '../composables/useWorkspacePreference';
import ConversationView from './ConversationView.vue';
import FileViewer from './FileViewer.vue';
import GitPanel from './GitPanel.vue';
import GoalPanel from './GoalPanel.vue';
import NewSessionModal from './NewSessionModal.vue';
import InfoPanel from './InfoPanel.vue';
import LikePanel from './LikePanel.vue';
import RunStatusPanel from './RunStatusPanel.vue';
import SessionDetailView from './SessionDetailView.vue';
import SettingsModal from './SettingsModal.vue';
import SettingsView from './SettingsView.vue';
import Sidebar from './Sidebar.vue';
import SkillsView from './SkillsView.vue';
import SvgIcon from './ui/SvgIcon.vue';
import TabBar from './TabBar.vue';
import TodoPanel from './TodoPanel.vue';
import WorkspaceHome from './WorkspaceHome.vue';

const client = useScreamWebClient();
const { showToast } = useToast();
const {
  connectionStatus,
  status,
  isBusy,
  sessions,
  currentSessionId,
  workDir,
  gitStatus,
  models,
  like,
  sendPrompt,
  sendCommand,
  appendSystemMessage,
  createSession,
  switchSession,
  deleteSession,
  switchModel,
  switchThinking,
  fetchLike,
  fetchGitStatus,
  abort,
} = client;

const view = ref<ShellView>('home');
const mobileSidebarOpen = ref(false);
const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);

/**
 * WS `connected` is reached asynchronously after createSession →
 * switchSession → connect(); sending before that drops the prompt.
 */
function waitForConnected(timeoutMs = 8000): Promise<boolean> {
  if (connectionStatus.value === 'connected') return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (connectionStatus.value === 'connected') {
        window.clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 80);
  });
}

/**
 * Lazy session creation: "new chat" no longer POSTs /sessions immediately — a
 * stray click would otherwise leave a zero-message session in the list. It just
 * returns to the home hero; the session is really created when the first send /
 * try-it actually lands.
 *
 * Why not "clear currentSessionId and keep the WS connected with no session": a
 * WS connection without a sessionId is bound by the server to the first active
 * session (the firstActive fallback in server.ts) and server_hello writes the old
 * id back unconditionally; clearing the id alone silently re-binds when the tab
 * returns to the foreground (visibilitychange → connect()), so the next send
 * lands in the old session anyway. The existing binding is therefore left
 * untouched — the "new" entry now opens a confirm dialog and creates the session
 * right away, so no implicit pending-session flag is needed.
 */

function onNavigate(id: ShellView) {
  if (id === 'chat') {
    // A bound session goes straight to chat; nothing to show (cold start) falls back home.
    view.value = currentSessionId.value ? 'chat' : 'home';
  } else {
    view.value = id;
  }
  mobileSidebarOpen.value = false;
}

function onCreateSession() {
  mobileSidebarOpen.value = false;
  // ⌘N would stack the new-session dialog on top of the settings modal: with two
  // modals mounted one Escape is consumed by each handler and looks like a single
  // keypress closing both. Close settings first — with only one modal mounted, Esc
  // has an unambiguous owner.
  closeSettingsModal();
  // The entry point is the confirm dialog: pick workspace and model, then create.
  // Returning home silently made the button feel dead to users.
  newSessionOpen.value = true;
}

/** Session path once the dialog is confirmed: create the session (switch view as
 * soon as REST succeeds, the connection catches up asynchronously) → switch model
 * if needed → already in the chat view. */
async function onNewSessionConfirm(payload: {
  workDir: string | null;
  model: string | null;
}): Promise<void> {
  newSessionOpen.value = false;
  setPreferredWorkDir(payload.workDir);
  const before = currentSessionId.value;
  // The status model may not be backfilled yet (switchSession resets status), so it
  // cannot gate "does this need a switch": switch whenever a model was picked and
  // differs from the current one. switchModel is idempotent and skips the POST for
  // the same model.
  const pendingModel =
    payload.model && payload.model !== status.value.model ? payload.model : null;
  await createSession(payload.workDir ?? undefined, () => {
    view.value = 'chat';
  });
  // On failure currentSessionId is unchanged (the error was toasted) — stay put.
  if (!currentSessionId.value || currentSessionId.value === before) return;
  if (pendingModel) void switchModel(pendingModel);
  view.value = 'chat';
}

/* ── workspace popover data source ────────────────────────────────────────────
 * "Recent" is derived from the session list (already createdAt-descending:
 * de-duplicated, first 6 kept). A workspace the user picked explicitly becomes the
 * workDir of the next createSession call. */
const { preferredWorkDir, serverWorkDir, setPreferredWorkDir } = useWorkspacePreference();
const newSessionOpen = ref(false);
const recentWorkDirs = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of sessions.value) {
    const dir = item.workDir;
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
    if (out.length >= 6) break;
  }
  return out;
});

/* ── Skills center try-it to composer (L2 wiring) ─────────────────────────────
 * Composer and ConversationView are conditionally rendered siblings: while the
 * skills center is open the composer is not mounted, so navigate first, wait for
 * the target view to mount, then call the insertDraft it forwards.
 * Without a session the draft lands in the Composer embedded in WorkspaceHome
 * (onWorkspaceSend consumes it later, which is when the session is really
 * created); with a session the chat composer is used. false = delivery failed and
 * the caller (SkillsView) falls back to the clipboard. */
const conversationRef = ref<InstanceType<typeof ConversationView> | null>(null);
const workspaceHomeRef = ref<InstanceType<typeof WorkspaceHome> | null>(null);

async function onSkillDraft(snippet: string): Promise<boolean> {
  mobileSidebarOpen.value = false;
  const toHome = !currentSessionId.value;
  view.value = toHome ? 'home' : 'chat';
  // Let the WorkspaceHome / ConversationView Composer mount and restore its draft
  // before injecting, so a session-switch draft readback cannot overwrite it.
  await nextTick();
  await nextTick();
  const injected = toHome
    ? (workspaceHomeRef.value?.insertDraft(snippet) ?? false)
    : (conversationRef.value?.insertDraft(snippet, { activate: true }) ?? false);
  if (injected) showToast(`已把 ${snippet.trim()} 放进输入框，补参数后回车`, 'success');
  return injected;
}

/**
 * Fallback that puts the text back into the home Composer: it clears its input
 * right after emitting send, so without a restore the typed text would evaporate
 * on the "creation failed / gave up while offline / duplicate send blocked by the
 * guard" paths (L3).
 */
function restoreHomeInput(text: string) {
  void nextTick(() => workspaceHomeRef.value?.insertDraft(text));
}

/**
 * Home-send in-flight flag: only one "create session + first message" at a time.
 *
 * Without it a double click / second Enter creates one session each (two
 * zero-message sessions) and the first message can land in the later one. The
 * guard only covers the in-flight window: once it closes (sent, or restored after
 * a failure) the normal path applies again.
 */
let workspaceSendInFlight = false;

async function onWorkspaceSend(text: string, mode: WorkspaceMode) {
  mobileSidebarOpen.value = false;
  // The guard must win first: $emit dispatches synchronously, so one step later a
  // second call would slip in.
  if (workspaceSendInFlight) {
    restoreHomeInput(text);
    return;
  }
  workspaceSendInFlight = true;
  try {
    // The home composer is the landing entry for a new conversation: sending here
    // always creates a session, whatever the current binding is. The binding is
    // kept on purpose (see the firstActive note above), so creating only when
    // "unbound" would pour "back to new chat → type → send" into the old session.
    // On failure the binding is unchanged (createSession toasts) — hand the text
    // back.
    const boundId = currentSessionId.value;
    await createSession(preferredWorkDir.value ?? undefined);
    if (currentSessionId.value === boundId) {
      restoreHomeInput(text);
      return;
    }
    const ready = await waitForConnected();
    // Only switch away from the home view once the transport is confirmed, so an
    // offline click keeps the input and the selected mode instead of dropping both.
    if (!ready) {
      restoreHomeInput(text);
      return;
    }
    view.value = 'chat';
    if (mode === 'goal') {
      try {
        await client.createGoal({ objective: text, budgets: [] });
      } catch (error) {
        appendSystemMessage(`Goal 创建失败：${errorMessageOf(error)}。已保留对话模式，可重新发送。`);
        sendPrompt(text);
        return;
      }
    } else {
      sendPrompt(text);
    }
  } finally {
    workspaceSendInFlight = false;
  }
}
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function onSwitchSession(id: string) {
  mobileSidebarOpen.value = false;
  view.value = 'chat';
  switchSession(id);
}

/** Sidebar file tree → open the file in the right panel. */
function onOpenFile(path: string) {
  openFileInPanel(path);
}

/** Inline rename in the sidebar → /title command (G5.2).
 *  /title targets the currently active WS session, so renaming a session that
 *  is not active would silently rename the wrong one. Refuse with a hint. */
function onRenameSession(id: string, title: string) {
  if (id !== currentSessionId.value) {
    showToast('请先点击该会话，再双击重命名。', 'warning');
    return;
  }
  void sendCommand('title', title);
}

/** /status & /usage from the home view open the same info dialog as the
 *  conversation view (shared dispatch in useSlashCommands). */
const infoVisible = ref(false);
const infoMode = ref<'status' | 'usage'>('status');
function showInfo(mode: 'status' | 'usage') {
  void client.fetchSnapshot();
  infoMode.value = mode;
  infoVisible.value = true;
}

const { onCommand } = useSlashCommands({
  sendCommand,
  clearMessages: client.clearMessages,
  appendSystemMessage,
  // Home view: session commands need a session first — always create one there,
  // otherwise only when nothing is bound.
  ensureSession: async () => {
    if (!currentSessionId.value) await createSession(preferredWorkDir.value ?? undefined);
  },
  onNew: onCreateSession,
  showInfo,
  currentModel: () => status.value.model,
});

const SIDEBAR_STORAGE_KEY = 'scream-sidebar-collapsed';
const sidebarCollapsed = ref(readStoredString(SIDEBAR_STORAGE_KEY) === '1');

/* ── Narrow viewports (<1024px): matchMedia drives the rail, and a manual
     expand shows the sidebar as an overlay above the canvas ──────────────── */
const COMPACT_NAV_QUERY = `(max-width: ${SIDEBAR_COMPACT_MAX_WIDTH - 1}px)`;
const compactQuery = globalThis.window?.matchMedia?.(COMPACT_NAV_QUERY);
const isCompactNav = ref(compactQuery?.matches ?? false);
function onCompactNavChange(e: MediaQueryListEvent) {
  isCompactNav.value = e.matches;
}

/** Effective rail state: compact forces collapse; storage drives desktop. */
const effectiveCollapsed = computed(() => isCompactNav.value || sidebarCollapsed.value);

function toggleSidebarCollapse() {
  if (isCompactNav.value) {
    // Rail → overlay above the canvas; the grid track never widens here.
    mobileSidebarOpen.value = !mobileSidebarOpen.value;
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
  writeStoredString(SIDEBAR_STORAGE_KEY, sidebarCollapsed.value ? '1' : '0');
}

/* ── Viewport width drives the split breakpoint and the clamp interlocks ──── */
const viewportWidth = ref(window.innerWidth);
const isSplitMode = computed(() => viewportWidth.value >= SPLIT_PANEL_MIN_WIDTH);

function onWindowResize() {
  viewportWidth.value = window.innerWidth;
}

/* ── Draggable sidebar width (264–420px, persisted, double-click resets) ─── */
const sidebarResize = usePanelResize({
  storageKey: 'scream-sidebar-width',
  minWidth: SIDEBAR_MIN_WIDTH,
  // Interlock: an open right dock shrinks the sidebar's headroom so the chat
  // column keeps its minimum width (400px desktop / 320px compact).
  maxWidth: () =>
    getSidebarMaxWidth({
      viewportWidth: viewportWidth.value,
      rightPanelOpen: dockPanel.panelOpen,
      rightPanelWidth: effectiveRightPanelWidth.value,
    }),
  defaultWidth: SIDEBAR_DEFAULT_WIDTH,
  side: 'left',
  canDrag: () => !effectiveCollapsed.value,
  acceptStoredWidth: (w) => w <= SIDEBAR_MAX_WIDTH,
});
const sidebarWidth = sidebarResize.width;
const resizing = sidebarResize.resizing;

/* ── Right dock: width clamp interlocked with sidebar and viewport ───────── */
const rightPanelMaxWidth = computed(() =>
  getRightPanelMaxWidth({
    viewportWidth: viewportWidth.value,
    // The collapsed/compact rail still eats viewport.
    sidebarOpen: !sidebarCollapsed.value,
    sidebarWidth: effectiveCollapsed.value ? SIDEBAR_RAIL_WIDTH : sidebarWidth.value,
  }),
);
const rightPanelResize = usePanelResize({
  storageKey: 'scream-right-panel-width',
  minWidth: RIGHT_PANEL_MIN_WIDTH,
  maxWidth: () => rightPanelMaxWidth.value,
  defaultWidth: () => getDefaultRightPanelWidth(viewportWidth.value),
  side: 'right',
});
const rightResizing = rightPanelResize.resizing;

/** Effective panel width after the sidebar/viewport interlock. */
const effectiveRightPanelWidth = rightPanelResize.effectiveWidth;

/** Full-viewport mode (dock chrome toggle); never persists. */
const dockMaximized = ref(false);

function collapseRightDock() {
  setDockOpen(false);
}

// Crossing the split breakpoint mid-drag unmounts the handle (v-if), so the
// pointerup never fires — release the drag state when the mode flips.
watch(isSplitMode, () => {
  if (rightResizing.value) rightPanelResize.release();
});
// Same for the rail interlock, plus: leaving the compact band closes any
// overlay sidebar the user had opened from the rail.
watch(effectiveCollapsed, () => {
  if (effectiveCollapsed.value && resizing.value) sidebarResize.release();
});
watch(isCompactNav, (compact) => {
  if (!compact) mobileSidebarOpen.value = false;
});
watch(() => dockPanel.panelOpen, (open) => {
  if (!open) dockMaximized.value = false;
});

const shellStyle = computed(() => ({
  // The two animatable grid tracks; the middle column stays minmax(0,1fr).
  '--sidebar-track': `${effectiveCollapsed.value ? SIDEBAR_RAIL_WIDTH : sidebarWidth.value}px`,
  // Sidebar.vue sizes itself from --sidebar-width; keep it in sync with the
  // dragged track so the panel never detaches from its column.
  '--sidebar-width': `${sidebarWidth.value}px`,
  '--dock-track': `${dockPanel.panelOpen && isSplitMode.value && !dockMaximized.value ? effectiveRightPanelWidth.value : 0}px`,
}));

/* ── Dock tab rendering (registry-bound) ─────────────────────────────────── */
const dockPaneComponents: Record<SessionDockKind, Component> = {
  detail: SessionDetailView,
  run: RunStatusPanel,
  git: GitPanel,
  todo: TodoPanel,
  goal: GoalPanel,
  like: LikePanel,
};

const sessionTabs = computed(() => dockPanel.tabs.filter((t) => t.kind !== 'file'));
const activeTabKind = computed(() => activeDockTab()?.kind ?? 'file');
/** The file pane also covers the empty dock (FileViewer shows its hint). */
const filePaneVisible = computed(() => activeTabKind.value === 'file');

/** A diff picked from the standalone Git tab opens as a file tab; inside the
 *  detail tab the same action keeps its inline preview (SessionDetailView). */
function onDockGitDiff(file: { path: string; display: string }) {
  openFileInPanel(file.path, { modeHint: 'diff', label: file.display });
}

const gitPaneListeners = { refresh: () => fetchGitStatus(), diff: onDockGitDiff };

// Reactive reads inside a render function keep the panes in sync with the
// client state, mirroring how ConversationView fed the retired drawer.
function dockPaneProps(kind: SessionDockKind): Record<string, unknown> {
  switch (kind) {
    case 'detail': return { client };
    case 'run': return { status: client.status.value, busy: client.isBusy.value, connectionStatus: client.connectionStatus.value };
    case 'git': return { gitStatus: client.gitStatus.value };
    case 'todo': return { todos: client.todos.value };
    case 'like': return { like: client.like.value, updateLike: client.updateLike };
    case 'goal': return {
      goal: client.goal.value,
      sessionId: client.sessionId.value,
      connectionStatus: client.connectionStatus.value,
      busy: client.isBusy.value,
      archived: client.isArchived.value,
      pending: client.goalRequestPending.value,
      error: client.goalRequestError.value,
      refineGoal: client.refineGoal,
      createGoal: client.createGoal,
      updateGoal: client.updateGoal,
      pauseGoal: client.pauseGoal,
      resumeGoal: client.resumeGoal,
      cancelGoal: client.cancelGoal,
    };
  }
}

function dockPaneListeners(kind: SessionDockKind): Record<string, unknown> {
  return kind === 'git' ? gitPaneListeners : {};
}

/** Workspace mode lives in the shell (and localStorage) rather than inside the
 *  home view, which unmounts when a conversation opens. */
const MODE_STORAGE_KEY = 'scream-workspace-mode';
const workspaceMode = ref<WorkspaceMode>(readStoredString(MODE_STORAGE_KEY) === 'goal' ? 'goal' : 'chat');
function setWorkspaceMode(next: WorkspaceMode) {
  workspaceMode.value = next;
  writeStoredString(MODE_STORAGE_KEY, next);
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    // ⌘K from the collapsed rail must first widen the sidebar (or raise the
    // compact overlay), then focus.
    if (effectiveCollapsed.value && !mobileSidebarOpen.value) toggleSidebarCollapse();
    void nextTick(() => sidebarRef.value?.focusSearch?.());
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    onCreateSession();
  } else if (e.key === 'Escape' && isBusy.value) {
    // Global Esc stops the running turn — unless the user is typing in a
    // field (composer / dialogs handle their own Escape semantics).
    const target = e.target as HTMLElement | null;
    const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
    if (!inField) {
      e.preventDefault();
      abort();
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('resize', onWindowResize);
  compactQuery?.addEventListener?.('change', onCompactNavChange);
  void fetchLike();
  void fetchGitStatus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  window.removeEventListener('resize', onWindowResize);
  compactQuery?.removeEventListener?.('change', onCompactNavChange);
});
</script>

<template>
  <div
    class="shell"
    :class="{
      'sidebar-collapsed': effectiveCollapsed,
      resizing: resizing || rightResizing,
      'right-panel-open': dockPanel.panelOpen && isSplitMode,
      'dock-maximized': dockPanel.panelOpen && dockMaximized,
    }"
    :style="shellStyle"
  >
    <Sidebar
      ref="sidebarRef"
      :view="view"
      :sessions="sessions"
      :current-session-id="currentSessionId"
      :work-dir="workDir"
      :git-status="gitStatus"
      :refresh-git="fetchGitStatus"
      :collapsed="effectiveCollapsed"
      @navigate="onNavigate"
      @switch-session="onSwitchSession"
      @delete-session="deleteSession"
      @create-session="onCreateSession"
      @toggle-collapse="toggleSidebarCollapse"
      @open-file="onOpenFile"
      @rename-session="onRenameSession"
    />

    <div
      v-if="!effectiveCollapsed"
      class="panel-resize-handle panel-resize-handle--left"
      :class="{ resizing }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      :aria-valuenow="sidebarWidth"
      :aria-valuemin="SIDEBAR_MIN_WIDTH"
      :aria-valuemax="SIDEBAR_MAX_WIDTH"
      tabindex="0"
      title="拖拽调整宽度 · 双击复位"
      @pointerdown="sidebarResize.onPointerDown"
      @pointermove="sidebarResize.onPointerMove"
      @pointerup="sidebarResize.onPointerUp"
      @pointercancel="sidebarResize.onPointerUp"
      @dblclick="sidebarResize.reset"
      @keydown="sidebarResize.onKeydown"
    />

    <div v-if="mobileSidebarOpen" class="sidebar-backdrop" aria-hidden="true" @click="mobileSidebarOpen = false" />
    <div v-if="mobileSidebarOpen" class="sidebar-mobile">
      <Sidebar
        :view="view"
        :sessions="sessions"
        :current-session-id="currentSessionId"
        :work-dir="workDir"
        :git-status="gitStatus"
        :refresh-git="fetchGitStatus"
        :show-collapse-toggle="false"
        @navigate="onNavigate"
        @switch-session="onSwitchSession"
        @delete-session="deleteSession"
        @create-session="onCreateSession"
        @open-file="onOpenFile"
        @rename-session="onRenameSession"
      />
    </div>

    <main class="canvas">
      <header class="topbar mobile-only">
        <div class="topbar-left">
          <button
            class="topbar-icon mobile-menu"
            title="菜单"
            aria-label="打开菜单"
            @click="mobileSidebarOpen = true"
          >
            <SvgIcon name="menu" :size="20" />
          </button>
          <span v-if="isBusy" class="topbar-running" title="Agent 运行中">
            <span class="running-dot" aria-hidden="true" />
            <span class="running-text">运行中</span>
          </span>
        </div>
      </header>

      <div class="canvas-body">
        <WorkspaceHome
          v-if="view === 'home'"
          ref="workspaceHomeRef"
          :models="models"
          :status="status"
          :busy="isBusy"
          :mode="workspaceMode"
          :recent-work-dirs="recentWorkDirs"
          @update:mode="setWorkspaceMode"
          @send="onWorkspaceSend"
          @abort="abort"
          @command="onCommand"
          @switch-model="switchModel"
          @switch-thinking="switchThinking"
        />
        <ConversationView
          v-else-if="view === 'chat'"
          ref="conversationRef"
          :client="client"
          @home="view = 'home'"
        />
        <SkillsView v-else-if="view === 'skills'" :inject-draft="onSkillDraft" @create="onCreateSession" />
        <SettingsView
          v-else-if="view === 'settings'"
          :like="like"
          :client="client"
          @update-like="client.updateLike"
        />
      </div>
    </main>

    <!-- Right dock: full-screen overlay below the split breakpoint, third
         grid column above it. Backdrop only exists in overlay mode. -->
    <div
      v-if="dockPanel.panelOpen && !isSplitMode"
      class="right-panel-backdrop"
      aria-hidden="true"
      @click="collapseRightDock"
    />
    <div
      v-if="dockPanel.panelOpen && isSplitMode && !dockMaximized"
      class="panel-resize-handle panel-resize-handle--right"
      :class="{ resizing: rightResizing }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整右栏宽度"
      :aria-valuenow="effectiveRightPanelWidth"
      :aria-valuemin="RIGHT_PANEL_MIN_WIDTH"
      :aria-valuemax="rightPanelMaxWidth"
      tabindex="0"
      title="拖拽调整宽度 · 双击复位"
      @pointerdown="rightPanelResize.onPointerDown"
      @pointermove="rightPanelResize.onPointerMove"
      @pointerup="rightPanelResize.onPointerUp"
      @pointercancel="rightPanelResize.onPointerUp"
      @dblclick="rightPanelResize.reset"
      @keydown="rightPanelResize.onKeydown"
    />
    <aside
      v-if="dockPanel.panelOpen"
      class="right-panel"
      :class="{ overlay: !isSplitMode, maximized: dockMaximized }"
      aria-label="右栏"
    >
      <!-- The tab strip IS the dock header: file tabs plus the singleton
           session tabs, with the window chrome at its right end. -->
      <TabBar
        :maximized="dockMaximized"
        :show-maximize="isSplitMode"
        @update:maximized="dockMaximized = $event"
        @collapse="collapseRightDock"
      />
      <div class="right-panel-body">
        <div v-show="filePaneVisible" class="dock-pane dock-pane--file">
          <FileViewer :client="client" />
        </div>
        <!-- Session-level panes stay mounted once opened (v-show only): tab
             switching must not tear down in-flight panel state. -->
        <div
          v-for="tab in sessionTabs"
          :key="tab.id"
          v-show="tab.id === dockPanel.activeTabId"
          class="dock-pane"
          :class="`dock-pane--${tab.kind}`"
          :data-dock-tab="tab.kind"
        >
          <component
            :is="dockPaneComponents[tab.kind]"
            v-bind="dockPaneProps(tab.kind)"
            v-on="dockPaneListeners(tab.kind)"
          />
        </div>
      </div>
    </aside>

    <InfoPanel
      v-if="infoVisible"
      :mode="infoMode"
      :status="status"
      :session-id="currentSessionId"
      :work-dir="workDir"
      @close="infoVisible = false"
    />

    <!-- Settings modal host: lives in the shell rather than App.vue — it shares the
         view switch and the Sidebar entry, so as long as the shell is mounted that
         entry can always open the modal instead of falling back to the full-page
         settings view. It renders through Teleport, so the mount point does not
         affect stacking. -->
    <SettingsModal />
    <NewSessionModal
      :open="newSessionOpen"
      :models="models"
      :recent-work-dirs="recentWorkDirs"
      :default-dir="serverWorkDir ?? ''"
      :current-model="status.model ?? ''"
      @close="newSessionOpen = false"
      @confirm="onNewSessionConfirm"
    />
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  display: grid;
  /* Formal three-column contract: left track (expanded width or the 56px
     collapsed rail) | middle minmax(0,1fr), its 400px floor enforced by the
     JS clamp interlock | right dock track. The dock keeps a 0px track while
     closed, so show/hide stays one interpolable grid-template-columns
     transition instead of a track-count jump. */
  grid-template-columns: var(--sidebar-track, var(--sidebar-width)) minmax(0, 1fr) var(--dock-track, 0px);
  /* Collapsed rail morphs the grid track, not just the sidebar's own width,
     so the canvas breathes in step with the drawer. */
  transition: grid-template-columns var(--dur-slower) var(--ease-out);
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: transparent;
  color: var(--color-text);
}
/* While dragging, freeze every width transition so the handle tracks the
   pointer 1:1 instead of lagging behind it, and stop text selection. */
.shell.resizing {
  transition: none;
  user-select: none;
}
.shell.resizing :deep(.sidebar) {
  transition: none;
}

/* ── Panel resize handles: 12px hit area straddling the panel edge ────────── */
.panel-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 12px;
  cursor: col-resize;
  touch-action: none;
  z-index: calc(var(--z-dock) + 1);
}
.panel-resize-handle--left {
  left: calc(var(--sidebar-track, var(--sidebar-width)) - 6px);
}
.panel-resize-handle--right {
  right: calc(var(--dock-track, 0px) - 6px);
}
.panel-resize-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 5px;
  width: 2px;
  border-radius: var(--radius-full);
  background: transparent;
}
.panel-resize-handle:hover::after,
.panel-resize-handle.resizing::after,
.panel-resize-handle:focus-visible::after {
  background: var(--color-accent-bd);
}
.panel-resize-handle:focus-visible {
  outline: none;
}
@media (prefers-reduced-motion: reduce) {
  .shell { transition: none; }
}
@media (max-width: 767.98px) {
  /* The handle is v-if-guarded to split mode; this guards against leftovers. */
  .panel-resize-handle--right { display: none; }
}

.right-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--color-line);
  background: var(--color-surface);
}
/* The tab strip is the dock's header; panes are flat (no second frame). */
.right-panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.dock-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
/* Standalone session panels scroll inside their pane; spacing via tokens,
   no borders — the dock body is the only container. */
.dock-pane--run,
.dock-pane--git,
.dock-pane--todo,
.dock-pane--goal,
.dock-pane--like {
  overflow-y: auto;
  overscroll-behavior: contain;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-5);
}
/* The detail view owns its scroll container (stacked overview panels). */
.dock-pane--detail {
  overflow: hidden;
}
/* Full-viewport mode: the dock lifts out of the grid over the shell. */
.right-panel.maximized {
  position: fixed;
  inset: 0;
  width: auto;
  z-index: var(--z-overlay);
  border-left: none;
  box-shadow: var(--shadow-xl);
}

.right-panel-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  z-index: calc(var(--z-overlay) - 1);
  animation: backdrop-in var(--dur-slow) var(--ease-out);
}
/* Below the split breakpoint (<768px) the dock is a full-screen float —
   a wide enough canvas leaves no room for a side-by-side column anyway. */
.right-panel.overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  z-index: var(--z-overlay);
  box-shadow: var(--shadow-xl);
  --slide-from: 100%;
  animation: slide-in var(--dur-slower) var(--ease-spring);
}
@keyframes backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
/* Direction is a custom property so the right dock and the mobile sidebar
   share one keyframes definition. */
@keyframes slide-in {
  from { transform: translateX(var(--slide-from)); }
  to { transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
  .right-panel.overlay,
  .right-panel-backdrop { animation: none; }
}

.canvas {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* ── Top bar: mobile only (desktop chrome lives in the sidebar) ─────────── */
.topbar {
  display: none;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-4);
  flex-shrink: 0;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.topbar-icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.topbar-icon:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
.mobile-menu {
  display: grid;
}
.topbar-running {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.running-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
  flex-shrink: 0;
}
@media (prefers-reduced-motion: reduce) {
  .running-dot { animation: none; }
}

.canvas-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* Overlay sidebar: raised from the rail below 1024px (and by the topbar
   hamburger below 640px), so its styles are band-independent now. */
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  z-index: calc(var(--z-overlay) - 1);
  animation: backdrop-in var(--dur-slow) var(--ease-out);
}
.sidebar-mobile {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: var(--z-overlay);
}
.sidebar-mobile :deep(.sidebar) {
  display: flex !important;
  box-shadow: var(--shadow-xl);
  --slide-from: -100%;
  animation: slide-in var(--dur-slower) var(--ease-spring);
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-backdrop,
  .sidebar-mobile :deep(.sidebar) { animation: none; }
}

@media (max-width: 640px) {
  /* Single-column phone layout: the sidebar leaves the grid entirely and the
     dock can only exist as the full-screen overlay float. */
  .shell {
    grid-template-columns: 0 minmax(0, 1fr) 0;
  }
  .panel-resize-handle--left {
    display: none;
  }
  /* The mobile topbar is a fixed overlay: as a participating grid item it pushed
     .canvas into a 0px track and blanked the whole page. */
  .topbar {
    display: flex;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 30;
    background: var(--color-bg);
  }
  .canvas {
    padding-top: 54px;
  }
  .mobile-menu {
    display: grid;
  }
}
</style>
