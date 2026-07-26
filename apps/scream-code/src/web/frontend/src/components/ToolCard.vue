<script setup lang="ts">
import { ref } from 'vue';
import type { ToolMessage } from '../types';

const props = defineProps<{
  tool: ToolMessage;
  thinking?: boolean;
}>();

const expanded = ref(false);

function formatArgs(): string {
  if (!props.tool.args) return '';
  try {
    return JSON.stringify(props.tool.args, null, 2);
  } catch {
    return String(props.tool.args);
  }
}

function truncateOutput(s: string | undefined, max = 2000): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + `\n... (${s.length - max} more chars)` : s;
}
</script>

<template>
  <div :class="['tool-card', { thinking, error: tool.isError }]">
    <div class="tool-header" @click="thinking ? (expanded = !expanded) : null">
      <span class="tool-icon">{{ thinking ? '💭' : '🔧' }}</span>
      <span class="tool-name">{{ thinking ? '思考过程' : tool.name }}</span>
      <span v-if="thinking" class="tool-toggle">{{ expanded ? '收起' : '展开' }}</span>
    </div>
    <div v-if="!thinking || expanded" class="tool-body">
      <pre v-if="formatArgs()" class="tool-args"><code>{{ formatArgs() }}</code></pre>
      <pre v-if="tool.output !== undefined" class="tool-result"><code>{{ truncateOutput(tool.output) }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--blue);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13px;
}
.tool-card.thinking {
  border-left-color: var(--yellow);
  background: #f7e30808;
}
.tool-card.error {
  border-left-color: var(--red);
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg);
  cursor: default;
}
.tool-card.thinking .tool-header {
  cursor: pointer;
}
.tool-name {
  font-weight: 600;
  color: var(--text);
}
.tool-toggle {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 12px;
}
.tool-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-args, .tool-result {
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SF Mono", "Cascadia Code", monospace;
  font-size: 12px;
  line-height: 1.5;
}
.tool-result {
  color: var(--text);
}
.tool-card.error .tool-result {
  color: var(--red);
}
</style>
