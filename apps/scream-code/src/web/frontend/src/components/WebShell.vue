<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useScreamWebClient } from '../composables/useScreamWebClient';
import { slashHelpText } from '../commands';
import type { WorkspaceMode } from './ModeSwitch.vue';
import type { ShellView } from './Sidebar.vue';
import ConversationView from './ConversationView.vue';
import SettingsView from './SettingsView.vue';
import Sidebar from './Sidebar.vue';
import SkillsView from './SkillsView.vue';
import SvgIcon from './ui/SvgIcon.vue';
import WorkspaceHome from './WorkspaceHome.vue';

const client = useScreamWebClient();
const {
  connectionStatus,
  status,
  isBusy,
  sessions,
  currentSessionId,
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
  view.value = 'chat';
  if (!ready) return;
  if (mode === 'goal') {
    await client.createGoal({ objective: text, budgets: [] });
  } else {
    sendPrompt(text);
  }
}

function onSwitchSession(id: string) {
  mobileSidebarOpen.value = false;
  view.value = 'chat';
  switchSession(id);
}

function onCommand(name: string, args?: string) {
  switch (name) {
    case 'compact':
    case 'auto':
    case 'yes':
    case 'plan':
    case 'fork':
    case 'title':
    case 'btw':
      if (!currentSessionId.value) {
        void createSession().then(() => sendCommand(name, args));
        return;
      }
      sendCommand(name, args);
      break;
    case 'clear':
      client.clearMessages();
      break;
    case 'new':
      onCreateSession();
      break;
    case 'help':
      appendSystemMessage(slashHelpText());
      break;
    case 'model':
      appendSystemMessage(`当前模型：${status.value.model ?? 'unknown'}`);
      break;
    case 'status':
    case 'usage':
      appendSystemMessage('请在对话页查看会话详情');
      break;
    default:
      appendSystemMessage(`未知命令：/${name}`);
  }
}

const SIDEBAR_STORAGE_KEY = 'scream-sidebar-collapsed';
const sidebarCollapsed = ref(false);
try {
  sidebarCollapsed.value = localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
} catch {
  /* ignore */
}
function toggleSidebarCollapse() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try { localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed.value ? '1' : '0'); } catch { /* ignore */ }
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
  void fetchLike();
  void fetchGitStatus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));
</script>

<template>
  <div class="shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <Sidebar
      ref="sidebarRef"
      :view="view"
      :sessions="sessions"
      :current-session-id="currentSessionId"
      :collapsed="sidebarCollapsed"
      @navigate="onNavigate"
      @switch-session="onSwitchSession"
      @delete-session="deleteSession"
      @create-session="onCreateSession"
      @toggle-collapse="toggleSidebarCollapse"
    />

    <div v-if="mobileSidebarOpen" class="sidebar-backdrop" aria-hidden="true" @click="mobileSidebarOpen = false" />
    <div v-if="mobileSidebarOpen" class="sidebar-mobile">
      <Sidebar
        :view="view"
        :sessions="sessions"
        :current-session-id="currentSessionId"
        :show-collapse-toggle="false"
        @navigate="onNavigate"
        @switch-session="onSwitchSession"
        @delete-session="deleteSession"
        @create-session="onCreateSession"
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
        <SettingsView v-else-if="view === 'settings'" :like="like" @update-like="client.updateLike" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
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
@media (prefers-reduced-motion: reduce) {
  .shell { transition: none; }
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
    animation: slide-in var(--dur-slower) var(--ease-spring);
  }
  @keyframes backdrop-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes slide-in {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }
}
</style>
