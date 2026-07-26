<script setup lang="ts">
import type { ChatMessage, ToolMessage } from '../types';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ToolCard from './ToolCard.vue';

const props = defineProps<{
  message: ChatMessage;
}>();

function isThinkingTool(tool: ToolMessage): boolean {
  return tool.name === 'thinking';
}

const thinkingTools = props.message.tools.filter(isThinkingTool);
const realTools = props.message.tools.filter((t) => !isThinkingTool(t));
</script>

<template>
  <div :class="['message', message.role, { error: message.isError }]">
    <div class="message-avatar">
      {{ message.role === 'user' ? '👤' : message.role === 'system' ? '⚙️' : '■' }}
    </div>
    <div class="message-body">
      <div v-if="message.role === 'user'" class="user-content">{{ message.content }}</div>
      <div v-else class="assistant-content">
        <MarkdownRenderer v-if="message.content" :content="message.content" />
        <div v-if="thinkingTools.length" class="thinking-section">
          <ToolCard
            v-for="tool in thinkingTools"
            :key="tool.toolCallId"
            :tool="tool"
            thinking
          />
        </div>
        <div v-if="realTools.length" class="tools-section">
          <ToolCard
            v-for="tool in realTools"
            :key="tool.toolCallId"
            :tool="tool"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  max-width: 100%;
}
.message.user {
  background: var(--user-bg);
}
.message.assistant {
  background: var(--assistant-bg);
}
.message.error .message-body {
  color: var(--red);
}
.message-avatar {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border: 1px solid var(--border);
  flex-shrink: 0;
  font-size: 14px;
}
.message-body {
  flex: 1;
  min-width: 0;
  line-height: 1.7;
}
.user-content {
  white-space: pre-wrap;
  word-break: break-word;
}
.tools-section, .thinking-section {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
