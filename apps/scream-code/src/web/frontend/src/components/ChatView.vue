<script setup lang="ts">
import { ref } from 'vue';
import { useScreamWebClient } from '../composables/useScreamWebClient';
import { slashHelpText } from '../commands';
import StatusBar from './StatusBar.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import ApprovalCard from './ApprovalCard.vue';
import SessionSidebar from './SessionSidebar.vue';
import InfoPanel from './InfoPanel.vue';

const {
  connectionStatus,
  messages,
  pendingApprovals,
  status,
  sessionId,
  workDir,
  isBusy,
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
} = useScreamWebClient();

const composerRef = ref<InstanceType<typeof Composer> | null>(null);
const infoVisible = ref(false);
const infoMode = ref<'status' | 'usage'>('status');

/* ── Sidebar collapse (desktop) / overlay (mobile) ───────────────────────── */
const SIDEBAR_KEY = 'scream-sidebar-collapsed';
const sidebarCollapsed = ref(false);
const sidebarMobileOpen = ref(false);

try {
  sidebarCollapsed.value = localStorage.getItem(SIDEBAR_KEY) === '1';
} catch {
  // Storage unavailable — default to expanded.
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

function onCreateSession() {
  sidebarMobileOpen.value = false;
  void createSession();
}

function onEditResend(content: string) {
  composerRef.value?.insertText(content);
}

function onCommand(name: string, args?: string) {
  switch (name) {
    case 'compact':
      sendCommand('compact');
      break;
    case 'model': {
      // Open the model picker; fall back to a read-only status message when
      // the backend has no models configured.
      const opened = composerRef.value?.openModelPicker() ?? false;
      if (!opened) {
        appendSystemMessage(`当前模型：${status.value.model ?? 'unknown'}`);
      }
      break;
    }
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
      void fetchSnapshot();
      infoMode.value = 'status';
      infoVisible.value = true;
      break;
    case 'usage':
      void fetchSnapshot();
      infoMode.value = 'usage';
      infoVisible.value = true;
      break;
    default:
      appendSystemMessage(`未知命令：/${name}`);
  }
}
</script>

<template>
  <div class="chat-view">
    <SessionSidebar
      :sessions="sessions"
      :current-session-id="currentSessionId"
      :collapsed="sidebarCollapsed"
      :mobile-open="sidebarMobileOpen"
      @create="onCreateSession"
      @switch="onSwitchSession"
      @delete="deleteSession"
      @export="exportSession"
      @toggle="toggleSidebar"
    />
    <div
      v-if="sidebarMobileOpen"
      class="sidebar-backdrop"
      aria-hidden="true"
      @click="sidebarMobileOpen = false"
    />
    <div class="chat-main">
      <StatusBar
        :connection-status="connectionStatus"
        :status="status"
        :session-id="sessionId"
        :work-dir="workDir"
        :git-status="gitStatus"
        @refresh-git="fetchGitStatus"
        @toggle-sidebar="toggleSidebar"
      />
      <MessageList :messages="messages" :busy="isBusy" :work-dir="workDir" @edit="onEditResend" @pick="sendPrompt" />

      <InfoPanel
        v-if="infoVisible"
        :mode="infoMode"
        :status="status"
        :session-id="sessionId"
        :work-dir="workDir"
        @close="infoVisible = false"
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
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
}
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.composer-dock {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-3);
  border-top: 1px solid var(--color-line);
  background: var(--color-surface);
}
.sidebar-backdrop {
  display: none;
}
@media (max-width: 640px) {
  .sidebar-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: calc(var(--z-overlay) - 1);
    animation: backdrop-in var(--dur-slow) var(--ease-out);
  }
  @keyframes backdrop-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
}
@media (max-width: 640px) {
  .composer-dock {
    padding: var(--space-2) var(--space-2) var(--space-2);
  }
}
</style>
