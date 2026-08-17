<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import type { Ref } from 'vue';
import { useScreamWebClient } from '../composables/useScreamWebClient';
import { useResizable } from '../composables/useResizable';
import { slashHelpText } from '../commands';
import type { Theme } from '../theme';
import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import ApprovalCard from './ApprovalCard.vue';
import SessionSidebar from './SessionSidebar.vue';
import RightPanel from './RightPanel.vue';
import RightRail from './RightRail.vue';
import InfoPanel from './InfoPanel.vue';
import SearchSessionsDialog from './SearchSessionsDialog.vue';
import ResizeHandle from './ResizeHandle.vue';

const {
  connectionStatus,
  messages,
  pendingApprovals,
  status,
  goal,
  todos,
  goalRequestPending,
  goalRequestError,
  sessionId,
  workDir,
  isBusy,
  isArchived,
  sessions,
  currentSessionId,
  gitStatus,
  models,
  sendPrompt,
  sendCommand,
  clearMessages,
  appendSystemMessage,
  abort,
  resolveApproval,
  createSession,
  switchSession,
  deleteSession,
  exportSession,
  fetchGitStatus,
  fetchSnapshot,
  switchModel,
  switchThinking,
  refineGoal,
  createGoal,
  updateGoal,
  pauseGoal,
  resumeGoal,
  cancelGoal,
  like,
  fetchLike,
  updateLike,
} = useScreamWebClient();

const composerRef = ref<InstanceType<typeof Composer> | null>(null);
const infoVisible = ref(false);
const infoMode = ref<'status' | 'usage'>('status');

/* ── Model switchability (injected by TopBar) ────────────────────────────── */
const modelSwitchable = computed(() => models.value.length > 0);
provide('modelSwitchable', modelSwitchable);

/* ── Current session title ───────────────────────────────────────────────── */
const currentTitle = computed(() => {
  const s = sessions.value.find((s) => s.sessionId === currentSessionId.value);
  const stored = s?.title;
  if (stored && stored !== '新会话' && stored !== 'New Session') return stored;
  // Untitled session: summarise the first user message instead of a bare label.
  const firstUser = messages.value.find((m) => m.role === 'user');
  if (firstUser) {
    const text = firstUser.content.replace(/\s+/g, ' ').trim();
    if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }
  return stored ?? null;
});

/* ── Sidebar collapse (desktop) / overlay (mobile) ───────────────────────── */
// Versioned key intentionally ignores the pre-prototype layout's persisted
// collapsed state. From v2 onward, explicit desktop toggles remain persistent.
const SIDEBAR_KEY = 'scream-sidebar-collapsed-v2';
const sidebarCollapsed = ref(true);
const sidebarMobileOpen = ref(false);

try {
  sidebarCollapsed.value = localStorage.getItem(SIDEBAR_KEY) !== '0';
} catch {
  // Storage unavailable — default to collapsed.
}

function isMobileViewport(): boolean {
  return window.innerWidth <= 640;
}

function toggleSidebar() {
  if (isMobileViewport()) {
    sidebarMobileOpen.value = !sidebarMobileOpen.value;
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try {
    localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed.value ? '1' : '0');
  } catch {
    // Best-effort persistence.
  }
}

function onSwitchSession(id: string) {
  sidebarMobileOpen.value = false;
  switchSession(id);
}

/* ── Right panel (collapsed to an icon rail by default, like the sidebar) ─ */
const RIGHTBAR_KEY = 'scream-rightbar-collapsed-v2';
const rightbarOpen = ref(false);

try {
  rightbarOpen.value = localStorage.getItem(RIGHTBAR_KEY) === '1';
} catch {
  // Storage unavailable — default to collapsed.
}

function toggleRightbar() {
  rightbarOpen.value = !rightbarOpen.value;
  try {
    localStorage.setItem(RIGHTBAR_KEY, rightbarOpen.value ? '1' : '0');
  } catch {
    // Best-effort persistence.
  }
}

