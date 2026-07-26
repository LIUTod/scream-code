<script setup lang="ts">
import { ref } from 'vue';
import { useScreamWebClient } from '../composables/useScreamWebClient';
import { slashHelpText } from '../commands';
import StatusBar from './StatusBar.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import ApprovalCard from './ApprovalCard.vue';
import SessionSidebar from './SessionSidebar.vue';

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
} = useScreamWebClient();

const composerRef = ref<InstanceType<typeof Composer> | null>(null);

function onEditResend(content: string) {
  composerRef.value?.insertText(content);
}

function onCommand(name: string) {
  switch (name) {
    case 'compact':
      sendCommand('compact');
      break;
    case 'model':
      appendSystemMessage(`当前模型：${status.value.model ?? 'unknown'}`);
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
      @create="createSession"
      @switch="switchSession"
      @delete="deleteSession"
      @export="exportSession"
    />
    <div class="chat-main">
      <StatusBar
        :connection-status="connectionStatus"
        :status="status"
        :session-id="sessionId"
        :work-dir="workDir"
        :git-status="gitStatus"
        @refresh-git="fetchGitStatus"
      />
      <MessageList :messages="messages" :busy="isBusy" :work-dir="workDir" @edit="onEditResend" @pick="sendPrompt" />
      <div class="composer-dock">
        <ApprovalCard :approvals="pendingApprovals" @resolve="resolveApproval" />
        <Composer
          ref="composerRef"
          :busy="isBusy"
          :status="status"
          :session-id="sessionId"
          @send="sendPrompt"
          @abort="abort"
          @command="onCommand"
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
@media (max-width: 640px) {
  .composer-dock {
    padding: var(--space-2) var(--space-2) var(--space-2);
  }
}
</style>
