<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useScreamWebClient } from '../composables/useScreamWebClient';
import { useSlashCommands } from '../composables/useSlashCommands';
import { usePanelResize } from '../composables/usePanelResize';
import type { WorkspaceMode } from './ModeSwitch.vue';
import type { ShellView } from './Sidebar.vue';
import {
  RIGHT_PANEL_MIN_WIDTH,
  SPLIT_PANEL_MIN_WIDTH,
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
} from '../utils/panelLayout';
import { filePanel, openFileInPanel, setFilePanelOpen } from '../utils/fileTabState';
import { readStoredString, writeStoredString } from '../utils/storage';
import { useToast } from '../composables/useToast';
import ConversationView from './ConversationView.vue';
import FileViewer from './FileViewer.vue';
import InfoPanel from './InfoPanel.vue';
import SettingsView from './SettingsView.vue';
import Sidebar from './Sidebar.vue';
import SkillsView from './SkillsView.vue';
import SvgIcon from './ui/SvgIcon.vue';
import TabBar from './TabBar.vue';
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

function onNavigate(id: ShellView) {
  if (id === 'chat') {
    if (currentSessionId.value) {
      view.value = 'chat';
    } else {
      void onCreateSession();
    }
  } else {
    view.value = id;
  }
  mobileSidebarOpen.value = false;
}

function onCreateSession() {
  mobileSidebarOpen.value = false;
  view.value = 'chat';
  void createSession();
}

async function onWorkspaceSend(text: string, mode: WorkspaceMode) {
  mobileSidebarOpen.value = false;
  if (!currentSessionId.value) await createSession();
  const ready = await waitForConnected();
  // Only switch away from the home view once the transport is confirmed, so an
  // offline click keeps the input and the selected mode instead of dropping both.
  if (!ready) return;
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
  // Home view: session commands need a session first; create one, then send.
  ensureSession: async () => {
    if (!currentSessionId.value) await createSession();
  },
  onNew: onCreateSession,
  showInfo,
  currentModel: () => status.value.model,
});

const SIDEBAR_STORAGE_KEY = 'scream-sidebar-collapsed';
const sidebarCollapsed = ref(readStoredString(SIDEBAR_STORAGE_KEY) === '1');
function toggleSidebarCollapse() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  writeStoredString(SIDEBAR_STORAGE_KEY, sidebarCollapsed.value ? '1' : '0');
}

/* ── Viewport width drives the split breakpoint and the clamp interlocks ──── */
const viewportWidth = ref(window.innerWidth);
const isSplitMode = computed(() => viewportWidth.value >= SPLIT_PANEL_MIN_WIDTH);

function onWindowResize() {
  viewportWidth.value = window.innerWidth;
}

/* ── Draggable sidebar width (180–480px, persisted, double-click resets) ─── */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 288;

const sidebarResize = usePanelResize({
  storageKey: 'scream-sidebar-width',
  minWidth: SIDEBAR_MIN,
  // Interlock: an open right panel shrinks the sidebar's headroom so the chat
  // column keeps its minimum width (420px desktop / 320px compact).
  maxWidth: () =>
    getSidebarMaxWidth({
      viewportWidth: viewportWidth.value,
      rightPanelOpen: filePanel.panelOpen,
      rightPanelWidth: effectiveRightPanelWidth.value,
    }),
  defaultWidth: SIDEBAR_DEFAULT,
  side: 'left',
  canDrag: () => !sidebarCollapsed.value,
  acceptStoredWidth: (w) => w <= SIDEBAR_MAX,
});
const sidebarWidth = sidebarResize.width;
const resizing = sidebarResize.resizing;

/* ── Right file panel: width clamp interlocked with sidebar and viewport ──── */
const rightPanelResize = usePanelResize({
  storageKey: 'scream-right-panel-width',
  minWidth: RIGHT_PANEL_MIN_WIDTH,
  maxWidth: () =>
    getRightPanelMaxWidth({
      viewportWidth: viewportWidth.value,
      sidebarOpen: !sidebarCollapsed.value,
      sidebarWidth: sidebarWidth.value,
    }),
  defaultWidth: () => getDefaultRightPanelWidth(viewportWidth.value),
  side: 'right',
});
const rightPanelWidth = rightPanelResize.width;
const rightResizing = rightPanelResize.resizing;

function closeRightPanel() {
  setFilePanelOpen(false);
}

// Crossing the 960px breakpoint mid-drag unmounts the handle (v-if), so the
// pointerup never fires — release the drag state when the mode flips.
watch(isSplitMode, () => {
  if (rightResizing.value) rightPanelResize.release();
});

/** Effective panel width after the sidebar/viewport interlock. */
const effectiveRightPanelWidth = rightPanelResize.effectiveWidth;

const shellStyle = computed(() => ({
  '--sidebar-width': `${sidebarWidth.value}px`,
  '--right-panel-width': `${effectiveRightPanelWidth.value}px`,
}));

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
    // ⌘K from the collapsed rail must first widen the sidebar, then focus.
    if (sidebarCollapsed.value) toggleSidebarCollapse();
    void nextTick(() => sidebarRef.value?.focusSearch());
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
  void fetchLike();
  void fetchGitStatus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  window.removeEventListener('resize', onWindowResize);
});
</script>

