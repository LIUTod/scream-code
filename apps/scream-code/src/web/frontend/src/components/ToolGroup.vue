<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ToolMessage } from '../types';
import { aggregateStatus, type ToolStatus, isEditTool } from '../utils/toolGroup';
import GenericToolCard from './GenericToolCard.vue';
import EditToolCard from './EditToolCard.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{ name: string; tools: ToolMessage[] }>();
const open = ref(false);
const userToggled = ref(false);
const status = computed<ToolStatus>(() => aggregateStatus(props.tools));
const completedCount = computed(() => props.tools.filter((tool) => tool.output !== undefined && !tool.isError).length);
watch(status, (value) => {
  if (!userToggled.value && value === 'running') open.value = true;
}, { immediate: true });
function toggle() { userToggled.value = true; open.value = !open.value; }
</script>

<template>
  <section :class="['tool-process', { open, error: status === 'error' }]">
    <button class="process-head" type="button" :aria-expanded="open" @click="toggle">
      <span :class="['process-icon', status]"><SvgIcon :name="status === 'ok' ? 'check' : 'terminal'" :size="18" /></span>
      <span class="process-copy">
        <strong>工具调用过程</strong>
        <small>{{ status === 'running' ? '正在执行' : status === 'error' ? '包含失败调用' : `已完成 ${completedCount} 项` }}</small>
      </span>
      <span class="tool-names" :title="tools.map((tool) => tool.name).join('、')">{{ tools.map((tool) => tool.name).join(' · ') }}</span>
      <span class="count">{{ tools.length }}</span>
      <SvgIcon name="chevron-down" :size="17" class="chevron" />
    </button>
    <div class="process-collapse">
      <div class="process-inner">
        <component :is="isEditTool(tool.name) ? EditToolCard : GenericToolCard" v-for="tool in tools" :key="tool.toolCallId" :tool="tool" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.tool-process { overflow:hidden; border:1px solid var(--color-line); border-radius:13px; background:var(--color-surface); box-shadow:0 2px 8px rgba(20,35,24,.025); }
.tool-process.error { border-color:color-mix(in srgb,var(--color-danger) 42%,var(--color-line)); }
.process-head { width:100%; min-height:58px; display:flex; align-items:center; gap:11px; padding:10px 13px; border:0; background:var(--color-surface); color:var(--color-text); text-align:left; cursor:pointer; }
.process-head:hover { background:var(--color-hover); }
.process-icon { width:34px; height:34px; display:grid; place-items:center; flex-shrink:0; border-radius:9px; color:var(--color-accent); background:var(--color-accent-soft); }
.process-icon.error { color:var(--color-danger); background:var(--color-danger-soft); }
.process-icon.running { animation:pulse 1.2s infinite; }
.process-copy { display:flex; flex-direction:column; flex-shrink:0; }
.process-copy strong { font-size:12px; }
.process-copy small { margin-top:3px; color:var(--color-text-faint); font-size:10px; }
.tool-names { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--color-text-muted); font:10px var(--font-mono); text-align:right; }
.count { min-width:22px; height:22px; display:grid; place-items:center; border-radius:11px; color:var(--color-accent); background:var(--color-accent-soft); font-size:10px; }
.chevron { color:var(--color-text-faint); transition:transform var(--dur-base) var(--ease-out); }
.open .chevron { transform:rotate(180deg); }
.process-collapse { display:grid; grid-template-rows:0fr; transition:grid-template-rows var(--dur-base) var(--ease-out); }
.open .process-collapse { grid-template-rows:1fr; }
.process-inner { min-height:0; overflow:hidden; display:flex; flex-direction:column; gap:8px; padding:0 10px; background:var(--color-surface-sunken); }
.open .process-inner { padding-top:10px; padding-bottom:10px; border-top:1px solid var(--color-line); }
@keyframes pulse { 50% { opacity:.35; } }
@media (max-width:640px) { .tool-names { display:none; } .process-head { padding:9px 10px; } }
</style>
