<script setup lang="ts">
import { computed, ref } from 'vue';
import type { UseScreamWebClientReturn } from '../composables/useScreamWebClient';
import { slashHelpText } from '../commands';
import ApprovalCard from './ApprovalCard.vue';
import Composer from './Composer.vue';
import ConversationHeader from './ConversationHeader.vue';
import InfoPanel from './InfoPanel.vue';
import MessageList from './MessageList.vue';
import SessionDrawer from './SessionDrawer.vue';

const props = defineProps<{ client: UseScreamWebClientReturn }>();

const emit = defineEmits<{ (e: 'home'): void }>();

const {
  connectionStatus,
  messages,
  pendingApprovals,
  status,
  sessionId,
  workDir,
  isBusy,
  models,
  sendPrompt,
  sendCommand,
  clearMessages,
  appendSystemMessage,
  abort,
  resolveApproval,
  exportSession,
  fetchSnapshot,
  switchModel,
  switchThinking,
} = props.client;

const composerRef = ref<InstanceType<typeof Composer> | null>(null);
const drawerOpen = ref(false);
const infoVisible = ref(false);
const infoMode = ref<'status' | 'usage'>('status');

const currentTitle = computed(() => {
  const s = props.client.sessions.value.find((x) => x.sessionId === props.client.currentSessionId.value);
  const stored = s?.title;
  if (stored && stored !== '新会话' && stored !== 'New Session') return stored;
  const firstUser = messages.value.find((m) => m.role === 'user');
  if (firstUser) {
    const text = firstUser.content.replace(/\s+/g, ' ').trim();
    if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }
  return stored ?? null;
});

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
      emit('home');
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

function onRename(title: string) {
  sendCommand('title', title);
}

function retryLastUser() {
  if (isBusy.value || !connectionStatus.value) return;
  const lastUser = [...messages.value].reverse().find((m) => m.role === 'user');
  if (lastUser) sendPrompt(lastUser.content);
}

const loadingOlder = ref(false);
async function onLoadOlder(): Promise<void> {
  loadingOlder.value = true;
  await props.client.loadOlderMessages();
  loadingOlder.value = false;
}

function onFork(): void {
  if (isBusy.value) return;
  sendCommand('fork');
  // The fork result arrives as a system message; refresh the sidebar list so
  // the new session shows up without a manual reload.
  setTimeout(() => {
    void props.client.fetchSessions();
  }, 1200);
}
</script>

<template>
  <div class="conversation">
    <ConversationHeader
      :title="currentTitle"
      :busy="isBusy"
      :drawer-open="drawerOpen"
      @home="emit('home')"
      @rename="onRename"
      @export="sessionId && exportSession(sessionId)"
      @clear="clearMessages"
      @toggle-drawer="drawerOpen = !drawerOpen"
    />

    <div class="chat-stage">
      <div class="chat-column">
        <MessageList
          :messages="messages"
          :busy="isBusy"
          :work-dir="workDir"
          :session-id="sessionId ?? ''"
          :model="status.model ?? null"
          :context-usage="status.contextUsage ?? null"
          :connected="connectionStatus === 'connected'"
          :older-available="props.client.olderAvailable.value"
          :older-loading="loadingOlder"
          @edit="onEditResend"
          @pick="sendPrompt"
          @retry-connection="props.client.reconnectNow()"
          @retry-message="retryLastUser"
          @load-older="onLoadOlder"
          @fork="onFork"
        />
        <div class="composer-dock">
          <ApprovalCard :approvals="pendingApprovals" @resolve="resolveApproval" />
          <Composer
            ref="composerRef"
            :busy="isBusy"
            :status="status"
            :session-id="sessionId"
            :models="models"
            :work-dir="workDir || ''"
            :messages="messages"
            @send="sendPrompt"
            @abort="abort"
            @command="onCommand"
            @switch-model="switchModel"
            @switch-thinking="switchThinking"
          />
        </div>
      </div>
      <Transition name="drawer">
        <SessionDrawer
          v-if="drawerOpen"
          :client="props.client"
          @refresh-git="props.client.fetchGitStatus()"
          @close="drawerOpen = false"
        />
      </Transition>
    </div>

    <InfoPanel
      v-if="infoVisible"
      :mode="infoMode"
      :status="status"
      :session-id="sessionId"
      :work-dir="workDir"
      @close="infoVisible = false"
    />
  </div>
</template>

<style scoped>
.conversation {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
}
.chat-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: center;
}
/* `flex: 1` sets flex-basis, which silently overrides `width` — the 840px cap
   never applied and the whole conversation ran edge-to-edge. Cap with
   max-width so the column grows to --content-max and stops there, matching the
   home view's measure. */
.chat-column {
  flex: 1 1 auto;
  min-width: 0;
  max-width: var(--content-max);
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.chat-column > :first-child {
  flex: 1;
  min-height: 0;
}
.composer-dock {
  flex-shrink: 0;
  padding: var(--space-2) var(--space-5) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
@media (max-width: 640px) {
  .composer-dock {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }
}
</style>
