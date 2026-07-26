<script setup lang="ts">
import { useScreamWebClient } from '../composables/useScreamWebClient';
import StatusBar from './StatusBar.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import ApprovalDialog from './ApprovalDialog.vue';

const {
  connectionStatus,
  messages,
  pendingApprovals,
  status,
  sessionId,
  workDir,
  isBusy,
  sendPrompt,
  abort,
  resolveApproval,
} = useScreamWebClient();
</script>

<template>
  <div class="chat-view">
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
    
    <ApprovalDialog
      :approvals="pendingApprovals"
      @resolve="resolveApproval"
    />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}
</style>
