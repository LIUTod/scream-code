<!-- Specialized tool card for file edit/write operations.
     Shows file path, diff stats chip (+N -M), and an expandable diff view. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ToolMessage } from '../types';
import { buildEditDiff, type DiffLine } from '../utils/diff';
import DiffLines from './DiffLines.vue';

const props = defineProps<{ tool: ToolMessage }>();

type ToolStatus = 'ok' | 'error' | 'running' | 'suspended';

const status = computed<ToolStatus>(() => {
  if (props.tool.suspended) return 'suspended';
  if (props.tool.isError) return 'error';
  if (props.tool.output === undefined) return 'running';
  return 'ok';
});

const statusIcon = computed(() => {
  switch (status.value) {
    case 'ok': return '✓';
    case 'error': return '✗';
    default: return '';
  }
});

const editDiff = computed(() => {
  const result = buildEditDiff(props.tool.args);
  return result;
});

const chip = computed(() => {
  const d = editDiff.value;
  if (!d || status.value === 'error') return '';
  const { added, removed } = d.stats;
  if (!added && !removed) return '';
  return `+${added} −${removed}`;
});

const filePath = computed(() => editDiff.value?.path);

const expanded = ref(false);
let userToggled = false;

watch(status, (s) => {
  if (userToggled) return;
  expanded.value = s === 'running';
}, { immediate: true });

function toggle() {
  userToggled = true;
  expanded.value = !expanded.value;
}

const diffLines = computed<DiffLine[]>(() => editDiff.value?.diff ?? []);
const hasDiff = computed(() => diffLines.value.length > 0);
</script>

<template>
  <div :class="['tool-card', `is-${status}`, 'edit-tool-card']">
    <div class="tool-header" role="button" tabindex="0" @click="toggle" @keydown.enter.prevent="toggle">
      <span :class="['status-dot', status]">
        <template v-if="statusIcon">{{ statusIcon }}</template>
      </span>
      <span class="tool-name">{{ tool.name }}</span>
      <span v-if="filePath" class="tool-filepath" :title="filePath">{{ filePath }}</span>
      <span v-if="chip" class="diff-chip">{{ chip }}</span>
      <span :class="['tool-chevron', { open: expanded }]">▸</span>
    </div>

    <div :class="['tool-collapse', { open: expanded }]">
      <div class="tool-collapse-inner">
        <div class="tool-body">
          <DiffLines v-if="hasDiff" :lines="diffLines" />
          <pre v-if="tool.output !== undefined" class="tool-result"><code>{{ tool.output || '(无输出)' }}</code></pre>
          <div v-else class="tool-running-hint">执行中…</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  font-size: var(--font-size-sm);
  animation: tool-in var(--dur-msg-assistant) var(--ease-out) both;
  transition: border-color var(--dur-base);
}
@keyframes tool-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .tool-card { animation: none; }
}
.tool-card.is-error { border-color: var(--color-danger); }

.tool-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  user-select: none;
  background: var(--color-surface-raised);
  transition: background var(--dur-fast);
}
.tool-header:hover { background: var(--color-hover); }
.tool-card.is-error .tool-header { background: var(--color-danger-soft); }

.status-dot {
  width: 16px; height: 16px;
  border-radius: var(--radius-full);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; flex-shrink: 0;
}
.status-dot.ok { background: var(--color-success-soft); color: var(--color-success); }
.status-dot.error { background: var(--color-danger-soft); color: var(--color-danger); }
.status-dot.running { background: var(--color-accent); animation: pulse-dot 1.2s var(--ease-out) infinite; }
.status-dot.suspended { background: var(--color-line-strong); }
@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}

.tool-name {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  flex-shrink: 0;
}
.tool-filepath {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  direction: rtl;
  text-align: left;
}
.diff-chip {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  padding: 1px var(--space-2);
}
.tool-chevron {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  transition: transform var(--dur-base) var(--ease-out);
  flex-shrink: 0;
}
.tool-chevron.open { transform: rotate(90deg); }

.tool-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-base) var(--ease-out);
}
.tool-collapse.open { grid-template-rows: 1fr; }
.tool-collapse-inner { overflow: hidden; min-height: 0; }

.tool-body {
  padding: var(--space-2) var(--space-3) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-x: auto;
}
.tool-result {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--color-text);
}
.tool-card.is-error .tool-result {
  color: var(--color-danger);
  border-color: var(--color-danger);
}
.tool-running-hint {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-2);
}
</style>
