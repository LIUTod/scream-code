<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import type { ChatMessage } from '../types';
import MessageItem from './MessageItem.vue';

const props = defineProps<{
  messages: ChatMessage[];
}>();

const listRef = ref<HTMLElement | null>(null);

watch(
  () => props.messages.length,
  () => {
    nextTick(() => {
      if (listRef.value) {
        listRef.value.scrollTop = listRef.value.scrollHeight;
      }
    });
  },
);
</script>

<template>
  <div ref="listRef" class="message-list">
    <div v-if="messages.length === 0" class="empty-state">
      <div class="empty-icon">■</div>
      <div class="empty-title">Scream Web UI</div>
      <div class="empty-desc">给 Scream 发消息，开始处理你的任务。</div>
    </div>
    <MessageItem v-for="message in messages" :key="message.id" :message="message" />
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  gap: 8px;
}
.empty-icon {
  font-size: 32px;
  color: var(--accent);
}
.empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}
.empty-desc {
  font-size: 14px;
}
</style>
