<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import type { Ref } from 'vue';
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import type { GitStatus, SessionStatus } from '../types';
import type { Theme } from '../theme';
import ContextRing from './ContextRing.vue';
import Dialog from './ui/Dialog.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  connectionStatus: ConnectionStatus;
  status: SessionStatus;
  busy?: boolean;
  gitStatus?: GitStatus | null;
}>(), { busy: false, gitStatus: null });

const emit = defineEmits<{
  (e: 'refresh-git'): void;
  (e: 'toggle-sidebar'): void;
  (e: 'open-model-picker'): void;
}>();

const theme = inject<Ref<Theme>>('theme', ref('system' as Theme));
const setTheme = inject<(t: Theme) => void>('setTheme', () => {});
const themeOptions: readonly { value: Theme; icon: string; label: string }[] = [
  { value: 'light', icon: 'sun', label: '浅色主题' },
  { value: 'dark', icon: 'moon', label: '深色主题' },
  { value: 'system', icon: 'monitor', label: '跟随系统' },
];
const labels: Record<ConnectionStatus, string> = {
  connecting: '连接中', connected: '已连接', reconnecting: '重连中', disconnected: '已断开',
};
const modelSwitchable = inject<Ref<boolean>>('modelSwitchable', ref(false));
const showDiff = ref(false);
const usagePercent = computed(() => {
  const value = props.status.contextUsage;
  return value === undefined ? null : Math.round((value > 1 ? value / 100 : value) * 100);
});
const tokenTitle = computed(() => `Tokens: ${props.status.contextTokens?.toLocaleString() ?? '-'} / ${props.status.maxContextTokens?.toLocaleString() ?? '-'}`);
const gitSync = computed(() => {
  if (!props.gitStatus) return '';
  return [props.gitStatus.ahead ? `↑${props.gitStatus.ahead}` : '', props.gitStatus.behind ? `↓${props.gitStatus.behind}` : ''].filter(Boolean).join(' ');
});
function toggleDiff() {
  showDiff.value = !showDiff.value;
  if (showDiff.value) emit('refresh-git');
}
</script>

<template>
  <header class="topbar">
    <div class="agent-heading">
      <button class="mobile-menu" aria-label="打开会话列表" title="打开会话列表" @click="emit('toggle-sidebar')">
        <SvgIcon name="menu" />
      </button>
      <span class="agent-mark"><SvgIcon name="bot" :size="22" /></span>
      <div class="agent-copy">
        <strong>Scream Code Agent</strong>
        <span><i :class="{ busy }" />{{ busy ? '正在处理会话' : '已就绪，等待任务' }}</span>
      </div>
    </div>

    <div class="actions">
      <span v-if="status.planMode" class="status-chip"><SvgIcon name="clipboard" :size="16" />计划模式</span>
      <button v-if="gitStatus" class="action-chip git" :title="`分支：${gitStatus.branch ?? 'detached'}，点击查看变更统计`" @click="toggleDiff">
        <SvgIcon name="git-branch" :size="17" />
        <span class="truncate">{{ gitStatus.branch ?? 'detached' }}</span>
        <span v-if="gitSync">{{ gitSync }}</span>
        <span v-if="gitStatus.changed">{{ gitStatus.changed }} 项变更</span>
      </button>
      <button v-if="status.model" class="action-chip model" :disabled="!modelSwitchable" :title="status.model" @click="emit('open-model-picker')">
        <SvgIcon name="brain" :size="17" /><span class="truncate">{{ status.model }}</span>
      </button>
      <span v-if="usagePercent !== null" class="action-chip context" :title="tokenTitle"><ContextRing :usage="status.contextUsage" :size="18" />{{ usagePercent }}%</span>
      <div class="theme-toggle" role="group" aria-label="主题切换">
        <button v-for="option in themeOptions" :key="option.value" :class="{ active: theme === option.value }" :title="option.label" :aria-pressed="theme === option.value" @click="setTheme(option.value)">
          <SvgIcon :name="option.icon" :size="17" />
        </button>
      </div>
      <div :class="['connection', connectionStatus]" :title="labels[connectionStatus]">
        <SvgIcon name="wifi" :size="18" /><span>{{ labels[connectionStatus] }}</span>
      </div>
    </div>

    <Dialog :open="showDiff && !!gitStatus" :title="`${gitStatus?.branch ?? 'detached'} · diff 统计`" @close="showDiff = false">
      <pre v-if="gitStatus?.diffStat" class="diff-body">{{ gitStatus.diffStat }}</pre>
      <div v-else class="diff-empty">工作区干净，没有变更。</div>
    </Dialog>
  </header>
