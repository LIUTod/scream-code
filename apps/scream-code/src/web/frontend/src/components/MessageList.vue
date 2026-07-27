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

watch(
  () => [props.messages.length, streamLength.value],
  ([len], [oldLen]) => {
    if (!isNearBottom()) return;
    // New message → smooth scroll; streaming deltas → instant scroll to avoid jank.
    const smooth = len !== oldLen;
    nextTick(() => {
      const el = listRef.value;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  },
);

/** Skeleton placeholder while waiting for the assistant's first delta. */
const showSkeleton = computed(() => {
  if (!props.busy || props.messages.length === 0) return false;
  return props.messages.at(-1)!.role === 'user';
});
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
    <div v-if="showSkeleton" class="message-skeleton" aria-hidden="true">
      <div class="sk-avatar" />
      <div class="sk-body">
        <div class="sk-line sk-w-60" />
        <div class="sk-line sk-w-90" />
        <div class="sk-line sk-w-40" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 12px 0 8px;
  overscroll-behavior: contain;
  background: var(--color-surface);
}

/* Skeleton loading placeholder */
.message-skeleton {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  animation: sk-in var(--dur-base) var(--ease-out) both;
}
@keyframes sk-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.sk-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
.sk-body {
  flex: 1;
  min-width: 0;
  padding-top: var(--space-1);
}
.sk-line {
  height: 12px;
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-2);
}
.sk-w-60 { width: 60%; }
.sk-w-90 { width: 90%; }
.sk-w-40 { width: 40%; }
.sk-avatar,
.sk-line {
  background: linear-gradient(
    90deg,
    var(--color-surface) 25%,
    var(--color-surface-raised) 50%,
    var(--color-surface) 75%
  );
  background-size: 200% 100%;
  animation: sk-shimmer 1.2s linear infinite;
}
@keyframes sk-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .sk-avatar,
  .sk-line {
    animation: none;
  }
}
</style>
