<!-- Collapsible group for consecutive same-type tool calls.
     Header shows tool name + count + aggregate status. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolMessage } from '../types';
import { aggregateStatus, toolStatus, type ToolStatus } from '../utils/toolGroup';
import GenericToolCard from './GenericToolCard.vue';
import EditToolCard from './EditToolCard.vue';
import { isEditTool } from '../utils/toolGroup';

const props = defineProps<{
  name: string;
  tools: ToolMessage[];
}>();

const open = ref(true);
const count = computed(() => props.tools.length);
const status = computed<ToolStatus>(() => aggregateStatus(props.tools));

const statusIcon = computed(() => {
  switch (status.value) {
    case 'ok': return '✓';
    case 'error': return '✗';
    case 'running': return '';
    default: return '';
  }
});

function toggle() {
  open.value = !open.value;
}
</script>

<template>
  <div :class="['tool-group', { open }]">
    <button class="tool-group-head" type="button" :aria-expanded="open" @click="toggle">
      <span :class="['status-dot', status]">
        <template v-if="statusIcon">{{ statusIcon }}</template>
      </span>
      <span class="tg-name">{{ name }}</span>
      <span class="tg-count">×{{ count }}</span>
      <span :class="['tg-chevron', { open }]">▸</span>
    </button>
    <div :class="['tool-group-body', { open }]">
      <div class="tool-group-inner">
        <component
          :is="isEditTool(name) ? EditToolCard : GenericToolCard"
          v-for="tool in tools"
          :key="tool.toolCallId"
          :tool="tool"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  font-size: var(--font-size-sm);
  animation: tool-in var(--dur-msg-assistant) var(--ease-out) both;
}
@keyframes tool-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .tool-group { animation: none; }
}

.tool-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-fast);
}
.tool-group-head:hover { background: var(--color-hover); }

.status-dot {
  width: 16px; height: 16px;
  border-radius: var(--radius-full);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; flex-shrink: 0;
}
.status-dot.ok { background: var(--color-success-soft); color: var(--color-success); }
.status-dot.error { background: var(--color-danger-soft); color: var(--color-danger); }
.status-dot.running { background: var(--color-accent); animation: pulse-dot 1.2s var(--ease-out) infinite; }
@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}

.tg-name {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--color-text);
}
.tg-count {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
}
.tg-chevron {
  margin-left: auto;
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  transition: transform var(--dur-base) var(--ease-out);
  flex-shrink: 0;
}
.tg-chevron.open { transform: rotate(90deg); }

.tool-group-body {
  display: grid;
  grid-template-rows: 0fr;
  overflow: hidden;
  transition: grid-template-rows var(--dur-base) var(--ease-out);
}
.tool-group-body.open { grid-template-rows: 1fr; }
.tool-group-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--space-1) var(--space-2) var(--space-2);
  background: var(--color-surface-sunken);
}
.tool-group-inner > * {
  border-radius: var(--radius-md);
}
</style>
