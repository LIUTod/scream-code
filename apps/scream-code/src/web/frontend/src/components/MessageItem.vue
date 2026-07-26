<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMessage, ToolMessage } from '../types';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ToolCard from './ToolCard.vue';
import ThinkingBlock from './ThinkingBlock.vue';

const props = withDefaults(
  defineProps<{
    message: ChatMessage;
    /** True when this is the most recent user message (enables edit & resend). */
    isLatestUser?: boolean;
    /** True when no turn is running. */
    idle?: boolean;
    /** True while this assistant message is still streaming. */
    streaming?: boolean;
  }>(),
  { isLatestUser: false, idle: true, streaming: false },
);

const emit = defineEmits<{
  (e: 'edit', content: string): void;
}>();

const copied = ref(false);
let copyTimer: number | null = null;

const isUser = computed(() => props.message.role === 'user');
const avatarIcon = computed(() =>
  props.message.role === 'user' ? '👤' : props.message.role === 'system' ? '⚙️' : '■',
);

const thinkingTools = computed(() => props.message.tools.filter((t) => t.name === 'thinking'));
const realTools = computed(() => props.message.tools.filter((t) => t.name !== 'thinking'));

const timestamp = computed(() => {
  if (!props.message.ts) return '';
  const d = new Date(props.message.ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
});

const canEdit = computed(() => isUser.value && props.isLatestUser && props.idle);

async function copyContent() {
  try {
    await navigator.clipboard.writeText(props.message.content);
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = props.message.content;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  copied.value = true;
  if (copyTimer !== null) clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}

function editResend() {
  emit('edit', props.message.content);
}
</script>

<template>
  <div :class="['message', message.role, { error: message.isError }]">
    <div :class="['message-avatar', message.role]">{{ avatarIcon }}</div>

    <div class="message-body">
      <div v-if="isUser" class="user-bubble">{{ message.content }}</div>
      <template v-else>
        <MarkdownRenderer v-if="message.content" class="assistant-content" :content="message.content" />
        <span v-else-if="streaming" class="streaming-cursor" aria-label="正在生成">▍</span>
        <ThinkingBlock
          v-for="tool in thinkingTools"
          :key="tool.toolCallId"
          :tool="tool"
          :active="streaming"
        />
        <div v-if="realTools.length" class="tools-section">
          <ToolCard v-for="tool in realTools" :key="tool.toolCallId" :tool="tool" />
        </div>
      </template>

      <div class="message-meta">
        <span v-if="timestamp" class="meta-time">{{ timestamp }}</span>
        <button
          v-if="message.content"
          class="meta-btn copy-btn"
          :title="copied ? '已复制' : '复制内容'"
          @click="copyContent"
        >
          {{ copied ? '✓ 已复制' : '复制' }}
        </button>
        <button v-if="canEdit" class="meta-btn edit-btn" title="编辑并重新发送" @click="editResend">
          编辑重发
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  max-width: 100%;
}
.message.user {
  flex-direction: row-reverse;
}

.message-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: var(--font-size-base);
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}
.message-avatar.user {
  background: var(--color-accent-soft);
  border-color: var(--color-accent-bd);
}
.message-avatar.assistant {
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-color: var(--color-accent-bd);
}

.message-body {
  flex: 1;
  min-width: 0;
  line-height: 1.7;
  display: flex;
  flex-direction: column;
}
.message.user .message-body {
  align-items: flex-end;
}
.message.assistant .message-body {
  width: 94%;
}
.message.error .message-body {
  color: var(--color-danger);
}

.user-bubble {
  max-width: 78%;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl);
  padding: var(--space-2) var(--space-4);
  white-space: pre-wrap;
  word-break: break-word;
}

.assistant-content {
  width: 100%;
}

.streaming-cursor {
  color: var(--color-accent);
  animation: blink 1s steps(2) infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}

.tools-section {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  min-height: 18px;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
.meta-time {
  font-variant-numeric: tabular-nums;
}
.meta-btn {
  background: transparent;
  border: none;
  padding: 0 var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
  cursor: pointer;
  border-radius: var(--radius-xs);
  opacity: 0;
  transition: opacity var(--dur-fast), color var(--dur-fast);
}
.message:hover .meta-btn,
.meta-btn:focus-visible {
  opacity: 1;
}
.meta-btn:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
.copy-btn:active {
  color: var(--color-success);
}

@media (max-width: 640px) {
  .message {
    padding: var(--space-3) var(--space-3);
    gap: var(--space-2);
  }
  .user-bubble {
    max-width: 88%;
  }
  .message.assistant .message-body {
    width: 100%;
  }
  .meta-btn {
    opacity: 1;
  }
}
</style>
