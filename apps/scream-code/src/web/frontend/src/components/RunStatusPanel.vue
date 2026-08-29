<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import type { SessionStatus } from '../types';
import ContextRing from './ContextRing.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  status: SessionStatus;
  busy?: boolean;
  connectionStatus: ConnectionStatus;
}>(), { busy: false });

const STORAGE_KEY = 'scream-panel-runstatus-open';
const open = ref(true);
try {
  open.value = localStorage.getItem(STORAGE_KEY) !== '0';
} catch {
  /* ignore */
}
function toggle() {
  open.value = !open.value;
  try { localStorage.setItem(STORAGE_KEY, open.value ? '1' : '0'); } catch { /* ignore */ }
}

const usagePercent = computed(() => {
  const value = props.status.contextUsage;
  return value === undefined ? null : Math.round((value > 1 ? value / 100 : value) * 100);
});
const tokenTitle = computed(
  () => `Tokens: ${props.status.contextTokens?.toLocaleString() ?? '-'} / ${props.status.maxContextTokens?.toLocaleString() ?? '-'}`,
);
const connectionLabel = computed(() => ({
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  disconnected: '已断开',
  idle: '空闲',
} as Record<ConnectionStatus, string>)[props.connectionStatus] ?? '空闲');

watch(() => props.busy, () => {
  if (props.busy && !open.value) open.value = true;
});
</script>

<template>
  <section :class="['panel-section', 'run-status', { 'is-open': open }]">
    <button class="panel-head" :aria-expanded="open" @click="toggle">
      <span class="head-icon"><SvgIcon name="activity" :size="14" /></span>
      <span class="head-title">运行状态</span>
      <span class="head-hint">{{ busy ? '正在处理会话' : '已就绪，等待任务' }}</span>
      <span class="head-tail">
        <span :class="['head-dot', { busy }]" :title="busy ? 'Agent 正在处理' : '空闲'" />
        <SvgIcon class="chevron" :class="{ rotated: open }" name="chevron-down" :size="14" />
      </span>
    </button>

    <div v-show="open" class="panel-body">
      <dl class="stat-grid">
        <div class="stat">
          <dt>连接</dt>
          <dd>
            <span :class="['conn-dot', connectionStatus]" aria-hidden="true" />
            <span :class="['conn', connectionStatus]">{{ connectionLabel }}</span>
          </dd>
        </div>
        <div class="stat">
          <dt>上下文占用</dt>
          <dd v-if="usagePercent !== null" :title="tokenTitle">
            <ContextRing :usage="status.contextUsage" :size="14" />{{ usagePercent }}%
          </dd>
          <dd v-else class="faint">未知</dd>
        </div>
        <div class="stat wide">
          <dt>Token（输入 / 上限）</dt>
          <dd class="mono">{{ status.contextTokens?.toLocaleString() ?? '-' }} / {{ status.maxContextTokens?.toLocaleString() ?? '-' }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>

<style scoped>
/* Card, header anatomy, stat grid and dots come from the shared global styles. */
.conn.connected { color: var(--color-success); }
.conn.connecting, .conn.reconnecting { color: var(--color-warning); }
.conn.disconnected { color: var(--color-danger); }
.conn-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-text-faint);
}
.conn-dot.connected { background: var(--color-success); }
.conn-dot.connecting, .conn-dot.reconnecting { background: var(--color-warning); }
.conn-dot.disconnected { background: var(--color-danger); }
@media (prefers-reduced-motion: reduce) { .head-dot.busy { animation: none; } }
</style>