const theme = inject<Ref<Theme>>('theme', ref('system' as Theme));
const setTheme = inject<(t: Theme) => void>('setTheme', () => {});
function cycleTheme() {
  const order: Theme[] = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(theme.value) + 1) % order.length];
  setTheme(next);
}

/* ── Thinking / tool chain visibility (toggled from ChatHeader) ───────────── */
const showThinking = ref(true);
const showTools = ref(true);
provide('showThinking', showThinking);
provide('showTools', showTools);

/* ── Session search (Cmd+K) ──────────────────────────────────────────────── */
const searchOpen = ref(false);

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    searchOpen.value = !searchOpen.value;
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    onCreateSession();
  }
}
onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown);
  void fetchLike();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));

/* ── Sidebar resize (desktop) ────────────────────────────────────────────── */
const { width: sidebarWidth, dragging: sidebarDragging, onPointerDown: onSidebarResize } = useResizable({
  storageKey: 'scream-sidebar-width',
  defaultWidth: 360,
  min: 300,
  max: 440,
});

function onCreateSession() {
  sidebarMobileOpen.value = false;
  void createSession();
}

function onEditResend(content: string) {
  composerRef.value?.insertText(content);
}

function showInfo(mode: 'status' | 'usage') {
  void fetchSnapshot();
  infoMode.value = mode;
  infoVisible.value = true;
}

function openModelPicker() {
  const opened = composerRef.value?.openModelPicker() ?? false;
  if (!opened) {
    appendSystemMessage(`当前模型：${status.value.model ?? 'unknown'}`);
  }
}

function onCommand(name: string, args?: string) {
  switch (name) {
    case 'compact':
      sendCommand('compact');
      break;
    case 'model':
      openModelPicker();
      break;
    case 'clear':
      clearMessages();
      break;
    case 'new':
      void createSession();
      break;
    case 'help':
      appendSystemMessage(slashHelpText());
      break;
    case 'auto':
    case 'yes':
    case 'plan':
    case 'fork':
    case 'title':
    case 'btw':
      sendCommand(name, args);
      break;
    case 'status':
      showInfo('status');
      break;
    case 'usage':
      showInfo('usage');
      break;
    default:
      appendSystemMessage(`未知命令：/${name}`);
  }
}
</script>

