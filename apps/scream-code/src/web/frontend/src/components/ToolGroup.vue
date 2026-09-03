<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolMessage } from '../types';
import { aggregateStatus, type ToolStatus, isEditTool } from '../utils/toolGroup';
import GenericToolCard from './GenericToolCard.vue';
import EditToolCard from './EditToolCard.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(
  defineProps<{ name: string; tools: ToolMessage[]; live?: boolean; workDir?: string; sessionId?: string }>(),
  { live: true, workDir: '', sessionId: '' },
);
/**
 * The fold is user-driven only. Auto-expanding on `running` turned every agent
 * turn into a wall of cards; the live state is carried by the status dot and
 * the meta line inside this same 32px row instead.
 */
const open = ref(false);
const status = computed<ToolStatus>(() => aggregateStatus(props.tools, props.live));
const completedCount = computed(() => props.tools.filter((tool) => tool.output !== undefined && !tool.isError).length);
const summary = computed(() => {
  if (status.value === 'running') return '执行中';
  if (status.value === 'error') return '含失败调用';
  if (status.value === 'suspended') return '含挂起等待';
  if (status.value === 'unknown') return '结果未持久化';
  return `已完成 ${completedCount.value} 项`;
});
function toggle() { open.value = !open.value; }
</script>

<template>
  <section :class="['tool-process', { open, running: status === 'running', error: status === 'error' }]">
    <button class="process-head" type="button" :aria-expanded="open" @click="toggle">
      <SvgIcon name="chevron-down" :size="12" class="chevron" />
      <span :class="['process-dot', status]" aria-hidden="true" />
      <span class="process-label">{{ name }}</span>
      <span class="process-meta">{{ summary }} · {{ tools.length }} 步</span>
      <span class="process-names" :title="tools.map((tool) => tool.name).join('、')">
        {{ tools.map((tool) => tool.name).join(' · ') }}
      </span>
    </button>
    <div class="process-collapse">
      <div class="process-inner">
        <component
          :is="isEditTool(tool.name) ? EditToolCard : GenericToolCard"
          v-for="tool in props.tools"
          :key="tool.toolCallId"
          :tool="tool"
          :live="live"
          :work-dir="workDir"
          :session-id="sessionId"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Collapsed = one 32px text row with no box. The border only appears when
   expanded, so a fold never reads as a card nested inside another card. */
.tool-process {
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  animation: rise-in var(--dur-msg-assistant) var(--ease-out) both;
  transition:
    border-color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out);
}
.tool-process.open {
  border-color: var(--color-line);
  background: var(--color-surface);
}
.tool-process.error.open {
  border-color: color-mix(in srgb, var(--color-danger) 42%, var(--color-line));
}
.process-head {
  width: 100%;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--space-2);
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.process-head:hover { background: var(--color-hover); color: var(--color-text); }
.process-head:active { background: var(--color-selected); }
.process-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--color-text-faint);
}
.process-dot.ok { background: var(--color-success); }
.process-dot.error { background: var(--color-danger); }
.process-dot.unknown { background: var(--color-line-strong); }
.process-dot.suspended { background: var(--color-warning); }
.process-dot.running {
  background: var(--color-accent);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
}
.process-label { flex-shrink: 0; font-weight: 600; color: var(--color-text); }
.process-meta { flex-shrink: 0; color: var(--color-text-faint); }
.process-names {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}
.chevron {
  flex-shrink: 0;
  color: var(--color-text-faint);
  transform: rotate(-90deg);
  transition: transform var(--dur-base) var(--ease-out);
}
.open .chevron { transform: none; }
.process-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-base) var(--ease-out);
}
.open .process-collapse { grid-template-rows: 1fr; }
.process-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 var(--space-2);
}
.open .process-inner {
  padding-top: var(--space-2);
  padding-bottom: var(--space-2);
  border-top: 1px solid var(--color-line);
}
@media (prefers-reduced-motion: reduce) {
  .tool-process { animation: none; }
  .process-dot.running { animation: none; }
}
@media (max-width: 640px) {
  .process-names { display: none; }
}
</style>
