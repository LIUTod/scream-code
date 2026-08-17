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

watch(() => props.busy, () => {
  if (props.busy && !open.value) open.value = true;
});
</script>

<template>
  <section class="panel-section run-status">
    <button class="panel-head" :aria-expanded="open" @click="toggle">
      <span class="head-icon"><SvgIcon name="activity" :size="16" /></span>
      <span class="head-title">运行状态</span>
      <span v-if="busy" class="live-dot" title="Agent 正在处理" />
      <SvgIcon class="chevron" :class="{ rotated: open }" name="chevron-down" :size="16" />
    </button>

    <div v-show="open" class="panel-body">
      <div class="status-row">
        <span class="pulse" :class="{ busy }" />
        <span class="status-label">{{ busy ? '正在处理会话' : '已就绪，等待任务' }}</span>
      </div>

      <div class="status-row">
        <span class="row-label">连接</span>
        <span class="row-value" :class="['conn', connectionStatus]">
          {{ connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中' : connectionStatus === 'reconnecting' ? '重连中' : connectionStatus === 'disconnected' ? '已断开' : '空闲' }}
        </span>
      </div>

      <div class="status-row">
        <span class="row-label">上下文</span>
        <span v-if="usagePercent !== null" class="row-value" :title="tokenTitle">
          <ContextRing :usage="status.contextUsage" :size="16" />{{ usagePercent }}%
        </span>
        <span v-else class="row-value faint">—</span>
      </div>
      <div class="status-row">
        <span class="row-label">Token</span>
        <span class="row-value faint">{{ status.contextTokens?.toLocaleString() ?? '-' }} / {{ status.maxContextTokens?.toLocaleString() ?? '-' }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel-section {
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: 14px;
  background: var(--color-surface);
  box-shadow: 0 2px 8px rgba(20, 35, 24, 0.03);
}
.panel-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.panel-head:hover { background: var(--color-surface-sunken); }
.head-icon { display: grid; place-items: center; color: var(--color-accent); }
.head-title { flex: 1; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent); animation: pulse 1.2s infinite; }
.chevron { color: var(--color-text-faint); transition: transform 160ms var(--ease-out); }
.chevron.rotated { transform: rotate(180deg); }
.panel-body { padding: 0 14px 13px; display: flex; flex-direction: column; gap: 9px; }
.status-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-text-muted); }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--color-success); }
.pulse.busy { background: var(--color-accent); animation: pulse 1.2s infinite; }
.status-label { color: var(--color-text); }
.row-label { width: 52px; color: var(--color-text-faint); }
.row-value { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.row-value.conn.connected { color: var(--color-success); }
.row-value.conn.connecting, .row-value.conn.reconnecting { color: var(--color-warning); }
.row-value.conn.disconnected { color: var(--color-danger); }
.faint { color: var(--color-text-faint); }
@keyframes pulse { 50% { opacity: 0.3; } }
</style>
