<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ChatMessage } from '../types';
import MessageItem from './MessageItem.vue';
import EmptyState from './EmptyState.vue';

const props = withDefaults(
  defineProps<{
    messages: ChatMessage[];
    busy?: boolean;
    workDir?: string | null;
  }>(),
  { busy: false, workDir: null },
);

const emit = defineEmits<{
  (e: 'edit', content: string): void;
  (e: 'pick', text: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);

const latestUserId = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i]!.role === 'user') return props.messages[i]!.id;
  }
  return null;
});

const lastMessageId = computed(() => props.messages.at(-1)?.id ?? null);

/** Streaming content length — drives scroll pinning during deltas. */
const streamLength = computed(() => {
  const last = props.messages.at(-1);
  if (!last) return 0;
  let len = last.content.length;
  for (const t of last.tools) len += t.output?.length ?? 0;
  return len;
});

function isNearBottom(): boolean {
  const el = listRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom() {
  nextTick(() => {
    const el = listRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(
  () => [props.messages.length, streamLength.value],
  () => {
    if (isNearBottom()) scrollToBottom();
  },
);
</script>

<template>
  <div ref="listRef" class="message-list">
    <EmptyState v-if="messages.length === 0" :work-dir="workDir" @pick="(t) => emit('pick', t)" />
    <MessageItem
      v-for="message in messages"
      :key="message.id"
      :message="message"
      :is-latest-user="message.id === latestUserId"
      :idle="!busy"
      :streaming="busy && message.id === lastMessageId && message.role === 'assistant'"
      @edit="(content) => emit('edit', content)"
    />
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>
