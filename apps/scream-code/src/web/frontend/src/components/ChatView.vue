<script setup lang="ts">
import { useScreamWebClient } from '../composables/useScreamWebClient';
import StatusBar from './StatusBar.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import ApprovalDialog from './ApprovalDialog.vue';
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
  sendPrompt,
  abort,
  resolveApproval,
  fetchSessions,
  createSession,
  switchSession,
  deleteSession,
  exportSession,
} = useScreamWebClient();
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
      />
      <MessageList :messages="messages" />
      <Composer
        :busy="isBusy"
        @send="sendPrompt"
        @abort="abort"
      />
    </div>
    <ApprovalDialog
      :approvals="pendingApprovals"
      @resolve="resolveApproval"
    />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>