</template>

<style scoped>
.topbar { grid-area: topbar; height: var(--topbar-height); display:flex; align-items:center; justify-content:space-between; gap:24px; padding:0 24px; background:var(--color-surface); border-bottom:1px solid var(--color-line); min-width:0; z-index:var(--z-dock); }
.agent-heading,.actions,.agent-copy span,.action-chip,.connection,.theme-toggle { display:flex; align-items:center; }
.agent-heading { gap:12px; min-width:0; }
.agent-mark { width:38px; height:38px; display:grid; place-items:center; border-radius:12px; color:var(--color-accent); background:var(--color-accent-soft); }
.agent-copy { display:flex; flex-direction:column; min-width:0; }
.agent-copy strong { font-size:15px; letter-spacing:-.01em; }
.agent-copy span { gap:7px; color:var(--color-text-muted); font-size:12px; margin-top:3px; }
.agent-copy i { width:7px; height:7px; border-radius:50%; background:var(--color-success); }
.agent-copy i.busy { animation:pulse 1.2s infinite; }
.actions { justify-content:flex-end; gap:8px; min-width:0; }
.action-chip,.status-chip { height:34px; gap:7px; padding:0 11px; border:1px solid var(--color-line); border-radius:9px; background:var(--color-surface); color:var(--color-text-muted); font-size:12px; white-space:nowrap; }
button.action-chip { cursor:pointer; }
button.action-chip:hover { border-color:var(--color-accent-bd); color:var(--color-accent); background:var(--color-accent-soft); }
button.action-chip:disabled { pointer-events:none; }
.status-chip,.model { color:var(--color-accent); background:var(--color-accent-soft); border-color:var(--color-accent-bd); }
.truncate { max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.theme-toggle { padding:3px; gap:1px; border:1px solid var(--color-line); border-radius:10px; background:var(--color-surface-sunken); }
.theme-toggle button { width:28px; height:28px; display:grid; place-items:center; border:0; border-radius:7px; background:transparent; color:var(--color-text-faint); cursor:pointer; }
.theme-toggle button.active { color:var(--color-accent); background:var(--color-surface); box-shadow:var(--shadow-xs); }
.connection { gap:7px; padding-left:4px; color:var(--color-text-muted); font-size:12px; white-space:nowrap; }
.connection.connected { color:var(--color-success); }
.connection.connecting,.connection.reconnecting { color:var(--color-warning); }
.connection.disconnected { color:var(--color-danger); }
.mobile-menu { display:none; width:36px; height:36px; place-items:center; border:1px solid var(--color-line); border-radius:9px; background:var(--color-surface); color:var(--color-text); }
.diff-body { margin:0; padding:16px; max-height:55vh; overflow:auto; white-space:pre-wrap; font:12px/1.6 var(--font-mono); }
.diff-empty { padding:28px; text-align:center; color:var(--color-text-muted); }
@keyframes pulse { 50% { opacity:.3; } }
@media (max-width:1400px) { .action-chip.git span:last-child,.action-chip.context,.status-chip { display:none; } .truncate { max-width:110px; } }
@media (max-width:900px) { .action-chip.git,.action-chip.model { display:none; } }
@media (max-width:640px) { .topbar { padding:0 14px; height:64px; } .mobile-menu { display:grid; } .agent-mark { display:none; } .agent-copy strong { font-size:14px; } .agent-copy span { display:none; } .connection span,.theme-toggle button:not(.active) { display:none; } .actions { gap:5px; } }
</style>