<template>
  <div class="workbench" :class="{ 'sidebar-is-collapsed': sidebarCollapsed }" :style="{ '--sidebar-width': sidebarWidth + 'px' }">
    <SessionSidebar
      :sessions="sessions"
      :current-session-id="currentSessionId"
      :status="status"
      :busy="isBusy"
      :collapsed="sidebarCollapsed"
      :mobile-open="sidebarMobileOpen"
      @create="onCreateSession"
      @switch="onSwitchSession"
      @delete="deleteSession"
      @export="exportSession"
      @toggle="toggleSidebar"
      @open-search="searchOpen = true"
      @show-info="showInfo"
      @help="onCommand('help')"
    />
    <ResizeHandle v-if="!sidebarCollapsed" class="sidebar-resize" :dragging="sidebarDragging" @pointerdown="onSidebarResize" />
    <div v-if="sidebarMobileOpen" class="sidebar-backdrop" aria-hidden="true" @click="sidebarMobileOpen = false" />

    <main class="workbench-body">
      <div class="chat-main chat-inset">
        <ChatHeader
          :title="currentTitle"
          :busy="isBusy"
          @rename="(t) => sendCommand('title', t)"
          @export="currentSessionId && exportSession(currentSessionId)"
          @clear="clearMessages"
          @toggle-rightbar="toggleRightbar"
          @menu="toggleSidebar"
        />
        <MessageList
          :messages="messages"
          :busy="isBusy"
          :work-dir="workDir"
          :session-id="currentSessionId ?? ''"
          :model="status.model ?? null"
          :context-usage="status.contextUsage ?? null"
          :connected="connectionStatus === 'connected'"
          @edit="onEditResend"
          @pick="sendPrompt"
        />
        <div class="composer-dock">
          <ApprovalCard :approvals="pendingApprovals" @resolve="resolveApproval" />
          <Composer
            ref="composerRef"
            :busy="isBusy"
            :status="status"
            :session-id="sessionId"
            :models="models"
            @send="sendPrompt"
            @abort="abort"
            @command="onCommand"
            @switch-model="switchModel"
            @switch-thinking="switchThinking"
          />
        </div>
      </div>

      <div class="rightbar-host" :class="{ 'rightbar-collapsed': !rightbarOpen }">
        <RightRail
          v-if="!rightbarOpen"
          :theme="theme"
          :busy="isBusy"
          @expand="toggleRightbar"
          @select="toggleRightbar"
          @cycle-theme="cycleTheme"
        />
        <div v-else class="rightbar-open">
          <RightPanel
            :busy="isBusy"
            :session-id="sessionId"
            :connection-status="connectionStatus"
            :archived="isArchived"
            :goal="goal"
            :todos="todos"
            :goal-request-pending="goalRequestPending"
            :goal-request-error="goalRequestError"
            :refine-goal="refineGoal"
            :create-goal="createGoal"
            :update-goal="updateGoal"
            :pause-goal="pauseGoal"
            :resume-goal="resumeGoal"
            :cancel-goal="cancelGoal"
            :like="like"
            :update-like="updateLike"
            :status="status"
            :git-status="gitStatus"
            @refresh-git="fetchGitStatus"
            @toggle="toggleRightbar"
            @insert="onEditResend"
          />
        </div>
      </div>
    </main>

    <InfoPanel
      v-if="infoVisible"
      :mode="infoMode"
      :status="status"
      :session-id="sessionId"
      :work-dir="workDir"
      @close="infoVisible = false"
    />

    <SearchSessionsDialog
      v-if="searchOpen"
      :sessions="sessions"
      :active-id="currentSessionId"
      @select="onSwitchSession"
      @close="searchOpen = false"
    />
  </div>
</template>

<style scoped>
.workbench {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: "sidebar body";
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
}
.workbench.sidebar-is-collapsed { grid-template-columns: var(--sidebar-width-collapsed) minmax(0, 1fr); }
.workbench-body { grid-area: body; display:flex; min-width:0; min-height:0; overflow:hidden; }
.chat-inset { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; margin:14px 0 14px 14px; overflow:hidden; border:1px solid var(--color-line); border-radius:15px; background:var(--color-surface); box-shadow:0 3px 12px rgba(18,34,22,.035); }
.composer-dock { flex-shrink:0; display:flex; flex-direction:column; gap:8px; padding:10px 24px 18px; background:var(--color-surface); }
.rightbar-host { flex-shrink:0; width:var(--sidebar-width-collapsed); overflow:hidden; transition:width 200ms var(--ease-out), opacity 160ms var(--ease-out); }
.rightbar-host .rightbar-open { width:var(--rightbar-width, 348px); height:100%; overflow:hidden auto; padding:14px; }
.rightbar-host:not(.rightbar-collapsed) { width:var(--rightbar-width, 348px); }
.sidebar-resize { position:fixed; top:0; bottom:0; left:var(--sidebar-width); z-index:calc(var(--z-dock) + 3); }
.sidebar-backdrop { display:none; }
@media (max-width:1100px) { .rightbar-host { display:none; } .chat-inset { margin-right:14px; } }
@media (max-width:640px) {
  .workbench,.workbench.sidebar-is-collapsed { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); grid-template-areas:"body"; }
  .sidebar-resize { display:none; }
  .sidebar-backdrop { display:block; position:fixed; inset:0; background:rgba(15,20,16,.42); z-index:calc(var(--z-overlay) - 1); animation:backdrop-in var(--dur-slow) var(--ease-out); }
  .chat-inset { margin:8px; border-radius:12px; }
  .composer-dock { padding:8px; }
  @keyframes backdrop-in { from { opacity:0; } to { opacity:1; } }
}
</style>