<template>
  <div
    class="shell"
    :class="{
      'sidebar-collapsed': sidebarCollapsed,
      resizing: resizing || rightResizing,
      'right-panel-open': filePanel.panelOpen && isSplitMode,
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
      :collapsed="sidebarCollapsed"
      @navigate="onNavigate"
      @switch-session="onSwitchSession"
      @delete-session="deleteSession"
      @create-session="onCreateSession"
      @toggle-collapse="toggleSidebarCollapse"
      @open-file="onOpenFile"
      @rename-session="onRenameSession"
    />

    <div
      v-if="!sidebarCollapsed"
      class="panel-resize-handle panel-resize-handle--left"
      :class="{ resizing }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      :aria-valuenow="sidebarWidth"
      aria-valuemin="180"
      aria-valuemax="480"
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
          :models="models"
          :status="status"
          :busy="isBusy"
          :mode="workspaceMode"
          @update:mode="setWorkspaceMode"
          @send="onWorkspaceSend"
          @command="onCommand"
          @switch-model="switchModel"
          @switch-thinking="switchThinking"
        />
        <ConversationView
          v-else-if="view === 'chat'"
          :client="client"
          @home="view = 'home'"
        />
        <SkillsView v-else-if="view === 'skills'" @create="onCreateSession" />
        <SettingsView
          v-else-if="view === 'settings'"
          :like="like"
          :client="client"
          @update-like="client.updateLike"
        />
      </div>
    </main>

    <!-- Right file panel: overlay drawer below the split breakpoint, third
         grid column above it. Backdrop only exists in overlay mode. -->
    <div
      v-if="filePanel.panelOpen && !isSplitMode"
      class="right-panel-backdrop"
      aria-hidden="true"
      @click="closeRightPanel"
    />
    <div
      v-if="filePanel.panelOpen && isSplitMode"
      class="panel-resize-handle panel-resize-handle--right"
      :class="{ resizing: rightResizing }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整文件面板宽度"
      :aria-valuenow="effectiveRightPanelWidth"
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
      v-if="filePanel.panelOpen"
      class="right-panel"
      :class="{ overlay: !isSplitMode }"
      aria-label="文件面板"
    >
      <div class="right-panel-head">
        <TabBar />
        <button class="right-panel-close" title="收起文件面板" aria-label="收起文件面板" @click="closeRightPanel">
          <SvgIcon name="chevron-right" :size="16" />
        </button>
      </div>
      <div class="right-panel-body">
        <FileViewer :client="client" />
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
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  /* Collapsed rail morphs the grid track, not just the sidebar's own width,
     so the canvas breathes in step with the drawer. */
  transition: grid-template-columns var(--dur-slower) var(--ease-out);
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: transparent;
  color: var(--color-text);
}
.shell.sidebar-collapsed {
  grid-template-columns: var(--sidebar-width-collapsed) minmax(0, 1fr);
}
/* The `right-panel-open` class is only set in split mode (≥960px); below
   that breakpoint the panel is a fixed overlay and the grid stays 2-col. */
.shell.right-panel-open {
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--right-panel-width);
}
.shell.right-panel-open.sidebar-collapsed {
  grid-template-columns: var(--sidebar-width-collapsed) minmax(0, 1fr) var(--right-panel-width);
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
  left: calc(var(--sidebar-width) - 6px);
}
.panel-resize-handle--right {
  right: calc(var(--right-panel-width) - 6px);
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
  transition: background var(--dur-fast) var(--ease-out);
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
@media (max-width: 959px) {
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
.right-panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-line);
  flex-shrink: 0;
}
.right-panel-close {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.right-panel-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.right-panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.right-panel-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  z-index: calc(var(--z-overlay) - 1);
  animation: backdrop-in var(--dur-slow) var(--ease-out);
}
.right-panel.overlay {
  position: fixed;
  top: 0;
  bottom: 0;
  right: 0;
  width: min(var(--right-panel-width), 92vw);
  z-index: var(--z-overlay);
  box-shadow: var(--shadow-xl);
  --slide-from: 100%;
  animation: slide-in var(--dur-slower) var(--ease-spring);
}
@keyframes backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
/* Direction is a custom property so the right drawer and the mobile sidebar
   share one keyframes definition. */
@keyframes slide-in {
  from { transform: translateX(var(--slide-from)); }
  to { transform: translateX(0); }
}
@media (max-width: 640px) {
  .right-panel.overlay {
    width: 100vw;
  }
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

.sidebar-backdrop {
  display: none;
}

@media (max-width: 640px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }
  .panel-resize-handle--left {
    display: none;
  }
  .topbar {
    display: flex;
  }
  .mobile-menu {
    display: grid;
  }
  .sidebar-backdrop {
    display: block;
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
}
</style>
